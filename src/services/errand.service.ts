// ============================================================================
// ERRAND SERVICE — Курьерийн ӨӨРИЙН барааг (дэлгүүрийн бараа БИШ) өөр
// курьерээр хүргүүлэх хүсэлт. Одоо байгаа хүргэлтийн бүх механизмыг (offer
// broadcast, accept, төлбөрийн хуваарилалт) ДАХИН АШИГЛАНА — зөвхөн:
//   - Авах цэг нь ДЭЛГҮҮР биш, гараар бичсэн хаяг
//   - "Авсан" гэдгийг Staff биш, ХҮСЭЛТ ҮҮСГЭСЭН КУРЬЕР OTP-ээр баталгаажуулна
//   - Төлбөрийг хүсэлт үүсгэсэн КУРЬЕР төлнө (дэлгүүр дундуур, хуучин зан
//     төлөвтэй ЯГ АДИЛ: markOrderPaidManually / QPay нэхэмжлэл ажиллана)
// ============================================================================

import { OrderType, PayStatus, DeliveryAssignStatus, PaymentType, PaymentMethod } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateOrderNumber } from "./order.service";
import { findUnpaidDeliveredErrand, unpaidErrandMessage } from "./errand-guards";
import { planErrandCancellation } from "../lib/errand-cancellation";
import { normalizeMongolianPhone } from "../lib/mongolian-phone";
import { courierStaffLabel } from "../lib/courier-identity";
import { computeCourierPayout } from "../lib/courier-payout";
import { emitToStore, emitToAllCouriers, emitToCourier } from "../realtime/socket";
import { sendPushToCourier } from "../lib/push-notifications";
import { offerDeliveryToAllCouriers } from "./delivery-assignment.service";

export class ErrandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrandError";
  }
}

export interface CreateErrandInput {
  requestingCourierId: string;
  errandDescription: string;
  pickupAddress: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
  deliveryAddress: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  deliveryFee: number; // Хүсэлт үүсгэсэн курьер төлөхөд бэлэн дүн (систем үүнээс хувь тооцно)
  recipientName?: string; // Бараа хүлээн авагчийн нэр (заавал биш)
  recipientPhone: string; // Хүлээн авагчийн утас — ЗААВАЛ (хүргэх курьер холбогдоно)
}

const generateOtp = () => Math.floor(1000 + Math.random() * 9000).toString(); // 4 оронтой

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ErrandError(`${label} талбарыг заавал бөглөнө үү`);
  }
}

/**
 * Курьерийн өөрийн барааны хүсэлтийг ШИНЭ Захиалга (Order) болгож үүсгэнэ.
 * Барааны мөр (OrderItem), харилцагч ШААРДЛАГАГҮЙ — checkout()-той ХОЛБООГҮЙ,
 * учир нь энд ямар ч бүтээгдэхүүн/материал/variation оролцохгүй.
 */
export async function createErrand(input: CreateErrandInput) {
  assertNonEmpty(input.errandDescription, "Юу илгээхээ");
  assertNonEmpty(input.pickupAddress, "Авах хаяг");
  assertNonEmpty(input.deliveryAddress, "Хүргэх хаяг");

  const fee = Number(input.deliveryFee);
  if (!Number.isFinite(fee) || fee <= 0) {
    throw new ErrandError("Хүргэлтийн төлбөрийг зөв (0-ээс их) дүнгээр оруулна уу");
  }
  // ✅ ШИНЭ: Хүлээн авагчийн утас ЗААВАЛ — хүргэх курьер хаяг олох, хүлээн авагчийг дуудахад хэрэгтэй
  const recipientPhone = normalizeMongolianPhone(input.recipientPhone);
  if (!recipientPhone) {
    throw new ErrandError("Хүлээн авагчийн утасны дугаарыг зөв (8 оронтой) оруулна уу");
  }
  const recipientName = typeof input.recipientName === "string" ? input.recipientName.trim() : "";
  if (recipientName.length > 60) {
    throw new ErrandError("Хүлээн авагчийн нэр 60 тэмдэгтээс ихгүй байх ёстой");
  }
  if (input.errandDescription.length > 300) {
    throw new ErrandError("Тайлбар 300 тэмдэгтээс ихгүй байх ёстой");
  }

  const requester = await prisma.courier.findUnique({ where: { id: input.requestingCourierId } });
  if (!requester || !requester.isActive) {
    throw new ErrandError("Хүсэлт үүсгэгч курьер олдсонгүй эсвэл идэвхгүй байна");
  }
  // ✅ ШИНЭ: Өмнөх хүргэгдсэн илгээмжийн төлбөр төлөгдөөгүй бол ДАРУЙ хаана (аюулгүйн сүлжээ)
  const debt = await findUnpaidDeliveredErrand(input.requestingCourierId);
  if (debt) throw new ErrandError(unpaidErrandMessage(debt));

  const order = await prisma.order.create({
    data: {
      orderNumber: generateOrderNumber(OrderType.COURIER_ERRAND),
      orderType: OrderType.COURIER_ERRAND,
      storeId: "default",
      requestingCourierId: input.requestingCourierId,
      errandDescription: input.errandDescription.trim(),
      recipientName: recipientName || null, // ✅ ШИНЭ
      recipientPhone, // ✅ ШИНЭ
      pickupAddress: input.pickupAddress.trim(),
      pickupLatitude: input.pickupLatitude,
      pickupLongitude: input.pickupLongitude,
      deliveryMethod: "DELIVERY", // Илгээмж үргэлж хүргэлттэй байх ёстой
      deliveryAddress: input.deliveryAddress.trim(),
      deliveryLatitude: input.deliveryLatitude,
      deliveryLongitude: input.deliveryLongitude,
      deliveryFee: fee,
      totalAmount: fee, // Бүтээгдэхүүн байхгүй тул нийт дүн = хүргэлтийн төлбөр
      paidAmount: 0,
      paymentStatus: PayStatus.PENDING, // Хүсэлт үүсгэсэн курьер төлөх хэрэгтэй (QPay/Staff гараар)
      pickupOtp: generateOtp(), // Хүргэх курьер БАРАА АВАХДАА хүсэлт үүсгэгчээс асууна
      deliveryOtp: generateOtp(), // Хүргэх курьер ХҮЛЭЭН АВАГЧААС асууна (ердийн захиалгатай адил)
    },
  });

  return order;
}

