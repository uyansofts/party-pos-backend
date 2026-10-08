// ============================================================================
// DELIVERY ASSIGNMENT SERVICE — Хүргэлтийг хүргэгчдэд broadcast хийх,
// Accept дарахад RACE CONDITION-оос хамгаалж АТОМИКААР оноох, Staff
// гараар оноох 3 гол үйлдлийг агуулна.
// ============================================================================

import { DeliveryAssignStatus, OrderType, PayStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emitToStore, emitToAllCouriers, emitToCourier } from "../realtime/socket";
import { sendPushToAllCouriers, sendPushToCourier } from "../lib/push-notifications";
import { processReturn } from "./deposit.service";
import { computeCourierPayout } from "../lib/courier-payout";
import { findUnpaidDeliveredErrand, unpaidErrandMessage } from "./errand-guards";
import { courierDisplayName, courierStaffLabel } from "../lib/courier-identity";
import { normalizeNightSettings, isNightNow, nightHoldMessage } from "../lib/night-hours";


export class DeliveryAssignmentError extends Error {}

/**
 * Захиалгыг БҮХ идэвхтэй хүргэгчид "санал болгоно" (broadcast) —
 * Socket.io (апп нээлттэй үед шууд) БОЛОН FCM push (апп хаалттай ч)
 * хоёуланг ашиглана.
 */
/**
 * ✅ ШИНЭ: Шөнийн цагт (Тохиргоонд: анхдагч 22:00–08:00, УБ цаг) ДЭЛГҮҮРИЙН хүргэлтийг гаргахгүй —
 * шөнө дэлгүүрт ажилтан байхгүй, бараа гардуулах хүн алга. Курьерийн илгээмж (COURIER_ERRAND) шөнө ч явна.
 */
function assertSellerOrderReadyForCourier(o: { sellerId?: string | null; sellerStatus?: string | null; paymentStatus?: string | null }) {
  if (!o.sellerId) return;
  if (o.paymentStatus !== PayStatus.PAID || o.sellerStatus !== "READY") {
    throw new DeliveryAssignmentError("Худалдагчийн захиалга — төлбөр бүрэн орж, худалдагч \"Бэлэн\" болгосны дараа л курьерт гаргана");
  }
}

async function assertShopDeliveryAllowedNow(orderType: string) {
  if (orderType === OrderType.COURIER_ERRAND) return;
  const row = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const night = normalizeNightSettings(row);
  if (isNightNow(night)) throw new DeliveryAssignmentError(nightHoldMessage(night));
}

