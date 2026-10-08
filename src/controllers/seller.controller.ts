// ============================================================================
// SELLER CONTROLLER — /api/sellers (Staff). Худалдагч нэмэх, засах, идэвхжүүлэх/түдгэлзүүлэх.
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { SellerError, listSellers, createSeller, updateSeller, setSellerStatus } from "../services/seller.service";
import { SellerPortalError, resetSellerPortalPin } from "../services/seller-portal.service";
import { SellerSettlementError } from "../lib/seller-settlement";
import { prisma } from "../lib/prisma";
import { ListingError } from "../lib/listing-request";
import { listListingRequests, approveListingRequest, rejectListingRequest } from "../services/listing-request.service";
import { getSellerSettlementSummary, getSellerUnpaid, paySellerBatch, getSellerPayoutHistory, payAllSellers } from "../services/seller-settlement.service";

const router = Router();
router.use(requireAuth);

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof SellerError || err instanceof SellerPortalError || err instanceof SellerSettlementError || err instanceof ListingError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

// ✅ ШИНЭ: Худалдагчийн порталын PIN үүсгэх/сэргээх — PIN-г ЗӨВХӨН ЭНД НЭГ л удаа харуулна (bcrypt-ээр хадгалагдана)
router.post("/:id/portal-pin", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await resetSellerPortalPin(req.params.id));
  } catch (err) {
    fail(err, res, "PIN үүсгэж");
  }
});

// ✅ ШИНЭ: Marketplace асаалттай эсэх (POS анхааруулга харуулахад) — унтраатай үед худалдагчийн бараа storefront-д ХАРАГДАХГҮЙ
router.get("/marketplace-status", async (_req: Request, res: Response) => {
  try {
    const row = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    res.json({ enabled: Boolean((row as any)?.marketplaceEnabled) });
  } catch (err) {
    fail(err, res, "Marketplace-ийн төлөв татаж");
  }
});

// ✅ ШИНЭ: ШИНЭ БАРАА НЭМЭХ ХҮСЭЛТ — Staff шалгаж батлах/татгалзах
router.get("/listings", async (req: Request, res: Response) => {
  try {
    res.json(await listListingRequests(typeof req.query.status === "string" ? req.query.status : undefined));
  } catch (err) {
    fail(err, res, "Хүсэлтүүд татаж");
  }
});

router.post("/listings/:id/approve", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await approveListingRequest(req.params.id, req.body));
  } catch (err) {
    fail(err, res, "Батлаж");
  }
});

router.post("/listings/:id/reject", async (req: Request, res: Response) => {
  try {
    res.json(await rejectListingRequest(req.params.id, req.body?.reason));
  } catch (err) {
    fail(err, res, "Татгалзаж");
  }
});

// ✅ ШИНЭ: ХУДАЛДАГЧИД МӨНГӨ ОЛГОХ (бараа − комисс, хүлээлтийн хугацаатай, багцаар)
// ✅ ШИНЭ: БҮХ худалдагчид нэг дор олгох (Staff мөнгийг шилжүүлсний дараа бүртгэнэ). :id-тай маршрутаас ӨМНӨ байх ёстой.
router.post("/payouts/pay-all", async (req: Request, res: Response) => {
  try {
    res.json(await payAllSellers(req.body?.method, req.body?.note));
  } catch (err) {
    fail(err, res, "Нэг дор олгож");
  }
});

router.get("/payouts/summary", async (_req: Request, res: Response) => {
  try {
    res.json(await getSellerSettlementSummary());
  } catch (err) {
    fail(err, res, "Тооцоо татаж");
  }
});

router.get("/:id/payouts/unpaid", async (req: Request, res: Response) => {
  try {
    res.json(await getSellerUnpaid(req.params.id));
  } catch (err) {
    fail(err, res, "Олгох жагсаалт татаж");
  }
});

router.get("/:id/payouts/history", async (req: Request, res: Response) => {
  try {
    res.json(await getSellerPayoutHistory(req.params.id));
  } catch (err) {
    fail(err, res, "Түүх татаж");
  }
});

router.post("/:id/payouts", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await paySellerBatch(req.params.id, req.body?.orderIds, req.body?.method, req.body?.note));
  } catch (err) {
    fail(err, res, "Олголт бүртгэж");
  }
});

router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listSellers());
  } catch (err) {
    fail(err, res, "Худалдагчийн жагсаалт татаж");
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createSeller(req.body));
  } catch (err) {
    fail(err, res, "Худалдагч үүсгэж");
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    res.json(await updateSeller(req.params.id, req.body));
  } catch (err) {
    fail(err, res, "Худалдагч засаж");
  }
});

router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    res.json(await setSellerStatus(req.params.id, req.body?.status));
  } catch (err) {
    fail(err, res, "Төлөв өөрчилж");
  }
});

export default router;