/**
 * Хүргэх курьер БАРАА АВАХ үедээ (ASSIGNED → PICKED_UP) хүсэлт үүсгэсэн
 * курьерээс OTP асууж баталгаажуулна — Staff-ийн "Дэлгүүрээс авсан" товчны
 * ОРОНД (COURIER_ERRAND-д Staff дунд байхгүй тул).
 */
export interface PickupLocation {
  latitude: number;
  longitude: number;
}

const LOCATION_REQUIRED_MESSAGE =
  "Байршил тодорхойгүй байна — илгээмжийг авснаас хойш байршил ЗААВАЛ асаалттай байх ёстой. Утасныхаа байршлыг (GPS) асааж, апп-д байршлын зөвшөөрөл өгнө үү";

/** Координатыг шалгана. GPS унтраалттай/зөвшөөрөлгүй үед апп координат илгээж чадахгүй тул "авсан" болгохыг хориглоно. */
export function parsePickupLocation(raw: unknown): PickupLocation {
  const r = (raw ?? {}) as { latitude?: unknown; longitude?: unknown };
  const toNum = (v: unknown): number => (typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : typeof v === "number" ? v : NaN);
  const lat = toNum(r.latitude);
  const lng = toNum(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ErrandError(LOCATION_REQUIRED_MESSAGE);
  }
  // (0, 0) — GPS-гүй/алдаатай төхөөрөмжийн хуурамч утга ("Null Island")
  if (lat === 0 && lng === 0) throw new ErrandError(LOCATION_REQUIRED_MESSAGE);
  return { latitude: lat, longitude: lng };
}

export async function confirmErrandPickedUp(orderId: string, fulfillingCourierId: string, otp: string, location?: unknown) {
  const loc = parsePickupLocation(location); // ✅ ШИНЭ — байршилгүйгээр "авсан" болохгүй
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ErrandError("Захиалга олдсонгүй");
  // Курьерийн илгээмж БОЛОН худалдагчийн захиалга (худалдагчаас авсан код + GPS) хоёуланд ашиглагдана
  if (order.orderType !== OrderType.COURIER_ERRAND && !order.sellerId) {
    throw new ErrandError("Энэ функц зөвхөн курьерийн илгээмж эсвэл худалдагчийн захиалгад зориулагдсан");
  }
  if (order.courierId !== fulfillingCourierId) {
    throw new ErrandError("Энэ хүргэлтийг танд оноогоогүй байна");
  }
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.ASSIGNED) {
    throw new ErrandError(`Захиалга "${order.deliveryAssignStatus}" төлөвт байгаа тул авах боломжгүй`);
  }
  if (order.pickupOtp !== otp) {
    throw new ErrandError("Баталгаажуулах код буруу байна");
  }

  const now = new Date();
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      deliveryAssignStatus: DeliveryAssignStatus.PICKED_UP,
      pickedUpAt: now,
      pickupConfirmLatitude: loc.latitude, // Авсан мөчийн байршил (маргааны баталгаа)
      pickupConfirmLongitude: loc.longitude,
      locationAlertSentAt: null,
    },
  });
  // Курьерийн сүүлийн байршлыг шинэчилнэ — байршил тасрах хяналтын (watcher) суурь цаг болно
  await prisma.courier
    .update({ where: { id: fulfillingCourierId }, data: { currentLatitude: loc.latitude, currentLongitude: loc.longitude, currentLocationUpdatedAt: now } })
    .catch((e) => console.error("Курьерийн байршил шинэчлэхэд алдаа гарлаа:", e));
  return updated;
}

