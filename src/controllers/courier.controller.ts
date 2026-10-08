// ============================================================================
// COURIER CONTROLLER — 2 хэсэгтэй:
//   1) /api/couriers/*        — Staff (requireAuth) хүргэгчдийг удирдана
//   2) /api/courier/*         — Курьер өөрөө (requireCourierAuth) ашиглана
// ============================================================================

import { Router, Request, Response } from "express";
import { DeliveryAssignStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireCourierAuth } from "../middleware/courier-auth.middleware";
import { hashPin } from "../services/courier-auth.service";
import { toDriveImageUrl } from "../lib/drive-image";
import { emitToStore } from "../realtime/socket";
import { computeCourierPayout } from "../lib/courier-payout";
import {
  offerDeliveryToAllCouriers,
  acceptDelivery,
  assignDeliveryManually,
  confirmDeliveryStep,
  DeliveryAssignmentError,
} from "../services/delivery-assignment.service";
import { createErrand, confirmErrandPickedUp, cancelErrand, releaseErrand, ErrandError } from "../services/errand.service"; // ✅ ШИНЭ
import { planErrandCancellation } from "../lib/errand-cancellation";
import { checkErrandTrackingAccess } from "../lib/live-tracking";
import { fetchLiveSnapshot } from "../services/live-tracking.service";
import { getCourierStats } from "../services/courier-stats.service";
import { rateErrandCourier, rejectAssignedCourier, FeedbackError, MAX_COURIER_SWAPS } from "../services/courier-feedback.service";
import { normalizeNickname, normalizeVehiclePlate, normalizeRegisterNumber, validateDepositHold, courierDisplayName, courierStaffLabel, buildPublicProfile } from "../lib/courier-identity";
import { getSettlementSummary, getSettlementTotals, getUnpaidSettlement, payCourierBatch, getPayoutHistory } from "../services/courier-settlement.service";
import { SettlementError } from "../lib/courier-settlement";
import { buildTrackingUrl } from "./tracking.controller";


// ============================================================================
// 1) STAFF-ИЙН КУРЬЕР УДИРДАХ — /api/couriers
// ============================================================================
export const staffCourierRouter = Router();

staffCourierRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const couriers = await prisma.courier.findMany({ orderBy: { createdAt: "desc" } });
    const statsMap = await getCourierStats(couriers.map((c) => c.id)); // ✅ ШИНЭ — од, хүргэсэн тоо
    const settlementMap = await getSettlementTotals(); // ✅ ШИНЭ — төлөх хөлс (тооцоотой эсэх: жагсаалтад хайх/ангилахад)
    res.json(
      couriers.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        isActive: c.isActive,
        isAdmin: c.isAdmin, // ✅ ШИНЭ — "Бүх хүргэлт" горим
        createdAt: c.createdAt,
        idCardNumber: c.idCardNumber,
        verificationStatus: c.verificationStatus,
        depositType: c.depositType,
        depositAmount: c.depositAmount,
        depositStatus: c.depositStatus,
        depositHeldAt: c.depositHeldAt,
        currentLatitude: c.currentLatitude,
        currentLongitude: c.currentLongitude,
        currentLocationUpdatedAt: c.currentLocationUpdatedAt,
        // ✅ ШИНЭ
        lastName: c.lastName,
        verifiedHomeAddress: c.verifiedHomeAddress,
        photoUrl: c.photoUrl,
        bankName: c.bankName,
        bankAccountNumber: c.bankAccountNumber,
        bankIban: c.bankIban,
        emergencyContactPhone: c.emergencyContactPhone,
        // ✅ ШИНЭ: Нийтэд харагдах танилт
        nickname: c.nickname,
        vehiclePlate: c.vehiclePlate,
        registerNumber: c.registerNumber, // ✅ ШИНЭ — Staff-д л (курьерт/нийтэд харагдахгүй)
        depositNote: c.depositNote, // ✅ ШИНЭ — ЮУ барьцаалсан (бичиг баримтын нэр/тэмдэглэл)
        depositReturnedAt: c.depositReturnedAt,
        ratingAverage: statsMap.get(c.id)?.ratingAverage ?? null,
        ratingCount: statsMap.get(c.id)?.ratingCount ?? 0,
        completedDeliveries: statsMap.get(c.id)?.completedDeliveries ?? 0,
        settlement: {
          payableCount: settlementMap.get(c.id)?.payableCount ?? 0,
          payableTotal: settlementMap.get(c.id)?.payableTotal ?? 0,
          blockedCount: settlementMap.get(c.id)?.blockedCount ?? 0,
          blockedTotal: settlementMap.get(c.id)?.blockedTotal ?? 0,
        },
      }))
    );
  } catch (err) {
    console.error("Хүргэгчид татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Хүргэгчид татаж чадсангүй" });
  }
});

staffCourierRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      name,
      phone,
      pin,
      idCardNumber,
      lastName,
      verifiedHomeAddress,
      photoUrl,
      bankName,
      bankAccountNumber,
      bankIban,
      emergencyContactPhone,
      registerNumber,
    } = req.body;

    if (!name || !phone || !pin) {
      return res.status(400).json({ error: "name, phone, pin заавал шаардлагатай" });
    }
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ error: "PIN 4-6 оронтой тоо байх ёстой" });
    }

    // ✅ ШИНЭ: Регистрийн дугаар (УБ12345678) — шалгаж нормчилно
    const regCheck = normalizeRegisterNumber(registerNumber);
    if (!regCheck.ok) return res.status(400).json({ error: regCheck.error });

    const pinHash = await hashPin(pin);
    const courier = await prisma.courier.create({
      data: {
        name,
        phone,
        pinHash,
        idCardNumber,
        registerNumber: regCheck.value ?? null,
        lastName,
        verifiedHomeAddress,
        photoUrl: photoUrl ? toDriveImageUrl(photoUrl) : null,
        bankName,
        bankAccountNumber,
        bankIban,
        emergencyContactPhone,
      },
    });
    res.status(201).json({ id: courier.id, name: courier.name, phone: courier.phone, isActive: courier.isActive });
  } catch (err: any) {
    if (err.code === "P2002") {
      // Аль талбар давхцсаныг ялгана (утас эсвэл регистр)
      const dupRegister = JSON.stringify(err.meta?.target ?? "").includes("registerNumber");
      return res.status(409).json({ error: dupRegister ? "Энэ регистрийн дугаартай хүргэгч аль хэдийн бүртгэлтэй байна" : "Энэ утасны дугаартай хүргэгч аль хэдийн бүртгэлтэй байна" });
    }
    console.error("Хүргэгч бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Хүргэгч бүртгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: Курьерийн бүх нэмэлт мэдээллийг (нэр, хаяг, банк гэх мэт) засах
staffCourierRouter.patch("/:id/profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      name,
      lastName,
      idCardNumber,
      verifiedHomeAddress,
      photoUrl,
      bankName,
      bankAccountNumber,
      bankIban,
      emergencyContactPhone,
      nickname,
      vehiclePlate,
      registerNumber,
    } = req.body;
    // ✅ ШИНЭ: Нийтэд харагдах нэр (nickname), машины дугаар — шалгаж нормчилно (хоосон бол арилгана)
    let nicknameValue: string | null | undefined;
    let plateValue: string | null | undefined;
    if (nickname !== undefined) {
      const r = normalizeNickname(nickname);
      if (!r.ok) return res.status(400).json({ error: r.error });
      nicknameValue = r.value ?? null;
    }
    if (vehiclePlate !== undefined) {
      const r = normalizeVehiclePlate(vehiclePlate);
      if (!r.ok) return res.status(400).json({ error: r.error });
      plateValue = r.value ?? null;
    }
    let registerValue: string | null | undefined;
    if (registerNumber !== undefined) {
      const r = normalizeRegisterNumber(registerNumber);
      if (!r.ok) return res.status(400).json({ error: r.error });
      registerValue = r.value ?? null;
    }

    const courier = await prisma.courier.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(lastName !== undefined && { lastName }),
        ...(idCardNumber !== undefined && { idCardNumber }),
        ...(verifiedHomeAddress !== undefined && { verifiedHomeAddress }),
        ...(photoUrl !== undefined && { photoUrl: photoUrl ? toDriveImageUrl(photoUrl) : null }),
        ...(bankName !== undefined && { bankName }),
        ...(bankAccountNumber !== undefined && { bankAccountNumber }),
        ...(bankIban !== undefined && { bankIban }),
        ...(emergencyContactPhone !== undefined && { emergencyContactPhone }),
        ...(nickname !== undefined && { nickname: nicknameValue }),
        ...(vehiclePlate !== undefined && { vehiclePlate: plateValue }),
        ...(registerNumber !== undefined && { registerNumber: registerValue }),
      },
    });
    res.json(courier);
  } catch (err: any) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Энэ регистрийн дугаартай хүргэгч аль хэдийн бүртгэлтэй байна" });
    console.error("Курьер профайл засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Засаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Staff иргэний үнэмлэхийг нүдэн (биечлэн) шалгаад баталгаажуулна
// (e-Mongolia албан ёсны API-г ирээдүйд холбох хүртэлх завсрын шийдэл).
staffCourierRouter.post("/:id/verify", requireAuth, async (req: Request, res: Response) => {
  try {
    const { status } = req.body; // 'VERIFIED' | 'REJECTED'
    if (!["VERIFIED", "REJECTED"].includes(status)) {
      return res.status(400).json({ error: "status нь VERIFIED эсвэл REJECTED байх ёстой" });
    }
    const courier = await prisma.courier.update({
      where: { id: req.params.id },
      data: { verificationStatus: status },
    });
    res.json(courier);
  } catch (err) {
    console.error("Баталгаажуулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Баталгаажуулж чадсангүй" });
  }
});

// ✅ ШИНЭ: Ажилтны барьцаа авах/буцаах — RentalDetail-тэй ИЖИЛ логиктой
staffCourierRouter.post("/:id/deposit", requireAuth, async (req: Request, res: Response) => {
  try {
    const { action, depositType, depositAmount, depositNote } = req.body; // action: 'HOLD' | 'RETURN'

    if (action === "HOLD") {
      // ✅ ШИНЭ: МӨНГӨ бол дүн (>0), БИЧИГ БАРИМТ бол ЯМАР бичиг баримтыг заавал бичнэ
      const hold = validateDepositHold({ depositType, depositAmount, depositNote });
      if (!hold.ok || !hold.value) return res.status(400).json({ error: hold.error });
      const courier = await prisma.courier.update({
        where: { id: req.params.id },
        data: {
          depositType: hold.value.depositType,
          depositAmount: hold.value.depositAmount,
          depositStatus: "HELD",
          depositHeldAt: new Date(),
          depositNote: hold.value.depositNote,
        },
      });
      return res.json(courier);
    }

    if (action === "RETURN") {
      const courier = await prisma.courier.update({
        where: { id: req.params.id },
        data: { depositStatus: "RETURNED", depositReturnedAt: new Date() },
      });
      return res.json(courier);
    }

    res.status(400).json({ error: "action нь HOLD эсвэл RETURN байх ёстой" });
  } catch (err) {
    console.error("Барьцаа бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Барьцаа бүртгэж чадсангүй" });
  }
});

// Идэвхтэй/идэвхгүй болгох (PIN солих ч мөн адил)
staffCourierRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { isActive, pin, isAdmin } = req.body; // ✅ ШИНЭ — isAdmin
    const data: any = {};
    if (isActive != null) data.isActive = isActive;
    if (isAdmin != null) data.isAdmin = Boolean(isAdmin); // ✅ ШИНЭ
    if (pin) {
      if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "PIN 4-6 оронтой тоо байх ёстой" });
      data.pinHash = await hashPin(pin);
    }

    const courier = await prisma.courier.update({ where: { id: req.params.id }, data });
    res.json({ id: courier.id, name: courier.name, phone: courier.phone, isActive: courier.isActive, isAdmin: courier.isAdmin }); // ✅ ШИНЭ
  } catch (err) {
    console.error("Хүргэгч шинэчлэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Хүргэгч шинэчилж чадсангүй" });
  }
});