export async function offerDeliveryToAllCouriers(orderId: string, exceptCourierIds: string[] = []) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true, rentalDetail: true } }, requestingCourier: { select: { name: true, nickname: true } }, seller: { select: { name: true } } }, // ✅ ШИНЭ
  });

  // ✅ ШИНЭ (Uber шиг УРЬДЧИЛЖ ТӨЛӨХ): Курьерийн илгээмж ТӨЛӨГДӨӨГҮЙ бол курьерт
  // санал болгохгүй — Staff гараар оролдсон ч энд хаагдана.
  if (order.orderType === OrderType.COURIER_ERRAND && order.paymentStatus !== PayStatus.PAID) {
    throw new DeliveryAssignmentError("Илгээмжийн төлбөр төлөгдөөгүй тул курьерт санал болгох боломжгүй — эхлээд төлбөр баталгаажуулна уу");
  }

  // ✅ ШИНЭ (marketplace): Худалдагчийн захиалгыг ЗӨВХӨН төлбөр бүрэн орсон, худалдагч "Бэлэн" болгосны дараа л курьерт гаргана
  assertSellerOrderReadyForCourier(order);

  await assertShopDeliveryAllowedNow(order.orderType); // ✅ ШИНЭ — шөнө дэлгүүрийн хүргэлт гаргахгүй (төлөв өөрчлөгдөхөөс ӨМНӨ)

  await prisma.order.update({
    where: { id: orderId },
    data: { deliveryAssignStatus: DeliveryAssignStatus.OFFERED, deliveryOfferedAt: new Date() },
  });

  // ✅ ШИНЭ: Дэлгүүрийн тохиргоонд байгаа хувийг хассан, хүргэгчид олгох
  // ЦЭВЭР дүнг тооцно.
  const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  // ✅ ШИНЭ: Хүргэлт + чимэглэлийн ажлын төлбөрөөс дэлгүүрийн хувийг хассан курьерт очих ЦЭВЭР дүн
  const payout = computeCourierPayout(
    { deliveryFee: Number(order.deliveryFee), serviceAmount: Number(order.serviceAmount ?? 0) },
    settings?.courierCommissionPercent ?? 15,
    settings?.serviceCommissionPercent
  );
  const hasService = Number(order.serviceAmount ?? 0) > 0 || !!order.serviceLabel;

  // ✅ ШИНЭ: Түрээсийн мөр байвал өгөх/авах (эхлэх/дуусах) огноог тооцно —
  // хэд хэдэн түрээсийн мөр байвал хамгийн эрт эхлэх, хамгийн сүүлд
  // дуусах огноог авна (нэг захиалгад ихэвчлэн ижил хугацаа байдаг).
  const rentalItems = order.items.filter((i) => i.rentalDetail);
  const rentalStartDate =
    rentalItems.length > 0
      ? rentalItems.reduce((min, i) => (i.rentalDetail!.startDate < min ? i.rentalDetail!.startDate : min), rentalItems[0].rentalDetail!.startDate)
      : null;
  const rentalEndDate =
    rentalItems.length > 0
      ? rentalItems.reduce((max, i) => (i.rentalDetail!.endDate > max ? i.rentalDetail!.endDate : max), rentalItems[0].rentalDetail!.endDate)
      : null;

  const isErrand = order.orderType === "COURIER_ERRAND"; // ✅ ШИНЭ
  const isSellerOrder = !!order.sellerId; // ✅ ШИНЭ (marketplace) — худалдагчийн хаягаас очиж авна

  const payload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    // ✅ ШИНЭ: Курьерийн ӨӨРИЙН илгээмжид хэрэглэгчийн нэрийн оронд хүсэлт
    // үүсгэсэн курьерийн нэр, тайлбар, авах хаяг харагдана.
    // Курьерүүд бие биедээ ЗӨВХӨН nickname-ээр харагдана (жинхэнэ нэр нууц)
    customerName: isErrand ? (order.requestingCourier ? courierDisplayName(order.requestingCourier) : "Курьер") : order.customer?.name ?? "Танихгүй",
    customerPhone: order.customer?.phone ?? null,
    deliveryAddress: order.deliveryAddress,
    isErrand, // ✅ ШИНЭ — Курьер апп-д "📦 Хувийн илгээмж" тэмдэг харуулахад
    errandDescription: isErrand ? order.errandDescription : null, // ✅ ШИНЭ
    pickupAddress: isErrand || isSellerOrder ? order.pickupAddress : null, // ✅ ШИНЭ
    // ✅ ШИНЭ (marketplace): Авах цэг — худалдагчийн нэр, хаяг, координат; авахдаа худалдагчаас КОД асууна
    pickupLabel: isSellerOrder ? `Худалдагч: ${order.seller?.name ?? ""}`.trim() : isErrand ? "Авах цэг" : "Дэлгүүр",
    pickupLatitude: isSellerOrder ? order.pickupLatitude : null,
    pickupLongitude: isSellerOrder ? order.pickupLongitude : null,
    requiresPickupCode: isErrand || isSellerOrder,
    courierPayout: payout.totalPayout, // ✅ ЗАСВАР — курьерт ЦЭВЭР нийт дүнг л илгээнэ (deliveryFee биш)
    deliveryPayout: payout.deliveryPayout, // ✅ ШИНЭ — хүргэлтийн хэсэг
    servicePayout: payout.servicePayout, // ✅ ШИНЭ — чимэглэлийн ажлын хэсэг
    serviceLabel: hasService ? order.serviceLabel ?? "Нэмэлт ажил" : null, // ✅ ШИНЭ — "🎈 чимэглэлтэй" тэмдэг
    deliveryLatitude: order.deliveryLatitude, // ✅ ШИНЭ — Accept/Ignore-оос өмнө байршлыг харах
    deliveryLongitude: order.deliveryLongitude,
    itemCount: order.items.length,
    // ✅ ЗАСВАР: Барааны НЭР биш, зөвхөн ОВОР ХЭМЖЭЭ (Staff тохируулсан) —
    // сонгоогүй/хуучин өгөгдөл null бол "Жижиг" гэж тооцно (default).
    packageSize: order.packageSize || "SMALL",
    // ✅ ШИНЭ: Түрээс бол өгөх/авах огноо
    isRental: rentalItems.length > 0,
    rentalStartDate,
    rentalEndDate,
  };

  // ✅ ШИНЭ: Илгээгч (өөрийн илгээмж) болон чөлөөлөгдсөн курьерт (exceptCourierIds) санал явуулахгүй
  // Өмнө нь чөлөөлөгдсөн / илгээгчийн солисон курьерт (хэзээ ч авч чадахгүй) дахин санал явуулахгүй
  const blocked = await prisma.deliveryOfferResponse.findMany({
    where: { orderId, response: { in: ["RELEASED", "REJECTED_BY_REQUESTER"] as any } },
    select: { courierId: true },
  });
  const exceptList = Array.from(
    new Set([order.requestingCourierId, ...exceptCourierIds, ...blocked.map((b) => b.courierId)].filter((id): id is string => !!id))
  );
  emitToAllCouriers("delivery_available", payload, exceptList.length > 0 ? exceptList : undefined);
  await sendPushToAllCouriers(
    isErrand ? "📦 Курьерийн илгээмж" : hasService ? "🚚 Шинэ хүргэлт · 🎈 чимэглэлтэй" : "🚚 Шинэ хүргэлт",
    isErrand
      ? `#${order.orderNumber} — ${order.pickupAddress ?? "Авах хаяг тодорхойгүй"} → ${order.deliveryAddress || "Хаяг тодорхойгүй"} — ${payout.totalPayout}₮`
      : `#${order.orderNumber} — ${order.deliveryAddress || "Хаяг тодорхойгүй"}${hasService ? ` — ${payout.totalPayout}₮` : ""}`,
    { orderId: order.id },
    exceptList.length > 0 ? exceptList : undefined // ✅ ШИНЭ — илгээгч/чөлөөлөгдсөн курьерт push явуулахгүй
  );
}

