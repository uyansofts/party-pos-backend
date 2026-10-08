// ============================================================================
// ORDER CONTROLLER
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { checkout, cancelOrder, CheckoutValidationError, OrderCancellationError } from "../services/order.service";
import { markPickedUp, confirmReturnedToShop, DeliveryAssignmentError } from "../services/delivery-assignment.service";
import { markOrderPaidManually, OrderPaymentError } from "../services/order-payment.service";
import { expireStaleOnlineOrders } from "../services/order-cleanup.service";
import { checkUpcomingCustomizationDeadlines } from "./custom-orders.controller";
import { PaymentMethod } from "@prisma/client";
import { RentalUnavailableError } from "../services/rental-availability.service";
import { requireAuth } from "../middleware/auth.middleware";
import { emitToCourier } from "../realtime/socket";
import { isOrderOverdue } from "../lib/order-urgency";
import { completeErrandRefund, ErrandError } from "../services/errand.service"; // ✅ ШИНЭ
import { buildTrackingUrl } from "./tracking.controller"; // ✅ ШИНЭ
import { fetchLiveSnapshot } from "../services/live-tracking.service";
import { signCustomerToken, buildStorefrontLink } from "../lib/customer-tracking";
import { TrackingTokenError } from "../lib/live-tracking";
import { ASSIGNED_STALE_MINUTES, ON_THE_WAY_STALE_MINUTES } from "../services/delivery-watcher.service";

const router = Router();
router.use(requireAuth); // Энэ router-ийн БҮХ route Staff нэвтрэлт шаардана

// ============================================================================
// POST /api/orders — Захиалга үүсгэх (Checkout)
// body: {
//   customerId?, staffId?, orderType?: "POS"|"ONLINE", storeId?,
//   items: [
//     { productId, itemType: "SALE", quantity },
//     { productId, itemType: "RENTAL", quantity, startDate, endDate }
//   ]
// }
// ============================================================================
router.post("/", async (req: Request, res: Response) => {
  try {
    const order = await checkout(req.body);
    res.status(201).json(order);
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof RentalUnavailableError) {
      return res.status(409).json({
        error: "Уучлаарай, нэг эсвэл хэд хэдэн бараа энэ хугацаанд дутуу байна. Захиалга үүсгэгдсэнгүй.",
        availableQty: err.availableQty,
      });
    }
    console.error("Захиалга үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга үүсгэж чадсангүй" });
  }
});