// Staff тодорхой захиалгыг тодорхой хүргэгчид ГАРААР оноох (hybrid-ийн 2-р зам)
// ============================================================================
// ✅ ШИНЭ: ОРОЙН ТООЦОО — курьерт хүргэлтийн хөлсийг НЭГ МӨСӨН төлөх (багц)
//   GET  /payouts/summary          курьер бүрийн төлөгдөөгүй нийлбэр
//   GET  /:id/payouts/unpaid       нэг курьерийн төлөх захиалгууд + банкны мэдээлэл
//   POST /:id/payouts              { orderIds[], method: CASH|BANK_TRANSFER, note? } — нэг transaction-д багцлан төлнө
//   GET  /:id/payouts/history      өмнөх төлөлтүүд
// ============================================================================
const settlementError = (err: unknown, res: Response, what: string) => {
  if (err instanceof SettlementError) return res.status(400).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
};

staffCourierRouter.get("/payouts/summary", requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await getSettlementSummary());
  } catch (err) {
    settlementError(err, res, "Тооцоо татаж");
  }
});

staffCourierRouter.get("/:id/payouts/unpaid", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await getUnpaidSettlement(req.params.id));
  } catch (err) {
    settlementError(err, res, "Төлөх жагсаалт татаж");
  }
});

staffCourierRouter.get("/:id/payouts/history", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await getPayoutHistory(req.params.id));
  } catch (err) {
    settlementError(err, res, "Түүх татаж");
  }
});

staffCourierRouter.post("/:id/payouts", requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await payCourierBatch(req.params.id, req.body?.orderIds, req.body?.method, req.body?.note);
    res.status(201).json(result);
  } catch (err) {
    settlementError(err, res, "Төлөлт бүртгэж");
  }
});

// ✅ ШИНЭ: Staff — апп доторх газрын зурагт БҮХ идэвхтэй хүргэлтийн курьерийн бодит байршил (snapshot).
staffCourierRouter.get("/tracking/fleet", requireAuth, async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await fetchLiveSnapshot({ kind: "fleet" }));
  } catch (err) {
    console.error("Байршлын snapshot татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Staff — хүргэж яваа БҮХ курьерийн бодит байршлыг газрын зураг дээр харах холбоос (12 цаг).
staffCourierRouter.post("/tracking-link", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json({ url: buildTrackingUrl(req, { kind: "fleet" }) });
  } catch (err) {
    console.error("Байршлын холбоос үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Холбоос үүсгэж чадсангүй" });
  }
});

staffCourierRouter.post("/assign", requireAuth, async (req: Request, res: Response) => {
  try {
    const { orderId, courierId } = req.body;
    if (!orderId || !courierId) return res.status(400).json({ error: "orderId, courierId заавал шаардлагатай" });

    const order = await assignDeliveryManually(orderId, courierId);
    res.json(order);
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(409).json({ error: err.message });
    console.error("Хүргэгчид онооход алдаа гарлаа:", err);
    res.status(500).json({ error: "Оноож чадсангүй" });
  }
});

// Захиалгыг БҮХ идэвхтэй хүргэгчид broadcast хийх (hybrid-ийн 1-р зам эхлэл)
staffCourierRouter.post("/offer", requireAuth, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId заавал шаардлагатай" });

    await offerDeliveryToAllCouriers(orderId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(400).json({ error: err.message }); // ✅ ШИНЭ — "төлбөр төлөгдөөгүй" мессеж Staff-д харагдана
    console.error("Хүргэлт санал болгоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Санал болгож чадсангүй" });
  }
});

// ============================================================================
// 2) КУРЬЕРИЙН ӨӨРИЙНХ НЬ ENDPOINT-УУД — /api/courier
// ============================================================================
export const courierSelfRouter = Router();