/**
 * Хүргэгч "Accept" дарахад дуудагдана. RACE CONDITION-оос хамгаалахын
 * тулд `updateMany` ашиглаж, WHERE нөхцөлд "ОДООХОН ЗӨВХӨН OFFERED
 * төлөвтэй л бол" гэдгийг шалгана — хэрэв өөр хүргэгч ХЭДЭН МИЛЛИСЕКУНДИЙН
 * зөрүүгээр түрүүлж авсан бол `count === 0` буцаад, 2 дахь хүргэгчид
 * "Аль хэдийн авагдсан" алдаа өгнө.
 */
export async function acceptDelivery(orderId: string, courierId: string) {
  // ✅ ШИНЭ: Урьдчилсан шалгалтууд. (Өөрийн илгээмжийг updateMany-ийн WHERE-д NOT-оор
  // хасахгүй — Prisma/SQL-д NULL requestingCourierId бүхий ЕРДИЙН захиалгыг ч хамт
  // хасчихдаг тул. Илгээгч өөрчлөгддөггүй тул урьдчилсан шалгалт хангалттай.)
  const pre = await prisma.order.findUnique({ where: { id: orderId }, select: { orderType: true, requestingCourierId: true, paymentStatus: true } });
  if (pre?.orderType === OrderType.COURIER_ERRAND) {
    if (pre.requestingCourierId === courierId) {
      throw new DeliveryAssignmentError("Өөрийн илгээмжийг өөрөө хүргэх боломжгүй");
    }
    if (pre.paymentStatus !== PayStatus.PAID) {
      throw new DeliveryAssignmentError("Энэ илгээмжийн төлбөр төлөгдөөгүй байна");
    }
    // ✅ ШИНЭ: Энэ илгээмжээс өмнө "хүргэж чадахгүй" гэж чөлөөлөгдсөн курьер дахин авч болохгүй
    const prior = await prisma.deliveryOfferResponse.findUnique({ where: { orderId_courierId: { orderId, courierId } } });
    if (prior?.response === "RELEASED") {
      throw new DeliveryAssignmentError("Та энэ илгээмжээс өмнө татгалзсан тул дахин авах боломжгүй");
    }
    if (prior?.response === "REJECTED_BY_REQUESTER") {
      throw new DeliveryAssignmentError("Илгээгч таныг энэ илгээмжээс чөлөөлсөн тул дахин авах боломжгүй");
    }
  }
  // ✅ ШИНЭ: Өөрийн хүргэгдсэн илгээмжийн төлбөрийг төлөөгүй курьер шинэ хүргэлт авч болохгүй
  const debt = await findUnpaidDeliveredErrand(courierId);
  if (debt) throw new DeliveryAssignmentError(unpaidErrandMessage(debt));

  const result = await prisma.order.updateMany({
    where: { id: orderId, deliveryAssignStatus: DeliveryAssignStatus.OFFERED },
    data: {
      courierId,
      deliveryAssignStatus: DeliveryAssignStatus.ASSIGNED,
      deliveryAcceptedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new DeliveryAssignmentError("Уучлаарай, энэ хүргэлтийг өөр хүргэгч аль хэдийн авсан байна");
  }

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { courier: true } });

  // ✅ ШИНЭ: "Авсан" хариуг ч мөн лавлагаанд бүртгэнэ (POS дээр хэн авсныг
  // харуулахад ашиглана — "хэн алгассан" бүртгэлтэй ижил хүснэгтэд).
  await prisma.deliveryOfferResponse
    .upsert({
      where: { orderId_courierId: { orderId, courierId } },
      update: { response: "ACCEPTED", respondedAt: new Date() },
      create: { orderId, courierId, response: "ACCEPTED" },
    })
    .catch((e) => console.error("Accept бүртгэхэд алдаа гарлаа:", e));

  // Бусад хүргэгчдэд "энэ захиалга аль хэдийн авагдсан" гэдгийг мэдэгдэж,
  // тэдний жагсаалтаас автоматаар арилгуулна.
  emitToAllCouriers("delivery_taken", { orderId, courierName: order.courier ? courierDisplayName(order.courier) : undefined }); // бусад курьерт — nickname
  // ПОС-т ч мэдэгдэнэ — кассчин хэн хүргэж байгааг шууд харна.
  emitToStore(order.storeId, "delivery_accepted", { orderId, courierName: order.courier ? courierStaffLabel(order.courier) : undefined }); // Staff-д — "Nickname (Жинхэнэ нэр)"

  return order;
}