// ============================================================================
// GET /api/orders — Захиалгын жагсаалт (түүх)
// query: ?paymentStatus=PAID&limit=20
// ----------------------------------------------------------------------------
// Хамгийн сүүлийн захиалгаас эхлэн буцаана. paymentStatus дамжуулаагүй бол
// БҮХ төлөвийг харуулна (PENDING, PARTIALLY_PAID, PAID, REFUNDED, CANCELLED).
// ============================================================================
router.get("/", async (req: Request, res: Response) => {
  try {
    // ✅ ШИНЭ: Кассчин Захиалгын түүхээ нээх бүрд хугацаа хэтэрсэн
    // PENDING захиалгуудыг цэвэрлэнэ (throttled тул хэт олон удаа
    // ажиллахгүй).
    await expireStaleOnlineOrders().catch((e) => console.error("Автомат цэвэрлэгээ алдаа:", e));
    await checkUpcomingCustomizationDeadlines().catch((e) => console.error("Хугацааны сануулга алдаа:", e)); // ✅ ШИНЭ

    const paymentStatus = req.query.paymentStatus as string | undefined;
    const courierId = req.query.courierId as string | undefined; // ✅ ШИНЭ
    const dateFrom = req.query.dateFrom as string | undefined; // ✅ ШИНЭ — ISO огноо
    const dateTo = req.query.dateTo as string | undefined; // ✅ ШИНЭ — ISO огноо
    // ✅ ШИНЭ: Хүргэлтийн төлвөөр шүүх — таслалаар тусгаарласан жагсаалт,
    // жишээ нь "ASSIGNED,PICKED_UP". Зөвхөн курьераар хүргэдэг (DELIVERY)
    // захиалгад хамаарна (UNASSIGNED нь бүх захиалгын анхдагч утга тул).
    const deliveryStatusParam = req.query.deliveryStatus as string | undefined;
    const sortBy = (req.query.sortBy as string) || "createdAt"; // ✅ ШИНЭ — "createdAt" | "courier"
    const sortDir = (req.query.sortDir as string) === "asc" ? "asc" : "desc"; // ✅ ШИНЭ
    const limit = Math.min(Number(req.query.limit) || 50, 200); // 200-с илүүг зөвшөөрөхгүй

    const where: any = {};
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (courierId) where.courierId = courierId;
    // ✅ ШИНЭ: Хайлт — захиалгын дугаар, харилцагчийн нэр/утас, хүргэлтийн хаягаар
    const search = (req.query.search as string | undefined)?.trim();
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { customer: { name: { contains: search, mode: "insensitive" } } },
        { customer: { phone: { contains: search } } },
        { deliveryAddress: { contains: search, mode: "insensitive" } },
      ];
    }
    if (deliveryStatusParam) {
      const validStatuses = ["UNASSIGNED", "OFFERED", "ASSIGNED", "PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED"];
      const statuses = deliveryStatusParam.split(",").map((x) => x.trim()).filter((x) => validStatuses.includes(x));
      if (statuses.length > 0) {
        where.deliveryMethod = "DELIVERY";
        where.deliveryAssignStatus = { in: statuses };
      }
    }
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // "courier" гэдэг талбараар шууд эрэмблэх боломжгүй (relation) тул
    // courier.name-ээр эрэмбэлнэ; бусад тохиолдолд createdAt-аар.
    const orderBy: any = sortBy === "courier" ? { courier: { name: sortDir } } : { createdAt: sortDir };

    const orders = await prisma.order.findMany({
      where,
      orderBy,
      take: limit,
      include: {
        customer: true,
        courier: { select: { name: true, nickname: true } }, // ✅ ШИНЭ — жагсаалтад хүргэгчийн нэр (nickname-тэй) харуулна
        requestingCourier: { select: { name: true } }, // ✅ ШИНЭ — Курьерийн ӨӨРИЙН илгээмжид
        items: {
          select: { itemType: true, quantity: true, isIssued: true, rentalDetail: { select: { rentalStatus: true } } },
        }, // жагсаалтад "олгосон эсэх" + хугацаа хэтэрсэн эсэхийг тооцоход
      },
    });

    // ✅ ШИНЭ: Хугацаа (neededByDate) хэтэрсэн ч биелээгүй захиалгыг POS дээр
    // улаанаар харуулахад ашиглана.
    const ordersWithOverdue = orders.map((o) => ({ ...o, isOverdue: isOrderOverdue(o) }));

    res.json(ordersWithOverdue);
  } catch (err) {
    console.error("Захиалгын жагсаалт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалгын жагсаалт татаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: GET /api/orders/delivery-summary — Хүргэлтийн төлөв тус бүрийн тоо
// (POS-ийн "самбар") + удаан хүлээлттэй хүргэлтийн тоо.
// ⚠️ "/:id" route-ээс ӨМНӨ байх ёстой (эс бөгөөс "delivery-summary"-г id гэж ойлгоно).
// ============================================================================
router.get("/delivery-summary", async (req: Request, res: Response) => {
  try {
    // Улаанбаатарын (UTC+8) өнөөдрийн эхлэл
    const ubNow = new Date(Date.now() + 8 * 3_600_000);
    const ubTodayStartUtc = new Date(Date.UTC(ubNow.getUTCFullYear(), ubNow.getUTCMonth(), ubNow.getUTCDate()) - 8 * 3_600_000);

    const grouped = await prisma.order.groupBy({
      by: ["deliveryAssignStatus"],
      where: { deliveryMethod: "DELIVERY", paymentStatus: { not: "CANCELLED" }, deliveryAssignStatus: { not: "DELIVERED" } },
      _count: { _all: true },
    });
    const counts: Record<string, number> = { UNASSIGNED: 0, OFFERED: 0, ASSIGNED: 0, PICKED_UP: 0, GIVEN: 0, RETURN_PICKED_UP: 0 };
    for (const g of grouped) counts[g.deliveryAssignStatus] = g._count._all;

    const deliveredToday = await prisma.order.count({
      where: { deliveryMethod: "DELIVERY", deliveryAssignStatus: "DELIVERED", deliveredAt: { gte: ubTodayStartUtc } },
    });

    const staleNotPickedUp = await prisma.order.count({
      where: {
        deliveryAssignStatus: "ASSIGNED",
        deliveryAcceptedAt: { lt: new Date(Date.now() - ASSIGNED_STALE_MINUTES * 60_000) },
        paymentStatus: { not: "CANCELLED" },
      },
    });
    const staleOnTheWay = await prisma.order.count({
      where: {
        deliveryAssignStatus: "PICKED_UP",
        pickedUpAt: { lt: new Date(Date.now() - ON_THE_WAY_STALE_MINUTES * 60_000) },
        paymentStatus: { not: "CANCELLED" },
      },
    });

    res.json({
      counts,
      deliveredToday,
      staleNotPickedUp,
      staleOnTheWay,
      thresholds: { assignedMinutes: ASSIGNED_STALE_MINUTES, onTheWayMinutes: ON_THE_WAY_STALE_MINUTES },
    });
  } catch (err) {
    console.error("Хүргэлтийн самбар татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Хүргэлтийн самбар татаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: Хүргэлтийн баталгаажуулах зураг (курьерийн илгээсэн)
//   GET /api/orders/:id/proofs             — зургийн жагсаалт (зураггүй, зөвхөн мэдээлэл)
//   GET /api/orders/proofs/:proofId/image  — зургийн өөрөө (Staff нэвтрэлттэй)
// ============================================================================
router.get("/:id/proofs", async (req: Request, res: Response) => {
  try {
    const proofs = await prisma.deliveryProof.findMany({
      where: { orderId: req.params.id },
      select: { id: true, stage: true, mimeType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(proofs);
  } catch (err) {
    console.error("Баталгаажуулах зураг татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Зураг татаж чадсангүй" });
  }
});

router.get("/proofs/:proofId/image", async (req: Request, res: Response) => {
  try {
    const proof = await prisma.deliveryProof.findUnique({ where: { id: req.params.proofId } });
    if (!proof) return res.status(404).json({ error: "Зураг олдсонгүй" });
    res.setHeader("Content-Type", proof.mimeType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(proof.imageData));
  } catch (err) {
    console.error("Зураг татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Зураг татаж чадсангүй" });
  }
});

// ============================================================================
// GET /api/orders/print-batch — Шинээр PAID, ХАРААХАН ХЭВЛЭГДЭЭГҮЙ захиалгууд
// ----------------------------------------------------------------------------
// ⚠️ ЗААВАЛ /:id-ийн ӨМНӨ бүртгэгдэх ёстой — эс бөгөөс Express
// "print-batch"-ыг :id гэж андуурч, доорх /:id route рүү явуулна.
//
// Барааны орц (нэр, зураг, өнгө, хэмжээ, тайлбар)-той хамт бүрэн буцаана —
// хэвлэх/бэлтгэх мэдээллийг бүрэн дүүрэн харуулах зорилготой.
// ============================================================================
router.get("/print-batch", async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: { paymentStatus: "PAID", isPrinted: false },
      include: {
        customer: true,
        items: { include: { product: true, rentalDetail: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json(orders);
  } catch (err) {
    console.error("Хэвлэх захиалгуудыг татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга татаж чадсангүй" });
  }
});

// ============================================================================
// POST /api/orders/print-batch/mark-printed — Хэвлэгдсэн гэж тэмдэглэх
// body: { orderIds: string[] }
// ============================================================================
router.post("/print-batch/mark-printed", async (req: Request, res: Response) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "orderIds массив байх ёстой" });
    }

    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { isPrinted: true },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Хэвлэгдсэн гэж тэмдэглэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Тэмдэглэж чадсангүй" });
  }
});

// ============================================================================
// GET /api/orders/:id — Захиалгын дэлгэрэнгүй харах
// ============================================================================
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { product: true, rentalDetail: true } },
        customer: true,
        payments: true,
        courier: true, // ✅ ШИНЭ — Захиалгын дэлгэрэнгүй дээр хүргэгчийн мэдээлэл харуулна
        requestingCourier: true, // ✅ ШИНЭ — Курьерийн ӨӨРИЙН илгээмжид (бүрэн мэдээлэл: утас г.м.)
        offerResponses: { include: { courier: true }, orderBy: { respondedAt: "asc" } }, // ✅ ШИНЭ — хэн алгассан/авсан
      },
    });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });
    res.json({ ...order, isOverdue: isOrderOverdue(order) }); // ✅ ШИНЭ
  } catch (err) {
    console.error("Захиалга татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга татаж чадсангүй" });
  }
});