// ✅ ШИНЭ: Курьер апп асаах бүрд дуудна — isAdmin (мөн нэр/идэвхтэй эсэх) DB-ээс
// ШИНЭЭР татаж, Staff Тохиргоо өөрчилсөн ч 30 хоногийн хуучин токенд ХАЛДДАГГҮЙ.
courierSelfRouter.get("/me", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const courier = await prisma.courier.findUnique({
      where: { id: req.courier!.courierId },
      select: { id: true, name: true, nickname: true, vehiclePlate: true, phone: true, isActive: true, isAdmin: true },
    });
    if (!courier) return res.status(404).json({ error: "Курьер олдсонгүй" });
    // ✅ ШИНЭ: Өөрийн нийтэд харагдах танилт — од, хүргэсэн тоо (урамшуулал)
    const stats = (await getCourierStats([courier.id])).get(courier.id);
    res.json({ ...courier, ...buildPublicProfile(courier, stats) });
  } catch (err) {
    console.error("Курьерийн профайл татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// Push notification-д зориулж энэ төхөөрөмжийн FCM token-ийг бүртгэнэ
courierSelfRouter.post("/device-token", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const { fcmToken, platform } = req.body;
    if (!fcmToken) return res.status(400).json({ error: "fcmToken заавал шаардлагатай" });

    await prisma.courierDeviceToken.upsert({
      where: { fcmToken },
      update: { courierId: req.courier!.courierId, platform },
      create: { courierId: req.courier!.courierId, fcmToken, platform },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Device token бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Бүртгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: Курьерт зориулж ЗАХИАЛГЫГ цэвэрлэж (санитайз хийж) буцаана —
// БАРААНЫ НЭР/ДЭЛГЭРЭНГҮЙ огт ИЛГЭЭХГҮЙ (аюулгүй байдал/нууцлал), зөвхөн
// Staff тохируулсан ОВОР ХЭМЖЭЭ + Түрээс бол өгөх/авах огноог илгээнэ.
/** ✅ ШИНЭ: Дэлгүүрийн хаяг/координат — энгийн (дэлгүүрийн бараа) хүргэлтийн АВАХ цэг. */
function shopOf(settings: any): { address: string | null; latitude: number | null; longitude: number | null } {
  return { address: settings?.shopAddress ?? null, latitude: settings?.shopLatitude ?? null, longitude: settings?.shopLongitude ?? null };
}

function toCourierSafeOrder(
  order: any,
  commissionPercent: number,
  serviceCommissionPercent?: number | null,
  shop?: { address: string | null; latitude: number | null; longitude: number | null }
) {
  // ✅ ШИНЭ: Хүргэлт + чимэглэлийн ажлын курьерт очих ЦЭВЭР дүн (нэг helper-ээр)
  const payout = computeCourierPayout(
    { deliveryFee: Number(order.deliveryFee), serviceAmount: Number(order.serviceAmount ?? 0) },
    commissionPercent,
    serviceCommissionPercent
  );
  const hasService = Number(order.serviceAmount ?? 0) > 0 || !!order.serviceLabel;
  const rentalItems = (order.items || []).filter((i: any) => i.rentalDetail);
  const rentalStartDate =
    rentalItems.length > 0
      ? rentalItems.reduce((min: Date, i: any) => (i.rentalDetail.startDate < min ? i.rentalDetail.startDate : min), rentalItems[0].rentalDetail.startDate)
      : null;
  const rentalEndDate =
    rentalItems.length > 0
      ? rentalItems.reduce((max: Date, i: any) => (i.rentalDetail.endDate > max ? i.rentalDetail.endDate : max), rentalItems[0].rentalDetail.endDate)
      : null;

  // ✅ ШИНЭ: "Хүргэгдэх ёстой огноо" — Түрээс бол эхлэх огноо, тусгай
  // захиалгын эцсийн хугацаатай бол хамгийн эрт эцсийн хугацаа, аль аль
  // байхгүй бол null (яаралгүй, ямар ч үед хүргэж болно).
  const customizationDeadlines = (order.items || [])
    .map((i: any) => i.customizationDeadline)
    .filter((d: any) => d != null);
  const earliestCustomizationDeadline =
    customizationDeadlines.length > 0
      ? customizationDeadlines.reduce((min: Date, d: Date) => (d < min ? d : min), customizationDeadlines[0])
      : null;
  const dueDate = rentalStartDate || earliestCustomizationDeadline || null;
  const isErrand = order.orderType === "COURIER_ERRAND"; // ✅ ШИНЭ
  const isSellerOrder = !!order.sellerId; // ✅ ШИНЭ (marketplace) — худалдагчийн хаягаас очиж авна

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    // ✅ ШИНЭ: Курьерийн ӨӨРИЙН илгээмжид хэрэглэгчийн оронд хүсэлт үүсгэсэн курьерийн нэр
    customer: isErrand
      // ✅ ЗАСВАР: Хүргэх курьер илгээгчтэй холбогдох (авах хаяг, "Авах/Хүргэлтийн код") шаардлагатай — ХҮЛЭЭН АВСАН дараа л утсыг харуулна
      ? { name: order.requestingCourier ? courierDisplayName(order.requestingCourier) : "Курьер", phone: order.courierId ? order.requestingCourier?.phone ?? null : null }
      : order.customer
      ? { name: order.customer.name, phone: order.customer.phone }
      : null,
    isErrand, // ✅ ШИНЭ
    cancelledAt: order.cancelledAt ?? null, // ✅ ШИНЭ — нөхөн олговортой цуцлалтыг апп орлогод тооцно
    cancellationFee: Number(order.cancellationFee ?? 0), // ✅ ШИНЭ
    errandDescription: isErrand ? order.errandDescription : null, // ✅ ШИНЭ
    // ✅ ШИНЭ: Хүлээн авагч — утсыг ЗӨВХӨН хүргэх курьер хүлээн авсны дараа л харуулна (саналын шатанд бүх курьерт ил гаргахгүй)
    recipientName: isErrand ? order.recipientName ?? null : null,
    recipientPhone: isErrand && order.courierId ? order.recipientPhone ?? null : null,
    // ✅ ЗАСВАР: АВАХ цэг — илгээмжид илгээгчийн хаяг, энгийн (дэлгүүрийн бараа) хүргэлтэд ҮРГЭЛЖ "Дэлгүүр"
    pickupLabel: isErrand ? "Авах цэг" : isSellerOrder ? `Худалдагч: ${order.seller?.name ?? ""}`.trim() : "Дэлгүүр",
    pickupAddress: isErrand || isSellerOrder ? order.pickupAddress : shop?.address ?? null,
    pickupLatitude: isErrand || isSellerOrder ? order.pickupLatitude : shop?.latitude ?? null,
    pickupLongitude: isErrand || isSellerOrder ? order.pickupLongitude : shop?.longitude ?? null,
    // ✅ ШИНЭ: Авахдаа КОД (худалдагчаас асууна) + GPS заавал. Код курьерт ХАРАГДАХГҮЙ (pickupOtp энд байхгүй).
    requiresPickupCode: isErrand || isSellerOrder,
    // Худалдагчтай холбогдох утас — зөвхөн захиалгыг хүлээн авсны ДАРАА
    pickupContact: isSellerOrder && order.courierId ? { name: order.seller?.name ?? null, phone: order.seller?.phone ?? null } : null,
    deliveryAddress: order.deliveryAddress,
    deliveryFee: order.deliveryFee, // ⚠️ Гэрээт (харилцагчаас авсан) нийт дүн — курьерт ХАРУУЛАХГҮЙ, дотоод лавлагаанд
    // ✅ ШИНЭ: Дэлгүүрийн хувийг хассан, хүргэгчид олгох ЦЭВЭР дүн —
    // курьер апп-д "Хүргэлтийн төлбөр" гэж ЭНЭ Л харагдана.
    courierPayout: payout.totalPayout,
    deliveryPayout: payout.deliveryPayout, // ✅ ШИНЭ
    servicePayout: payout.servicePayout, // ✅ ШИНЭ
    serviceLabel: hasService ? order.serviceLabel ?? "Нэмэлт ажил" : null, // ✅ ШИНЭ — "🎈 чимэглэлтэй"
    deliveryLatitude: order.deliveryLatitude,
    deliveryLongitude: order.deliveryLongitude,
    deliveryAssignStatus: order.deliveryAssignStatus,
    deliveryOfferedAt: order.deliveryOfferedAt,
    deliveryAcceptedAt: order.deliveryAcceptedAt,
    pickedUpAt: order.pickedUpAt, // ✅ ШИНЭ
    returnPickedUpAt: order.returnPickedUpAt, // ✅ ШИНЭ
    rentalGivenAt: order.rentalGivenAt, // ✅ ШИНЭ
    deliveredAt: order.deliveredAt,
    itemCount: (order.items || []).length,
    packageSize: order.packageSize || "SMALL", // ✅ ЗАСВАР — сонгоогүй бол "Жижиг" гэж тооцно
    isRental: rentalItems.length > 0, // ✅ ШИНЭ
    rentalStartDate,
    rentalEndDate,
    dueDate, // ✅ ШИНЭ — Курьер эрэмбэлэхэд ашиглана
    // ✅ ЗАСВАР: БИД хүргэгчид ТӨЛСӨН эсэх (захиалгын төлбөртэй холбоогүй)
    courierFeePaid: order.courierFeePaid,
    courierFeePaidAt: order.courierFeePaidAt,
  };
}

// Одоогоор OFFERED (санал болгогдсон, хараахан хэн ч аваагүй) захиалгуудын жагсаалт
courierSelfRouter.get("/deliveries/available", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        deliveryAssignStatus: DeliveryAssignStatus.OFFERED,
        // ✅ ШИНЭ: Энэ хүргэгч аль хэдийн АЛГАССАН захиалгыг ДАХИН харуулахгүй
        offerResponses: { none: { courierId: req.courier!.courierId, response: { in: ["IGNORED", "RELEASED", "REJECTED_BY_REQUESTER"] as any } } },
        // ✅ ШИНЭ: Өөрийн илгээмж өөрт нь харагдахгүй + төлөгдөөгүй илгээмж харагдахгүй (хоёр дахь хамгаалалт)
        AND: [
          { OR: [{ requestingCourierId: null }, { requestingCourierId: { not: req.courier!.courierId } }] },
          { OR: [{ orderType: { not: "COURIER_ERRAND" as any } }, { paymentStatus: "PAID" as any }] },
        ],
      },
      include: { customer: true, items: { include: { product: true, rentalDetail: true } }, requestingCourier: { select: { name: true, nickname: true, phone: true } }, seller: { select: { name: true, phone: true } } }, // ✅ ШИНЭ
      orderBy: { deliveryOfferedAt: "asc" },
    });
    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } }); // ✅ ШИНЭ
    const commissionPercent = settings?.courierCommissionPercent ?? 15;
    res.json(orders.map((o) => toCourierSafeOrder(o, commissionPercent, settings?.serviceCommissionPercent, shopOf(settings)))); // ✅ ЗАСВАР — цэвэр дүнтэй
  } catch (err) {
    console.error("Боломжит хүргэлт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: "Алгасах" — backend-д бүртгэнэ (энэ хүргэгчид ДАХИН
// харагдахгүй, POS дээр "хэн алгассан" гэдгийг харна).
// ============================================================================
// ✅ ШИНЭ: POST /api/courier/deliveries/:orderId/proof — Курьер хүргэсэн/буцаан
// авсныхаа БАТАЛГААЖУУЛАХ ЗУРАГ (хаалганы зураг гэх мэт) илгээнэ.
// body: { stage: "DELIVERY" | "RETURN", imageBase64: string, mimeType?: string }
// Зураг зөвхөн OTP-ээр баталгаажуулсны ДАРАА (төлөв ахисан үед) хадгалагдана.
// ============================================================================
courierSelfRouter.post("/deliveries/:orderId/proof", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const { stage, imageBase64, mimeType } = req.body;
    if (stage !== "DELIVERY" && stage !== "RETURN") {
      return res.status(400).json({ error: "stage нь DELIVERY эсвэл RETURN байх ёстой" });
    }
    const mime = typeof mimeType === "string" ? mimeType : "image/jpeg";
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      return res.status(400).json({ error: "Зөвхөн JPEG, PNG, WEBP зураг зөвшөөрнө" });
    }
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      return res.status(400).json({ error: "imageBase64 заавал шаардлагатай" });
    }
    const buffer = Buffer.from(imageBase64, "base64");
    if (buffer.length === 0 || buffer.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: "Зураг хэт том байна (4MB-аас бага байх ёстой)" });
    }

    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      select: { id: true, courierId: true, deliveryAssignStatus: true, storeId: true },
    });
    if (!order || order.courierId !== req.courier!.courierId) {
      return res.status(403).json({ error: "Энэ захиалга танд оноогдоогүй байна" });
    }

    const allowedStatuses: string[] =
      stage === "DELIVERY" ? ["GIVEN", "RETURN_PICKED_UP", "DELIVERED"] : ["RETURN_PICKED_UP", "DELIVERED"];
    if (!allowedStatuses.includes(order.deliveryAssignStatus)) {
      return res.status(409).json({ error: "Эхлээд OTP кодоор баталгаажуулалтаа хийнэ үү" });
    }

    await prisma.deliveryProof.upsert({
      where: { orderId_stage: { orderId: order.id, stage } },
      update: { imageData: buffer, mimeType: mime, courierId: req.courier!.courierId, createdAt: new Date() },
      create: { orderId: order.id, stage, mimeType: mime, imageData: buffer, courierId: req.courier!.courierId },
    });

    emitToStore(order.storeId, "delivery_proof_uploaded", { orderId: order.id, stage });
    res.json({ success: true });
  } catch (err) {
    console.error("Баталгаажуулах зураг хадгалахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Зураг хадгалж чадсангүй" });
  }
});