/**
 * Staff ПОС дээрээс ГАРААР тодорхой хүргэгчид оноодог функц — Accept
 * дуудах шаардлагагүй, шууд ASSIGNED болно (hybrid хуваарилалтын 2-р
 * зам).
 */
export async function assignDeliveryManually(orderId: string, courierId: string) {
  const courier = await prisma.courier.findUnique({ where: { id: courierId } });
  if (!courier || !courier.isActive) {
    throw new DeliveryAssignmentError("Сонгосон хүргэгч идэвхгүй эсвэл олдсонгүй");
  }

  // ✅ ШИНЭ: Staff гараар оноосон ч курьерийн илгээмж ТӨЛӨГДСӨН байх, өөртөө оноогдохгүй байх ёстой
  const target = await prisma.order.findUnique({ where: { id: orderId }, select: { orderType: true, paymentStatus: true, requestingCourierId: true, sellerId: true, sellerStatus: true } });
  if (target) assertSellerOrderReadyForCourier(target); // ✅ ШИНЭ — Staff гараар оноохдоо ч худалдагч "Бэлэн" болгоогүй бол боломжгүй
  if (target?.orderType === OrderType.COURIER_ERRAND) {
    if (target.paymentStatus !== PayStatus.PAID) throw new DeliveryAssignmentError("Илгээмжийн төлбөр төлөгдөөгүй тул курьерт оноох боломжгүй");
    if (target.requestingCourierId === courierId) throw new DeliveryAssignmentError("Илгээмжийг илгээгч курьерт нь оноох боломжгүй");
  }

  if (target) await assertShopDeliveryAllowedNow(target.orderType); // ✅ ШИНЭ — Staff гараар оноохдоо ч шөнө дэлгүүрийн хүргэлт гаргахгүй

  const order = await prisma.order.update({
    where: { id: orderId },
    data: {
      courierId,
      deliveryAssignStatus: DeliveryAssignStatus.ASSIGNED,
      deliveryAcceptedAt: new Date(),
    },
  });

  // ✅ ЗАСВАР: Дутуу байсан — Staff гараар онооход БУСАД курьеруудын
  // "Боломжит хүргэлт" жагсаалтаас энэ захиалгыг АРИЛГАХ шаардлагатай
  // (эс бөгөөс тэд ажиглаад Accept дарж, "аль хэдийн авсан" гэсэн алдаа
  // авах хүртэл л мэдэхгүй байдаг байсан).
  emitToAllCouriers("delivery_taken", { orderId });

  // Тухайн ХҮРГЭГЧИД л чиглэсэн мэдэгдэл (бусдад биш — учир нь Staff аль
  // хэдийн шийдсэн тул өрсөлдөх шаардлагагүй).
  emitToCourier(courierId, "delivery_assigned_to_you", {
    orderId: order.id,
    orderNumber: order.orderNumber,
    deliveryAddress: order.deliveryAddress,
  });
  await sendPushToCourier(courierId, "📦 Танд хүргэлт оноогдлоо", `#${order.orderNumber}`, { orderId: order.id });

  return order;
}

