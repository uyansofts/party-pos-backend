// ============================================================================
// RENTAL CONTROLLER (TypeScript)
// ============================================================================

import { Router, Request, Response } from "express";
import { checkAvailability, reserveRentalSafely, RentalUnavailableError } from "../services/rental-availability.service";
import { markAsPickedUp, processReturn, markDepositHeldManually, RentalLifecycleError } from "../services/deposit.service";
import { requireAuth } from "../middleware/auth.middleware";
import { prisma } from "../lib/prisma";

const router = Router();
router.use(requireAuth); // Энэ router-ийн БҮХ route Staff нэвтрэлт шаардана

// POST /api/rentals/check-availability
// body: { productId, startDate, endDate, quantity }
router.post("/check-availability", async (req: Request, res: Response) => {
  try {
    const { productId, startDate, endDate, quantity } = req.body;

    if (!productId || !startDate || !endDate) {
      return res.status(400).json({ error: "productId, startDate, endDate заавал байх ёстой" });
    }

    const result = await checkAvailability({
      productId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      requestedQty: quantity || 1,
    });

    res.json(result);
  } catch (err) {
    console.error("Боломж шалгахад алдаа гарлаа:", err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/rentals/reserve
// body: { orderItemId, productId, startDate, endDate, dailyRate, depositAmount }
// ---------------------------------------------------------------------------
// Энэ endpoint нь ЯГ ЗАХИАЛГА баталгаажих мөчид дуудагдана (сагсанд нэмэх
// биш) — advisory lock ашигладаг тул давхар захиалгаас хамгаалагдсан.
// ---------------------------------------------------------------------------
router.post("/reserve", async (req: Request, res: Response) => {
  try {
    const { orderItemId, productId, startDate, endDate, dailyRate, depositAmount } = req.body;

    if (!orderItemId || !productId || !startDate || !endDate) {
      return res.status(400).json({ error: "Шаардлагатай талбарууд дутуу байна" });
    }

    const rentalDetail = await reserveRentalSafely({
      orderItemId,
      productId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      dailyRate,
      depositAmount,
    });

    res.status(201).json(rentalDetail);
  } catch (err) {
    if (err instanceof RentalUnavailableError) {
      return res.status(409).json({
        error: "Уучлаарай, энэ хугацаанд бараа дутуу байна",
        availableQty: err.availableQty,
      });
    }
    console.error("Түрээс захиалахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Түрээс захиалж чадсангүй" });
  }
});

// ============================================================================
// POST /api/rentals/:id/pickup — Барааг хэрэглэгчид гардуулах
// ----------------------------------------------------------------------------
// Зөвхөн барьцаа мөнгө (depositStatus=HELD) баталгаажсаны дараа л дуудна.
// Кассын дэлгэц дээр "Гардуулах" товч дарахад ЭНЭ endpoint дуудагдана.
// ============================================================================
router.post("/:id/pickup", async (req: Request, res: Response) => {
  try {
    const rentalDetail = await markAsPickedUp(req.params.id);
    res.json(rentalDetail);
  } catch (err) {
    if (err instanceof RentalLifecycleError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Гардуулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Гардуулж чадсангүй" });
  }
});

// ============================================================================
// POST /api/rentals/:id/deposit/manual — Гараар барьцаа бүртгэх
// body: { depositType: "MONEY"|"DOCUMENT", method?: "CASH"|..., documentDescription?: string }
// ----------------------------------------------------------------------------
// QPay/SocialPay webhook-гүйгээр — кассчин бэлэн мөнгө авсан эсвэл
// Иргэний үнэмлэх/бусад бичиг баримт биетээр барьцаалсан үед ашиглана.
// ============================================================================
router.post("/:id/deposit/manual", async (req: Request, res: Response) => {
  try {
    const { depositType, method, documentDescription } = req.body;
    const rentalDetail = await markDepositHeldManually(req.params.id, { depositType, method, documentDescription });
    res.json(rentalDetail);
  } catch (err) {
    if (err instanceof RentalLifecycleError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Гараар барьцаа бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Барьцаа бүртгэж чадсангүй" });
  }
});

// ============================================================================
// POST /api/rentals/:id/return — Барааг буцааж авах
// body: { actualReturn?: string (өгөгдөөгүй бол одоо цаг), damageFee?, damageNote? }
// ----------------------------------------------------------------------------
// Хожимдол, гэмтлийг тооцож depositRefundAmount-ыг автоматаар тодорхойлно.
// Дараа нь бодит мөнгийг (CASH/SocialPay) кассчин гараар буцаана.
// ============================================================================
router.post("/:id/return", async (req: Request, res: Response) => {
  try {
    const { actualReturn, damageFee, damageNote } = req.body;

    const rentalDetail = await processReturn(req.params.id, {
      actualReturn: actualReturn ? new Date(actualReturn) : new Date(),
      damageFee: damageFee ?? 0,
      damageNote,
    });

    res.json(rentalDetail);
  } catch (err) {
    if (err instanceof RentalLifecycleError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Буцаалт хийхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Буцаалт хийж чадсангүй" });
  }
});

// ============================================================================
// GET /api/rentals — Идэвхтэй/захиалагдсан түрээсийн жагсаалт
// query: ?status=BOOKED,ACTIVE (заавал биш, өгөгдөөгүй бол BOOKED+ACTIVE+OVERDUE)
// ----------------------------------------------------------------------------
// Кассчин ЭНЭ жагсаалтаас бараа сонгоод "Гардуулах"/"Буцаах" товч дарна.
// ============================================================================
router.get("/", async (req: Request, res: Response) => {
  try {
    const statusParam = req.query.status as string | undefined;
    const statuses = statusParam ? statusParam.split(",") : ["BOOKED", "ACTIVE", "OVERDUE"];

    const rentals = await prisma.rentalDetail.findMany({
      where: { rentalStatus: { in: statuses as any } },
      include: {
        orderItem: {
          include: { product: true, order: { include: { customer: true } } },
        },
      },
      orderBy: { startDate: "asc" },
    });

    res.json(rentals);
  } catch (err) {
    console.error("Түрээсийн жагсаалт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Жагсаалт татаж чадсангүй" });
  }
});

export default router;