courierSelfRouter.post("/deliveries/:orderId/ignore", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    await prisma.deliveryOfferResponse.upsert({
      where: { orderId_courierId: { orderId: req.params.orderId, courierId: req.courier!.courierId } },
      update: { response: "IGNORED", respondedAt: new Date() },
      create: { orderId: req.params.orderId, courierId: req.courier!.courierId, response: "IGNORED" },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Алгасахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Алгасаж чадсангүй" });
  }
});

// Энэ хүргэгчид ASSIGNED (Accept дарсан ЭСВЭЛ Staff оноосон) захиалгууд
courierSelfRouter.get("/deliveries/mine", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        courierId: req.courier!.courierId,
        OR: [
          { deliveryAssignStatus: { in: [DeliveryAssignStatus.ASSIGNED, DeliveryAssignStatus.PICKED_UP, DeliveryAssignStatus.GIVEN, DeliveryAssignStatus.RETURN_PICKED_UP, DeliveryAssignStatus.DELIVERED] } },
          // ✅ ШИНЭ: Курьер авсны дараа илгээгч цуцалсан — нөхөн олговор нь курьерийн орлогод орно
          { deliveryAssignStatus: DeliveryAssignStatus.CANCELLED, cancellationFee: { gt: 0 } },
        ],
      },
      include: { customer: true, items: { include: { product: true, rentalDetail: true } }, requestingCourier: { select: { name: true, nickname: true, phone: true } }, seller: { select: { name: true, phone: true } } }, // ✅ ШИНЭ
      orderBy: { deliveryAcceptedAt: "desc" },
    });
    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } }); // ✅ ШИНЭ
    const commissionPercent = settings?.courierCommissionPercent ?? 15;
    res.json(orders.map((o) => toCourierSafeOrder(o, commissionPercent, settings?.serviceCommissionPercent, shopOf(settings)))); // ✅ ЗАСВАР — цэвэр дүнтэй
  } catch (err) {
    console.error("Миний хүргэлт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Курьер апп дээрх "Бүх хүргэлт" (Админ горим) — ЗӨВХӨН isAdmin=true
// курьерт зөвшөөрнө. Бусад курьерийн идэвхтэй хүргэлтийг (хэн нь ямар
// төлөвтэй байгааг) хянахад ашиглана; бараа/захиалгын нэр ХАРАГДАХГҮЙ
// хэвээр (toCourierSafeOrder-ийн нууцлал хадгалагдана).
// ============================================================================
// ✅ ШИНЭ: Курьерийн ӨӨРИЙН барааг (дэлгүүрийн бараа БИШ) өөр курьерээр
// хүргүүлэх хүсэлт — "Uber шиг" бусад курьерт зэрэг broadcast хийгдэнэ.
// ============================================================================

// Илгээмж үүсгэх — ТӨЛБӨР төлөгдсөний ДАРАА л (order-payment.service автоматаар) бусад курьерт broadcast хийгдэнэ.
courierSelfRouter.post("/errands", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const order = await createErrand({
      requestingCourierId: req.courier!.courierId,
      errandDescription: req.body.errandDescription,
      pickupAddress: req.body.pickupAddress,
      pickupLatitude: req.body.pickupLatitude,
      pickupLongitude: req.body.pickupLongitude,
      deliveryAddress: req.body.deliveryAddress,
      deliveryLatitude: req.body.deliveryLatitude,
      deliveryLongitude: req.body.deliveryLongitude,
      deliveryFee: req.body.deliveryFee,
      recipientName: req.body.recipientName, // ✅ ШИНЭ
      recipientPhone: req.body.recipientPhone, // ✅ ШИНЭ — заавал
    });
    // ✅ ШИНЭ: pickupOtp-ийг ЗӨВХӨН энд, хүсэлт үүсгэсэн курьерт л буцаана —
    // хүргэх курьер барааг авахдаа энэ кодыг түүнээс АСУУХ ёстой.
    // ✅ ШИНЭ: deliveryFee буцаана — апп шууд төлбөрийн дэлгэц нээнэ (төлөөгүй бол курьерт санал болохгүй)
    res.status(201).json({ id: order.id, orderNumber: order.orderNumber, pickupOtp: order.pickupOtp, deliveryFee: Number(order.deliveryFee) });
  } catch (err) {
    if (err instanceof ErrandError) return res.status(400).json({ error: err.message });
    console.error("Илгээмж үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Илгээмж үүсгэж чадсангүй" });
  }
});