/**
 * ✅ ШИНЭ: Staff POS дээрээс, курьер БОДИТООР дэлгүүрт ирж, барааг
 * гардуулан авсны дараа л дардаг товч. Staff БИЕЧЛЭН харж байгаа тул
 * OTP шаардлагагүй (аюулгүй байдал аль хэдийн хангагдсан — таньдаг хүнд,
 * биечлэн гардуулж байгаа). Үүнийг дараагүй бол курьер "Хүргэсэн/Өгсөн"
 * гэж баталгаажуулах боломжгүй — дараалал ЗААВАЛ мөрдөгдөнө.
 */
export async function markPickedUp(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new DeliveryAssignmentError("Захиалга олдсонгүй");
  // ✅ ШИНЭ: Курьерийн ӨӨРИЙН илгээмжид Staff-ийн товч БИШ, хүсэлт үүсгэсэн
  // курьерийн OTP-ээр л баталгаажина (errand.service.ts-ийн confirmErrandPickedUp).
  if (order.orderType === OrderType.COURIER_ERRAND) {
    throw new DeliveryAssignmentError("Энэ бол курьерийн илгээмж — Staff биш, хүсэлт үүсгэсэн курьер OTP-ээр баталгаажуулна");
  }
  // ✅ ШИНЭ (marketplace): Худалдагчийн барааг Staff биш, курьер худалдагчаас авсан КОД + GPS-ээр баталгаажуулна
  if (order.sellerId) {
    throw new DeliveryAssignmentError("Энэ бол худалдагчийн захиалга — Staff биш, курьер худалдагчаас авсан кодоор баталгаажуулна");
  }
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.ASSIGNED) {
    throw new DeliveryAssignmentError("Энэ захиалга одоогийн төлөвт 'Дэлгүүрээс авсан' гэж тэмдэглэх боломжгүй");
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { deliveryAssignStatus: DeliveryAssignStatus.PICKED_UP, pickedUpAt: new Date() },
  });

  // Курьер апп-д ШУУД мэдэгдэж, "Хүргэсэн" товч идэвхжинэ.
  if (updated.courierId) {
    emitToCourier(updated.courierId, "delivery_picked_up", { orderId: updated.id, orderNumber: updated.orderNumber });
  }
  emitToStore(updated.storeId, "delivery_picked_up", { orderId: updated.id });

  return updated;
}

/**
 * ✅ ЗАСВАР: Хүргэгч зүгээр л товч дарснаар "хүргэсэн" гэж БАТАЛГААЖИХГҮЙ —
 * харилцагчаас ЗААВАЛ 4 оронтой код асууж, ЗӨВ бол л баталгаажна.
 * ----------------------------------------------------------------------------
 * ✅ ШИНЭ: Мөн ЗААВАЛ эхлээд PICKED_UP (Staff-ийн "Дэлгүүрээс авсан"
 * баталгаажуулалт) дамжсан байх ёстой — ASSIGNED төлөвөөс шууд
 * баталгаажуулах боломжгүй болсон (дэс дараалал бүрэн мөрдөгдөнө).
 * ----------------------------------------------------------------------------
 * ТҮРЭЭСИЙН захиалгад 2 алхам:
 *   1) PICKED_UP → GIVEN   (deliveryOtp-оор баталгаажна — "Өгсөн")
 *   2) GIVEN     → DELIVERED (returnOtp-оор баталгаажна — "Буцаан авсан")
 * Энгийн ЗАРАХ захиалгад 1 алхам:
 *   PICKED_UP → DELIVERED (deliveryOtp-оор баталгаажна — "Хүргэсэн")
 */