// ============================================================================
// ЦУЦЛАЛТ / ЧӨЛӨӨЛӨЛТ / БУЦААЛТ ("Урьдчилж төлөх" загварын мөнгө гацахаас сэргийлэлт)
// ============================================================================
const DEFAULT_CANCEL_FEE_PERCENT = 20;

/**
 * Илгээгч курьер өөрийн илгээмжийг цуцална. Дүрмийг planErrandCancellation
 * (цэвэр функц) тодорхойлно. Төлөв өөрчлөлтийг ТОДОРХОЙ төлөвөөс л (atomic
 * updateMany) хийдэг тул цуцлах мөчид өөр курьер Accept хийвэл буруу хураамж
 * тооцогдохгүй — "төлөв дөнгөж өөрчлөгдлөө" гэж алдаа өгнө.
 */
export async function cancelErrand(orderId: string, requestingCourierId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { requestingCourier: { select: { name: true, nickname: true, phone: true } } },
  });
  if (!order || order.orderType !== OrderType.COURIER_ERRAND) throw new ErrandError("Илгээмж олдсонгүй");
  if (order.requestingCourierId !== requestingCourierId) {
    throw new ErrandError("Энэ илгээмжийг зөвхөн илгээгч нь цуцлах боломжтой");
  }

  const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const plan = planErrandCancellation(
    {
      deliveryAssignStatus: order.deliveryAssignStatus,
      paymentStatus: order.paymentStatus,
      paidAmount: Number(order.paidAmount),
      deliveryFee: Number(order.deliveryFee),
    },
    settings?.errandCancelFeePercent ?? DEFAULT_CANCEL_FEE_PERCENT
  );
  if (!plan.allowed) throw new ErrandError(plan.reason ?? "Цуцлах боломжгүй");

  const data: Record<string, unknown> = {
    deliveryAssignStatus: DeliveryAssignStatus.CANCELLED,
    cancelledAt: new Date(),
    cancelReason: "Илгээгч цуцалсан",
  };
  if (plan.branch === "UNPAID") data.paymentStatus = PayStatus.CANCELLED;
  if (plan.refund > 0) data.refundDueAmount = plan.refund;
  if (plan.branch === "ASSIGNED_FEE") {
    data.cancellationFee = plan.fee;
    data.deliveryFee = plan.fee; // Хүргэх курьерийн орлогын тооцоо (хувь хассан) энэ дүнгээс гарна
  }

  const result = await prisma.order.updateMany({
    where: { id: orderId, deliveryAssignStatus: order.deliveryAssignStatus },
    data: data as any,
  });
  if (result.count === 0) {
    throw new ErrandError("Илгээмжийн төлөв дөнгөж өөрчлөгдлөө (жишээ нь курьер авлаа) — дахин оролдоно уу");
  }

  // ---- Мэдэгдлүүд (алдаа гарсан ч цуцлалт хүчинтэй хэвээр) ----
  try {
    if (order.deliveryAssignStatus !== DeliveryAssignStatus.ASSIGNED) {
      emitToAllCouriers("delivery_taken", { orderId }); // Бусад курьерийн "Боломжит" жагсаалтаас шууд арилна
    }
    if (plan.branch === "ASSIGNED_FEE" && order.courierId) {
      const payout = computeCourierPayout(
        { deliveryFee: plan.fee, serviceAmount: 0 },
        settings?.courierCommissionPercent ?? 15,
        settings?.serviceCommissionPercent
      );
      emitToCourier(order.courierId, "delivery_cancelled_for_you", { orderId, orderNumber: order.orderNumber, compensation: payout.totalPayout });
      await sendPushToCourier(
        order.courierId,
        "❌ Илгээмж цуцлагдлаа",
        `#${order.orderNumber} — илгээгч цуцаллаа.${payout.totalPayout > 0 ? ` Танд ${payout.totalPayout}₮ нөхөн олговор олгогдоно.` : ""}`,
        { orderId }
      );
    }
    if (plan.refund > 0) {
      emitToStore(order.storeId, "errand_refund_due", {
        orderId,
        orderNumber: order.orderNumber,
        amount: plan.refund,
        requesterName: order.requestingCourier ? courierStaffLabel(order.requestingCourier) : "Курьер",
        requesterPhone: order.requestingCourier?.phone ?? null,
      });
    }
  } catch (err) {
    console.error("Цуцлалтын мэдэгдэл илгээхэд алдаа гарлаа (цуцлалт хүчинтэй):", err);
  }

  return plan;
}