// Хүргэх курьер БАРАА АВАХ үедээ хүсэлт үүсгэсэн курьерээс асуусан OTP-ийг баталгаажуулна.
courierSelfRouter.post("/errands/:id/confirm-pickup", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    // ✅ ШИНЭ: Байршил (latitude/longitude) ЗААВАЛ — GPS унтраалттай бол баталгаажихгүй
    const updated = await confirmErrandPickedUp(req.params.id, req.courier!.courierId, req.body.otp, {
      latitude: req.body.latitude,
      longitude: req.body.longitude,
    });
    emitToStore(updated.storeId, "delivery_picked_up", { orderId: updated.id }); // ✅ ШИНЭ — POS дээр ч шинэчлэгдэнэ
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ErrandError) return res.status(400).json({ error: err.message });
    console.error("Илгээмж авахыг баталгаажуулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Баталгаажуулж чадсангүй" });
  }
});

// ✅ ШИНЭ: Админ курьер — хүргэж яваа БҮХ курьерийн бодит байршлыг газрын зураг дээр харах холбоос (12 цаг).
courierSelfRouter.get("/tracking-link", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const me = await prisma.courier.findUnique({ where: { id: req.courier!.courierId }, select: { isAdmin: true } });
    if (!me?.isAdmin) return res.status(403).json({ error: "Энэ горим зөвхөн админ эрхтэй курьерт нээлттэй" });
    res.json({ url: buildTrackingUrl(req, { kind: "fleet" }) });
  } catch (err) {
    console.error("Байршлын холбоос үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Холбоос үүсгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: Илгээгч өөрийн илгээмжийг хүргэж яваа курьерийг газрын зураг дээр харах холбоос
// (зөвхөн энэ нэг илгээмж, курьер авснаас хүргэж дуустал).
courierSelfRouter.get("/errands/:id/tracking-link", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: { id: true, orderType: true, requestingCourierId: true, deliveryAssignStatus: true },
    });
    if (!order) return res.status(404).json({ error: "Илгээмж олдсонгүй" });
    const access = checkErrandTrackingAccess(order, req.courier!.courierId);
    if (!access.ok) return res.status(403).json({ error: access.reason ?? "Энэ илгээмжийг хянах боломжгүй" });
    res.json({ url: buildTrackingUrl(req, { kind: "order", orderId: order.id }) });
  } catch (err) {
    console.error("Илгээмжийн байршлын холбоос үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Холбоос үүсгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: Илгээгч хүргэсэн курьерийг үнэлнэ (1-5 од, тайлбар заавал биш).
courierSelfRouter.post("/errands/:id/rate", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const result = await rateErrandCourier(req.params.id, req.courier!.courierId, req.body?.stars, req.body?.comment);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof FeedbackError) return res.status(400).json({ error: err.message });
    console.error("Үнэлгээ бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Үнэлгээ бүртгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: Илгээгч бараа авагдахаас өмнө одоогийн курьерийг солино (өөр курьерт дахин санал болно).
courierSelfRouter.post("/errands/:id/reject-courier", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const result = await rejectAssignedCourier(req.params.id, req.courier!.courierId);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof FeedbackError) return res.status(400).json({ error: err.message });
    console.error("Курьер солиход алдаа гарлаа:", err);
    res.status(500).json({ error: "Курьер солиж чадсангүй" });
  }
});