export async function confirmDeliveryStep(orderId: string, courierId: string, otp: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { rentalDetail: true } } } });
  if (!order) throw new DeliveryAssignmentError("Захиалга олдсонгүй");
  if (order.courierId !== courierId) {
    throw new DeliveryAssignmentError("Энэ захиалга танд оноогдоогүй байна");
  }

  const hasRental = order.items.some((i) => i.rentalDetail);

  if (order.deliveryAssignStatus === DeliveryAssignStatus.ASSIGNED) {
    // ✅ ШИНЭ: Дараалал алгасаж болохгүй — эхлээд Staff "Дэлгүүрээс авсан"
    // гэж баталгаажуулах ёстой.
    throw new DeliveryAssignmentError(
      order.orderType === OrderType.COURIER_ERRAND
        ? 'Эхлээд авах хаягт очиж илгээгчээс барааг аваад "Бараа авсан" товчоор код баталгаажуулна уу'
        : "Эхлээд дэлгүүрт очиж барааг авах ёстой — Staff танд \"Дэлгүүрээс авсан\" гэж тэмдэглэсний дараа л баталгаажуулах боломжтой болно"
    );
  }

  if (order.deliveryAssignStatus === DeliveryAssignStatus.PICKED_UP) {
    // ---- 1-р алхам: Хүргэсэн/Өгсөн (deliveryOtp-оор шалгана) ----
    if (!order.deliveryOtp || otp !== order.deliveryOtp) {
      throw new DeliveryAssignmentError(
        order.orderType === OrderType.COURIER_ERRAND
          ? "Код буруу байна — илгээгч курьерээс хүргэлтийн кодыг дахин асууна уу"
          : "Код буруу байна — харилцагчаас дахин асууна уу"
      );
    }

    const nextStatus = hasRental ? DeliveryAssignStatus.GIVEN : DeliveryAssignStatus.DELIVERED;
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: hasRental
        ? { deliveryAssignStatus: nextStatus, rentalGivenAt: new Date() }
        : { deliveryAssignStatus: nextStatus, deliveredAt: new Date() },
    });

    if (!hasRental) {
      // ✅ ЗАСВАР: Захиалга ЭНЭ Л АЛХАМД (түрээс биш) эцэслэн "Хүргэгдсэн"
      // болсон тул SALE барааг "Олгосон" (isIssued) гэж АВТОМАТААР тэмдэглэнэ.
      await prisma.orderItem.updateMany({
        where: { orderId, itemType: "SALE" },
        data: { isIssued: true, issuedAt: new Date() },
      });
    } else {
      // ✅ ШИНЭ: Түрээсийн барааг харилцагчид ӨГСӨН тул RentalDetail-ийг
      // BOOKED → ACTIVE болгоно (in-store "markAsPickedUp"-тай ижил үр
      // дүн) — эс бөгөөс дараа нь буцаалт (processReturn) хийх боломжгүй
      // болно (тэр функц ACTIVE/OVERDUE шаарддаг).
      for (const item of order.items) {
        if (item.rentalDetail && item.rentalDetail.rentalStatus === "BOOKED") {
          await prisma.rentalDetail.update({
            where: { id: item.rentalDetail.id },
            data: { rentalStatus: "ACTIVE" },
          });
        }
      }
    }

    emitToStore(updated.storeId, hasRental ? "delivery_given" : "delivery_completed", { orderId, courierId });

    // ✅ ШИНЭ: Курьерийн илгээмж хүргэгдлээ (илгээгч курьер кодыг өгсөн) — Staff-д ХҮРГЭСЭН курьерт
    // төлөх дүнтэй хамт мэдэгдэнэ. Шилжүүлгийг Staff ГАРААР хийнэ (Захиалгын дэлгэрэнгүй → Дансаар шилжүүлэх).
    if (order.orderType === OrderType.COURIER_ERRAND) {
      try {
        const [courier, requester, settings] = await Promise.all([
          prisma.courier.findUnique({ where: { id: courierId }, select: { name: true, nickname: true } }),
          order.requestingCourierId ? prisma.courier.findUnique({ where: { id: order.requestingCourierId }, select: { name: true, nickname: true } }) : Promise.resolve(null),
          prisma.shopSettings.findUnique({ where: { id: "default" } }),
        ]);
        const payout = computeCourierPayout({ deliveryFee: Number(order.deliveryFee), serviceAmount: 0 }, settings?.courierCommissionPercent ?? 15, settings?.serviceCommissionPercent);
        emitToStore(updated.storeId, "errand_delivered", {
          orderId,
          orderNumber: order.orderNumber,
          courierName: courier ? courierStaffLabel(courier) : "Курьер",
          requesterName: requester ? courierStaffLabel(requester) : "Курьер",
          payout: payout.totalPayout,
        });
      } catch (err) {
        console.error("Илгээмж хүргэгдсэний мэдэгдэл илгээхэд алдаа гарлаа (хүргэлт бүртгэгдсэн):", err);
      }
    }
    return updated;
  }

  if (order.deliveryAssignStatus === DeliveryAssignStatus.GIVEN) {
    // ---- 2-р алхам (ЗӨВХӨН ТҮРЭЭСТ): Курьер харилцагчаас буцаан авсан
    // (returnOtp-оор шалгана) — гэхдээ энэ бол ЗАМД байгаа гэсэн үг,
    // ДЭЛГҮҮРТ хараахан ирээгүй тул ЭЦСИЙН биш (RETURN_PICKED_UP).
    if (!order.returnOtp || otp !== order.returnOtp) {
      throw new DeliveryAssignmentError("Код буруу байна — харилцагчаас дахин асууна уу");
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { deliveryAssignStatus: DeliveryAssignStatus.RETURN_PICKED_UP, returnPickedUpAt: new Date() },
    });

    emitToStore(updated.storeId, "delivery_return_picked_up", { orderId, courierId });
    return updated;
  }

  throw new DeliveryAssignmentError("Энэ захиалга одоогийн төлөвт баталгаажуулах алхамгүй байна");
}