/**
 * Accept хийсэн курьер бараа АВАХААС ӨМНӨ "хүргэж чадахгүй" гэж чөлөөлөгдөнө.
 * Илгээмж сан руу буцаж, ТЭР курьерээс бусдад дахин санал болно — илгээгч
 * (төлбөр төлсөн) курьерийн алдаанаас болж хураамж төлж цуцлахгүй байхын тулд.
 */
export async function releaseErrand(orderId: string, courierId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.orderType !== OrderType.COURIER_ERRAND) throw new ErrandError("Илгээмж олдсонгүй");
  if (order.courierId !== courierId) throw new ErrandError("Энэ хүргэлтийг танд оноогоогүй байна");
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.ASSIGNED) {
    throw new ErrandError("Бараа аль хэдийн авагдсан тул чөлөөлөгдөх боломжгүй — Staff-тай холбогдоно уу");
  }

  const result = await prisma.order.updateMany({
    where: { id: orderId, courierId, deliveryAssignStatus: DeliveryAssignStatus.ASSIGNED },
    data: { courierId: null, deliveryAssignStatus: DeliveryAssignStatus.UNASSIGNED, deliveryAcceptedAt: null },
  });
  if (result.count === 0) throw new ErrandError("Илгээмжийн төлөв өөрчлөгдсөн байна — дахин оролдоно уу");

  await prisma.deliveryOfferResponse
    .upsert({
      where: { orderId_courierId: { orderId, courierId } },
      update: { response: "RELEASED", respondedAt: new Date() },
      create: { orderId, courierId, response: "RELEASED" },
    })
    .catch((e) => console.error("Чөлөөлөлт бүртгэхэд алдаа гарлаа:", e));

  try {
    if (order.requestingCourierId) {
      emitToCourier(order.requestingCourierId, "errand_courier_released", { orderId, orderNumber: order.orderNumber });
      await sendPushToCourier(order.requestingCourierId, "🔄 Шинэ курьер хайж байна", `#${order.orderNumber} — өмнөх курьер хүргэж чадахгүй боллоо, бусад курьерт дахин санал болголоо`, { orderId });
    }
    await offerDeliveryToAllCouriers(orderId, [courierId]); // Чөлөөлөгдсөн курьерт дахин явуулахгүй
  } catch (err) {
    console.error("Чөлөөлсний дараа дахин санал болгоход алдаа гарлаа (Staff гараар санал болгож болно):", err);
  }
}

const MANUAL_REFUND_METHODS = ["CASH", "BANK_TRANSFER"];

/**
 * Staff мөнгийг ГАРААР (бэлнээр эсвэл дансаар) буцааж дууссаны дараа НЭГ товчоор
 * бүртгэнэ: журналд ERRAND_REFUND мөр нэмж, захиалгыг буцаасан гэж тэмдэглэнэ.
 * Давхар дарахаас (хоёр Staff зэрэг) сэргийлж updateMany-ийн нөхцөлөөр хамгаална.
 */
export async function completeErrandRefund(orderId: string, method: string, note?: string) {
  if (!MANUAL_REFUND_METHODS.includes(method)) {
    throw new ErrandError("Буцаалтын аргыг бэлэн мөнгө эсвэл данс гэж сонгоно уу");
  }
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.orderType !== OrderType.COURIER_ERRAND) throw new ErrandError("Илгээмж олдсонгүй");
  const amount = Number(order.refundDueAmount);
  if (!(amount > 0) || order.refundedAt) throw new ErrandError("Буцаах дүн байхгүй эсвэл аль хэдийн буцаасан байна");

  const feeKept = Number(order.cancellationFee) > 0; // Хураамж үлдсэн бол захиалга "PAID" хэвээр (дэлгүүр хураамжийг олсон)
  await prisma.$transaction(async (tx) => {
    const marked = await tx.order.updateMany({
      where: { id: orderId, refundedAt: null, refundDueAmount: { gt: 0 } },
      data: { refundDueAmount: 0, refundedAt: new Date(), ...(feeKept ? {} : { paymentStatus: PayStatus.REFUNDED }) },
    });
    if (marked.count === 0) throw new ErrandError("Буцаах дүн байхгүй эсвэл аль хэдийн буцаасан байна");
    await tx.payment.create({
      data: { orderId, type: PaymentType.ERRAND_REFUND, method: method as PaymentMethod, amount, note: note?.trim() || null },
    });
  });
  return amount;
}