// ✅ ШИНЭ: Апп доторх газрын зурагт (нэвтэрсэн курьерт) — холбоосгүйгээр шууд snapshot.
courierSelfRouter.get("/tracking/fleet", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const me = await prisma.courier.findUnique({ where: { id: req.courier!.courierId }, select: { isAdmin: true } });
    if (!me?.isAdmin) return res.status(403).json({ error: "Энэ горим зөвхөн админ эрхтэй курьерт нээлттэй" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await fetchLiveSnapshot({ kind: "fleet" }));
  } catch (err) {
    console.error("Байршлын snapshot татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил татаж чадсангүй" });
  }
});

courierSelfRouter.get("/errands/:id/tracking", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: { id: true, orderType: true, requestingCourierId: true, deliveryAssignStatus: true },
    });
    if (!order) return res.status(404).json({ error: "Илгээмж олдсонгүй" });
    const access = checkErrandTrackingAccess(order, req.courier!.courierId);
    if (!access.ok) return res.status(403).json({ error: access.reason ?? "Энэ илгээмжийг хянах боломжгүй" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await fetchLiveSnapshot({ kind: "order", orderId: order.id }));
  } catch (err) {
    console.error("Илгээмжийн байршил татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Илгээгч өөрийн илгээмжийг цуцална (шат бүрийн дүрмийг planErrandCancellation тодорхойлно).
courierSelfRouter.post("/errands/:id/cancel", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const plan = await cancelErrand(req.params.id, req.courier!.courierId);
    res.json({ success: true, branch: plan.branch, fee: plan.fee, refund: plan.refund });
  } catch (err) {
    if (err instanceof ErrandError) return res.status(400).json({ error: err.message });
    console.error("Илгээмж цуцлахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Цуцалж чадсангүй" });
  }
});

// ✅ ШИНЭ: Accept хийсэн курьер бараа авахаас өмнө "хүргэж чадахгүй" гэж чөлөөлөгдөнө.
courierSelfRouter.post("/errands/:id/release", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    await releaseErrand(req.params.id, req.courier!.courierId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ErrandError) return res.status(400).json({ error: err.message });
    console.error("Илгээмж чөлөөлөхөд алдаа гарлаа:", err);
    res.status(500).json({ error: "Чөлөөлж чадсангүй" });
  }
});