// ============================================================================
// POST /api/orders/:id/cancel — Захиалга цуцлах
// ----------------------------------------------------------------------------
// Гол хэрэглээ: Барьцаа/төлбөр удаан хугацаанд ирээгүй (хэрэглэгч орхисон)
// захиалгыг цуцлахад ашиглана.
//
// ⚠️ ЧУХАЛ: Захиалгыг цуцлаад л зогсохгүй, ХОЛБОГДОХ RentalDetail бүрийг ч
// CANCELLED болгож УУЛГАХ ёстой — эс бөгөөс тэдгээр нь BOOKED хэвээр
// үлдэж, rental-availability.service.ts-ийн BLOCKING_STATUSES-д ордог тул
// тэр өдрүүд МӨНХӨД "захиалагдсан" гэж хаагдаж, дахин захиалагдах боломжгүй
// болно.
//
// Аль хэдийн PAID/CANCELLED захиалгыг дахин цуцлахыг зөвшөөрөхгүй (700ний
// зөрчлөөс сэргийлнэ) — бүрэн төлөгдсөн захиалгыг буцаах бол өөр процесс
// (буцаалт/refund) ашиглах ёстой.
// ============================================================================
router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    // ✅ ШИНЭ: "Хэзээ хэрэгтэй вэ" 24ц дотор/өнгөрсөн бол баталгаажуулаагүй л
    // бол цуцлахгүй — { error: "NEEDS_CONFIRMATION" } 409-ээр буцаана.
    await cancelOrder(req.params.id, Boolean(req.body?.confirmedOverdueCancel));
    res.json({ success: true });
  } catch (err) {
    if (err instanceof OrderCancellationError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Захиалга цуцлахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга цуцалж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: POST /api/orders/:id/mark-picked-up — Staff курьер БОДИТООР
// дэлгүүрт ирж, барааг гардуулан авсны дараа дардаг товч. Staff биечлэн
// харж байгаа тул OTP шаардлагагүй. Үүнийг дарахгүй бол курьер
// "Хүргэсэн/Өгсөн" гэж баталгаажуулах боломжгүй (дэс дараалал ЗААВАЛ).
// ============================================================================
router.post("/:id/mark-picked-up", async (req: Request, res: Response) => {
  try {
    const order = await markPickedUp(req.params.id);
    res.json(order);
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(409).json({ error: err.message });
    console.error("Дэлгүүрээс авсан гэж тэмдэглэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Тэмдэглэж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: POST /api/orders/:id/confirm-returned-to-shop — Staff курьер
// ТҮРЭЭСИЙН барааг дэлгүүрт БОДИТООР буцааж авчирсны дараа дардаг товч.
// Барьцаа буцаалт/гэмтлийн торгуулийг дэлгүүрт биечлэн буцаасантай ЯГ
// АДИЛААР (processReturn) тооцно.
// body: { damageFee?: number, damageNote?: string }
// ============================================================================
router.post("/:id/confirm-returned-to-shop", async (req: Request, res: Response) => {
  try {
    const { damageFee, damageNote } = req.body;
    const order = await confirmReturnedToShop(req.params.id, Number(damageFee) || 0, damageNote);
    res.json(order);
  } catch (err) {
    if (err instanceof DeliveryAssignmentError) return res.status(409).json({ error: err.message });
    console.error("Буцаалт баталгаажуулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Баталгаажуулж чадсангүй" });
  }
});

// ============================================================================
// POST /api/orders/:id/pay/manual — Гараар захиалгын төлбөр баталгаажуулах
// body: { method: "CASH"|"BANK_TRANSFER", note?: string }
// ----------------------------------------------------------------------------
// QPay/SocialPay webhook-гүйгээр — кассчин бэлэн мөнгө авсан эсвэл
// дансаар шилжүүлэлт хийгдсэнийг харсны дараа ашиглана.
// ============================================================================
router.post("/:id/pay/manual", async (req: Request, res: Response) => {
  try {
    const { method, note, combinedDepositRentalIds } = req.body;
    await markOrderPaidManually(req.params.id, {
      method: method as PaymentMethod,
      note,
      combinedDepositRentalIds,
    });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof OrderPaymentError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Гараар төлбөр баталгаажуулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Төлбөр бүртгэж чадсангүй" });
  }
});

// ============================================================================
// POST /api/orders/:id/issue — Захиалгын БҮХ SALE барааг "олгогдсон" болгох
// ----------------------------------------------------------------------------
// Гол хэрэглээ: ONLINE захиалга (урьдчилж төлсөн ч, биечлэн ирж аваагүй)
// хэрэглэгч ирж бараагаа авахад кассчин дарна. POS захиалгад ихэвчлэн
// шаардлагагүй (төлбөр орсон дор дор олгодог тул автоматаар true болдог).
// ============================================================================
router.post("/:id/issue", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    const now = new Date();
    await prisma.orderItem.updateMany({
      where: { orderId: order.id, itemType: "SALE" },
      data: { isIssued: true, issuedAt: now },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Бараа олгоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Бараа олгож чадсангүй" });
  }
});

// ============================================================================
// PATCH /api/orders/:id/status — Захиалгын төлвийг ГАРААР солих
// body: { paymentStatus: "PENDING"|"PARTIALLY_PAID"|"PAID"|"REFUNDED"|"CANCELLED" }
// ----------------------------------------------------------------------------
// ⚠️ ЭНЭ endpoint ЗӨВХӨН Order.paymentStatus талбарыг л шууд солино —
// applyOrderPayment()-ийн НӨӨЦ буулгах/realtime мэдэгдэх зэрэг АЖ ТӨРСӨН
// ҮР ДАГАВРЫГ дагуулахгүй. Кассчны алдааг ГАРААР засах зориулалттай хэрэгсэл
// тул болгоомжтой ашиглана уу.
// ============================================================================
const VALID_STATUSES = ["PENDING", "PARTIALLY_PAID", "PAID", "REFUNDED", "CANCELLED"];

router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const { paymentStatus, method } = req.body;
    if (!VALID_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({ error: `paymentStatus нь ${VALID_STATUSES.join(", ")}-ийн аль нэг байх ёстой` });
    }

    // ✅ ЗАСВАР: "PAID" сонговол ЗӨВХӨН статусыг л соливол зогсохгүй —
    // markOrderPaidManually()-г дуудаж, Payment мөр үүсгэж, paidAmount-ыг
    // зөв тооцож, барааны нөөцийг ч буулгана. Эс бөгөөс "Төлбөрийн түүх"
    // хоосон үлдэж, кассчин "юу ч бүртгэгдээгүй юм шиг" харж байсан.
    if (paymentStatus === "PAID") {
      await markOrderPaidManually(req.params.id, {
        method: (method as PaymentMethod) ?? PaymentMethod.CASH,
        note: "Захиалгын түүхээс гараар PAID болгосон",
      });
    } else {
      await prisma.order.update({
        where: { id: req.params.id },
        data: { paymentStatus },
      });
    }

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    res.json(order);
  } catch (err) {
    if (err instanceof OrderPaymentError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Төлөв солиход алдаа гарлаа:", err);
    res.status(500).json({ error: "Төлөв солиж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: PATCH /api/orders/:id/package-size — Staff ачааны хэмжээг
// тохируулна (курьерт барааны нэрийн оронд харуулна).
// body: { packageSize: "SMALL" | "MEDIUM" | "LARGE" }
// ============================================================================
router.patch("/:id/package-size", async (req: Request, res: Response) => {
  try {
    const { packageSize } = req.body;
    if (!["SMALL", "MEDIUM", "LARGE"].includes(packageSize)) {
      return res.status(400).json({ error: "packageSize нь SMALL, MEDIUM, LARGE-ийн аль нэг байх ёстой" });
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { packageSize },
    });

    // ✅ ЗАСВАР: Захиалга аль хэдийн курьерт оноогдсон бол (жишээ нь Staff
    // хэмжээг дараа нь өөрчилсөн) курьерийн апп-д ШУУД мэдэгдэнэ.
    if (order.courierId) {
      emitToCourier(order.courierId, "delivery_detail_updated", { orderId: order.id }); // ✅ Ерөнхий "дэлгэрэнгүй шинэчлэгдлээ" event
    }

    res.json(order);
  } catch (err) {
    console.error("Ачааны хэмжээ тохируулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Тохируулж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: PATCH /api/orders/:id/courier-fee-paid — Staff хүргэгчид
// хүргэлтийн шимтгэлийг ТӨЛСӨН/ТӨЛӨӨГҮЙ гэж тэмдэглэнэ. Захиалгын
// (харилцагчийн) төлбөртэй ХОЛБООГҮЙ.
// body: { paid: true | false }
// ============================================================================
router.patch("/:id/courier-fee-paid", async (req: Request, res: Response) => {
  try {
    const { paid } = req.body;
    if (typeof paid !== "boolean") {
      return res.status(400).json({ error: "paid нь true/false байх ёстой" });
    }

    // ✅ ШИНЭ: Оройн багц тооцоонд орсон хөлсийг энд гараар буцаавал багцын нийлбэр зөрнө — хориглоно
    if (!paid) {
      const existing = await prisma.order.findUnique({ where: { id: req.params.id }, select: { courierPayoutId: true } });
      if (existing?.courierPayoutId) {
        return res.status(400).json({ error: "Энэ хөлс оройн багц тооцоонд орсон тул гараар буцаах боломжгүй" });
      }
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { courierFeePaid: paid, courierFeePaidAt: paid ? new Date() : null },
    });

    // ✅ ЗАСВАР: Дутуу байсан — Курьерийн апп-д ШУУД мэдэгдэж, "Миний
    // хүргэлт" дэлгэц автоматаар шинэчлэгдэж, "Танд төлсөн" гэж харагдана.
    if (order.courierId) {
      emitToCourier(order.courierId, "delivery_detail_updated", { orderId: order.id, paid });
    }

    res.json(order);
  } catch (err) {
    console.error("Хүргэгчид төлбөр тэмдэглэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Тэмдэглэж чадсангүй" });
  }
});

// ============================================================================
// DELETE /api/orders/:id — Захиалгыг БҮРЭН устгах (cascading)
// ----------------------------------------------------------------------------
// ⚠️ ЭНЭ БОЛ ЭРГЭЖ БУЦАХГҮЙ, ХАТУУ (hard) УСТГАЛТ. Холбогдох
// GatewayTransaction, Payment, RentalDetail, OrderItem бүгдийг эхлээд
// устгаад, эцэст нь Order-оо устгана (FK зөрчил гарахгүйн тулд дараалал
// чухал). Санхүүгийн түүхээ хадгалмаар бол үүний оронд "CANCELLED" төлөв
// рүү шилжүүлэхийг (cancel endpoint) зөвлөнө — устгалт нь ТҮҮХЭЭ бүрмөсөн
// арилгадаг.
// ============================================================================
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { rentalDetail: true } } },
    });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    await prisma.$transaction(
      async (tx) => {
        await tx.gatewayTransaction.deleteMany({ where: { orderId: order.id } });
        await tx.payment.deleteMany({ where: { orderId: order.id } });
        await tx.deliveryOfferResponse.deleteMany({ where: { orderId: order.id } }); // ✅ ЗАСВАР — дутуу байсан

        for (const item of order.items) {
          if (item.rentalDetail) {
            await tx.gatewayTransaction.deleteMany({ where: { rentalDetailId: item.rentalDetail.id } });
            await tx.rentalDetail.delete({ where: { id: item.rentalDetail.id } });
          }
        }

        await tx.orderItem.deleteMany({ where: { orderId: order.id } });
        await tx.order.delete({ where: { id: order.id } });
      },
      { timeout: 15000 } // ✅ ШИНЭ
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Захиалга устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга устгаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: POST /api/orders/bulk-delete — Хэсэгчлэн сонгосон олон
// захиалгыг НЭГ дор устгана. DELETE /:id-тэй ИЖИЛ cascading логик, зөвхөн
// олон захиалгаар давтана.
// body: { orderIds: string[] }
// ============================================================================
router.post("/bulk-delete", async (req: Request, res: Response) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "orderIds массив заавал шаардлагатай" });
    }
    if (orderIds.length > 100) {
      return res.status(400).json({ error: "Нэг дор 100-аас дээшгүй захиалга устгах боломжтой" });
    }

    let deletedCount = 0;
    const failedIds: string[] = [];

    for (const orderId of orderIds) {
      try {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { items: { include: { rentalDetail: true } } },
        });
        if (!order) {
          failedIds.push(orderId);
          continue;
        }

        await prisma.$transaction(
          async (tx) => {
            await tx.gatewayTransaction.deleteMany({ where: { orderId: order.id } });
            await tx.payment.deleteMany({ where: { orderId: order.id } });
            await tx.deliveryOfferResponse.deleteMany({ where: { orderId: order.id } });

            for (const item of order.items) {
              if (item.rentalDetail) {
                await tx.gatewayTransaction.deleteMany({ where: { rentalDetailId: item.rentalDetail.id } });
                await tx.rentalDetail.delete({ where: { id: item.rentalDetail.id } });
              }
            }

            await tx.orderItem.deleteMany({ where: { orderId: order.id } });
            await tx.order.delete({ where: { id: order.id } });
          },
          { timeout: 15000 }
        );
        deletedCount++;
      } catch (err) {
        console.error(`Захиалга ${orderId} устгахад алдаа гарлаа:`, err);
        failedIds.push(orderId);
      }
    }

    res.json({ success: true, deletedCount, failedIds });
  } catch (err) {
    console.error("Олноор устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Олноор устгаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: POST /api/orders/:id/errand-refund — Курьерийн илгээмжийн буцаалтыг
// Staff ГАРААР (бэлнээр/дансаар) буцааж дууссаны дараа НЭГ товчоор бүртгэнэ.
// body: { method: "CASH" | "BANK_TRANSFER", note?: string }
// ============================================================================
router.post("/:id/errand-refund", async (req: Request, res: Response) => {
  try {
    const amount = await completeErrandRefund(req.params.id, req.body?.method, req.body?.note);
    res.json({ success: true, amount });
  } catch (err) {
    if (err instanceof ErrandError) return res.status(400).json({ error: err.message });
    console.error("Илгээмжийн буцаалт бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Буцаалт бүртгэж чадсангүй" });
  }
});

// ✅ ШИНЭ: POST /api/orders/:id/tracking-link — Staff энэ захиалгыг хүргэж яваа курьерийг газрын зураг дээр
// харах холбоос (12 цаг). Хүргэлт дууссан бол хуудас "Хүргэлт дууссан" гэж харуулна.
// ✅ ШИНЭ: Апп доторх газрын зурагт — нэг захиалгыг хүргэж яваа курьерийн бодит байршил (Staff).
router.get("/:id/tracking", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await fetchLiveSnapshot({ kind: "order", orderId: req.params.id }));
  } catch (err) {
    if (err instanceof TrackingTokenError) return res.status(404).json({ error: err.message });
    console.error("Захиалгын байршил татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: POST /api/orders/:id/customer-tracking-link — Staff харилцагчид (Instagram/Facebook чатаар) илгээх
// ЗАХИАЛГЫН ХЯНАЛТЫН холбоос (60 хоног). .env-д STOREFRONT_BASE_URL (storefront-ын хаяг) тохируулсан бол бүтэн url буцаана.
router.post("/:id/customer-tracking-link", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true, orderType: true } });
    if (!order || order.orderType === "COURIER_ERRAND") return res.status(404).json({ error: "Захиалга олдсонгүй" });
    const token = signCustomerToken(order.id);
    const link = buildStorefrontLink(process.env.STOREFRONT_BASE_URL, token);
    res.json({ token, url: link.url, hint: link.hint }); // hint — url үүсээгүй шалтгаан (буруу/хоосон тохиргоо)
  } catch (err) {
    console.error("Харилцагчийн хяналтын холбоос үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Холбоос үүсгэж чадсангүй" });
  }
});

router.post("/:id/tracking-link", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });
    res.json({ url: buildTrackingUrl(req, { kind: "order", orderId: order.id }) });
  } catch (err) {
    console.error("Байршлын холбоос үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Холбоос үүсгэж чадсангүй" });
  }
});

export default router;