/**
 * ✅ ШИНЭ: Staff POS дээрээс, курьер ТҮРЭЭСИЙН барааг дэлгүүрт БОДИТООР
 * буцааж авчирсны дараа дардаг товч. Барьцааны мөнгө буцаах/гэмтэл
 * шалгах логикийг (deposit.service.ts-ийн processReturn) ЯГ ижилээр,
 * дэлгүүрт биечлэн буцаасантай АДИЛ ажиллуулна.
 * ----------------------------------------------------------------------------
 * body: { damageFee?: number, damageNote?: string } — нэг захиалгад олон
 * түрээсийн мөр байвал БҮГДЭД адил damageFee/Note ноогдуулна (энгийн
 * тохиолдолд ихэвчлэн 1 мөр байдаг).
 */
export async function confirmReturnedToShop(orderId: string, damageFee: number, damageNote?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { rentalDetail: true } } } });
  if (!order) throw new DeliveryAssignmentError("Захиалга олдсонгүй");
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.RETURN_PICKED_UP) {
    throw new DeliveryAssignmentError("Энэ захиалга одоогийн төлөвт 'Дэлгүүрт буцаж ирлээ' гэж тэмдэглэх боломжгүй");
  }

  const now = new Date();

  // ✅ Тухайн захиалгын БҮХ түрээсийн мөрд processReturn-ийг ажиллуулна —
  // барьцаа буцаалт, хожимдлын торгууль, гэмтлийн төлбөрийг ЯГ дэлгүүрт
  // биечлэн буцаасантай ижил тооцно.
  for (const item of order.items) {
    if (item.rentalDetail && (item.rentalDetail.rentalStatus === "ACTIVE" || item.rentalDetail.rentalStatus === "OVERDUE")) {
      await processReturn(item.rentalDetail.id, { actualReturn: now, damageFee, damageNote });
    }
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { deliveryAssignStatus: DeliveryAssignStatus.DELIVERED, deliveredAt: now },
  });

  emitToStore(updated.storeId, "delivery_completed", { orderId });
  if (updated.courierId) {
    emitToCourier(updated.courierId, "delivery_detail_updated", { orderId }); // Курьерийн "Миний хүргэлт" дэлгэц шинэчлэгдэнэ
  }

  return updated;
}