// ✅ ШИНЭ: "Миний илгээмж" — энэ курьерийн ӨӨРӨӨ үүсгэсэн хүсэлтүүдийн
// түүх (бүх төлөв — OFFERED-ээс DELIVERED хүртэл). Хүргэж буй курьерийн
// нэр/утас, төлбөрийн төлөв (⚠️ төлөөгүй бол тод харуулахад) агуулна.
courierSelfRouter.get("/errands/mine", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: { requestingCourierId: req.courier!.courierId, orderType: "COURIER_ERRAND" as any },
      include: {
        courier: { select: { id: true, name: true, nickname: true, vehiclePlate: true, phone: true } }, // ✅ Хүргэж буй курьер
        rating: { select: { stars: true } }, // ✅ ШИНЭ — миний өгсөн од
      },
      orderBy: { createdAt: "desc" },
    });
    const settingsForCancel = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    const cancelFeePercent = settingsForCancel?.errandCancelFeePercent ?? 20;
    // ✅ ШИНЭ: Хүргэж буй курьерийн нийтийн танилт (од, хүргэсэн тоо) + курьер солих эрх
    const courierStats = await getCourierStats(orders.map((o) => o.courier?.id).filter((id): id is string => !!id));
    const swapRows = (await prisma.deliveryOfferResponse.groupBy({
      by: ["orderId"],
      where: { orderId: { in: orders.map((o) => o.id) }, response: "REJECTED_BY_REQUESTER" as any },
      _count: { _all: true },
    })) as unknown as Array<{ orderId: string; _count: { _all: number } }>;
    const swapsMap = new Map(swapRows.map((r) => [r.orderId, r._count._all]));
    res.json(
      orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        errandDescription: o.errandDescription,
        recipientName: o.recipientName, // ✅ ШИНЭ — илгээгч өөрийн оруулсан хүлээн авагчаа харна
        recipientPhone: o.recipientPhone,
        pickupAddress: o.pickupAddress,
        deliveryAddress: o.deliveryAddress,
        deliveryFee: Number(o.deliveryFee),
        paymentStatus: o.paymentStatus,
        deliveryAssignStatus: o.deliveryAssignStatus,
        // ✅ ШИНЭ: Бүртгэлтэй нэр БИШ — nickname, машины дугаар, од, хүргэсэн тоо (хүргэж буй курьерийг таних)
        fulfillingCourier: o.courier
          ? { ...buildPublicProfile(o.courier, courierStats.get(o.courier.id)), name: courierDisplayName(o.courier), phone: o.courier.phone }
          : null,
        myRating: o.rating?.stars ?? null,
        canRate: o.deliveryAssignStatus === "DELIVERED" && !!o.courier && !o.rating,
        canRejectCourier: o.deliveryAssignStatus === "ASSIGNED" && (swapsMap.get(o.id) ?? 0) < MAX_COURIER_SWAPS,
        swapsLeft: Math.max(0, MAX_COURIER_SWAPS - (swapsMap.get(o.id) ?? 0)),
        createdAt: o.createdAt,
        deliveredAt: o.deliveredAt,
        // ✅ ШИНЭ: Цуцлахаас ӨМНӨ "хураамж X₮, буцаалт Y₮" гэж харуулахад (backend-ийн дүрэмтэй ИЖИЛ функц)
        cancelPlan: planErrandCancellation(
          { deliveryAssignStatus: o.deliveryAssignStatus, paymentStatus: o.paymentStatus, paidAmount: Number(o.paidAmount), deliveryFee: Number(o.deliveryFee) },
          cancelFeePercent
        ),
        // ✅ ШИНЭ: Илгээгч кодуудаа ХЭЗЭЭ Ч харж чадна (зөвхөн энэ endpoint — илгээгчид л). Хэрэггүй болсон үед null.
        // pickupOtp — бараа авахаар ирсэн курьерт; deliveryOtp — бараа хүлээн авагчид хүрсний ДАРАА хүргэсэн курьерт өгнө.
        pickupOtp: ["UNASSIGNED", "OFFERED", "ASSIGNED"].includes(o.deliveryAssignStatus) ? o.pickupOtp : null,
        deliveryOtp: ["UNASSIGNED", "OFFERED", "ASSIGNED", "PICKED_UP"].includes(o.deliveryAssignStatus) ? o.deliveryOtp : null,
        cancellationFee: Number(o.cancellationFee),
        refundDueAmount: Number(o.refundDueAmount),
        refundedAt: o.refundedAt,
        cancelledAt: o.cancelledAt,
      }))
    );
  } catch (err) {
    console.error("Миний илгээмж татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

courierSelfRouter.get("/deliveries/all-active", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const me = await prisma.courier.findUnique({ where: { id: req.courier!.courierId }, select: { isAdmin: true } });
    if (!me?.isAdmin) {
      return res.status(403).json({ error: "Энэ горим зөвхөн админ эрхтэй курьерт нээлттэй" });
    }

    const orders = await prisma.order.findMany({
      where: {
        deliveryAssignStatus: { in: [DeliveryAssignStatus.OFFERED, DeliveryAssignStatus.ASSIGNED, DeliveryAssignStatus.PICKED_UP, DeliveryAssignStatus.GIVEN, DeliveryAssignStatus.RETURN_PICKED_UP] },
      },
      include: {
        customer: true,
        items: { include: { product: true, rentalDetail: true } },
        courier: { select: { id: true, name: true, nickname: true } }, // ✅ ШИНЭ — админд хэн авсныг харуулна
        requestingCourier: { select: { name: true, nickname: true, phone: true } }, seller: { select: { name: true, phone: true } }, // ✅ ШИНЭ
      },
      orderBy: { deliveryOfferedAt: "asc" },
    });
    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    const commissionPercent = settings?.courierCommissionPercent ?? 15;
    res.json(
      orders.map((o) => ({
        ...toCourierSafeOrder(o, commissionPercent, settings?.serviceCommissionPercent, shopOf(settings)),
        courierId: o.courier?.id ?? null, // ✅ ШИНЭ
        courierName: o.courier ? courierStaffLabel(o.courier) : null, // ✅ ШИНЭ — OFFERED төлөвт null (хэн ч аваагүй)
      }))
    );
  } catch (err) {
    console.error("Бүх хүргэлт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// "Accept" — race condition-оос хамгаалагдсан
courierSelfRouter.post("/deliveries/:orderId/accept", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const order = await acceptDelivery(req.params.orderId, req.courier!.courierId);
    res.json(order);
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(409).json({ error: err.message });
    console.error("Accept хийхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Авч чадсангүй" });
  }
});

// ✅ ШИНЭ: Курьер апп ЗӨВХӨН идэвхтэй (ASSIGNED) хүргэлттэй үед 15-30
// секунд тутам энэ endpoint-ийг дуудаж байршлаа шинэчилнэ. Идэвхтэй
// хүргэлтгүй үед ДУУДАХГҮЙ — ажилтны нууцлалыг байнга хянахгүй.
courierSelfRouter.post("/location", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const { latitude, longitude } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude, longitude заавал шаардлагатай" });
    }

    await prisma.courier.update({
      where: { id: req.courier!.courierId },
      data: { currentLatitude: latitude, currentLongitude: longitude, currentLocationUpdatedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Байршил шинэчлэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил шинэчилж чадсангүй" });
  }
});

// "Хүргэсэн" тэмдэглэх
// ✅ ЗАСВАР: Одоо OTP код ЗААВАЛ шаардана — товч дарснаар автоматаар
// баталгаажихгүй. ТҮРЭЭСИЙН захиалгад энэ endpoint 2 удаа дуудагдана
// (1-рт "Өгсөн", 2-рт "Буцаан авсан") — backend аль алхамд байгааг өөрөө
// тодорхойлно.
courierSelfRouter.post("/deliveries/:orderId/deliver", requireCourierAuth, async (req: Request, res: Response) => {
  try {
    const { otp } = req.body;
    if (!otp || typeof otp !== "string") {
      return res.status(400).json({ error: "Харилцагчийн баталгаажуулах кодыг оруулна уу" });
    }

    const order = await confirmDeliveryStep(req.params.orderId, req.courier!.courierId, otp);
    res.json(order);
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(409).json({ error: err.message });
    console.error("Хүргэсэн тэмдэглэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Тэмдэглэж чадсангүй" });
  }
});

// ⚠️ "Ignore" зөвхөн КЛИЕНТ ТАЛД (тухайн хүргэгчийн дэлгэцээс) арилгана —
// backend-д ямар ч мэдээлэл өөрчлөгдөхгүй тул endpoint шаардлагагүй.
// Учир нь Ignore хийсэн ч захиалга ХЭВЭЭР OFFERED хэвээр байж, БУСАД
// хүргэгч авах боломжтой байх ёстой.
