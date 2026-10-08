// ============================================================================
// SELLER PORTAL CONTROLLER — /api/seller-portal (худалдагчийн тусдаа жижиг портал, seller.html)
//   POST /login                   { slug, pin } → { token }
//   GET  /me                      нэр, комисс, хүлээгдэж буй захиалгын тоо
//   GET  /orders                  ЗӨВХӨН өөрийн захиалгууд (харилцагчийн мэдээлэлгүй), авах КОД-той
//   POST /orders/:id/accept|ready|reject
//   GET  /earnings                олгогдох / хүлээлтэд / өмнө олгосон мөнгө
//   GET  /products, PATCH /products/:id   өөрийн барааны үнэ, нөөц, харуулах/нуух
//   GET/POST /listings, DELETE /listings/:id   шинэ бараа нэмэх хүсэлт (Staff батлана)
// ============================================================================

import express, { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { SellerPortalError, loginSeller, authenticateSeller, getPortalMe } from "../services/seller-portal.service";
import { SellerOrderError, listPortalOrders, acceptSellerOrder, markSellerOrderReady, rejectSellerOrder } from "../services/seller-order.service";
import { SellerSettlementError } from "../lib/seller-settlement";
import { getSellerEarnings } from "../services/seller-settlement.service";
import { SellerProductError } from "../lib/seller-product";
import { ListingError } from "../lib/listing-request";
import { UploadError, getImageStore, saveUploadedImage } from "../lib/image-upload";
import { DailyQuota } from "../lib/upload-quota";
import { createListingRequest, listSellerListingRequests, withdrawListingRequest } from "../services/listing-request.service";
import { listSellerProducts, updateSellerProduct } from "../services/seller-product.service";
import { FeaturedError } from "../lib/featured";
import { cancelOwnPromotion, getSellerFeatured, refreshGatewayPayment, reportBankTransfer, requestPromotion, startGatewayPayment } from "../services/featured.service";

declare global {
  namespace Express {
    interface Request {
      seller?: { id: string; name: string };
    }
  }
}

const router = Router();

const loginIpLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." } });
const apiIpLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." } });

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof SellerPortalError || err instanceof SellerOrderError || err instanceof SellerSettlementError || err instanceof SellerProductError || err instanceof ListingError || err instanceof UploadError || err instanceof FeaturedError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

router.post("/login", loginIpLimiter, async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await loginSeller(req.body?.slug, req.body?.pin));
  } catch (err) {
    fail(err, res, "Нэвтэрч");
  }
});

async function requireSellerAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "Нэвтрэх шаардлагатай" });
  try {
    req.seller = await authenticateSeller(h.slice("Bearer ".length));
    next();
  } catch (err) {
    fail(err, res, "Нэвтрэлт шалгаж");
  }
}

router.use(apiIpLimiter, requireSellerAuth);

router.get("/me", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getPortalMe(req.seller!.id));
  } catch (err) {
    fail(err, res, "Мэдээлэл татаж");
  }
});

router.get("/orders", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listPortalOrders(req.seller!.id));
  } catch (err) {
    fail(err, res, "Захиалга татаж");
  }
});

router.post("/orders/:id/accept", async (req: Request, res: Response) => {
  try {
    res.json(await acceptSellerOrder(req.params.id, req.seller!.id));
  } catch (err) {
    fail(err, res, "Зөвшөөрч");
  }
});

router.post("/orders/:id/ready", async (req: Request, res: Response) => {
  try {
    res.json(await markSellerOrderReady(req.params.id, req.seller!.id));
  } catch (err) {
    fail(err, res, "Бэлэн болгож");
  }
});

router.post("/orders/:id/reject", async (req: Request, res: Response) => {
  try {
    res.json(await rejectSellerOrder(req.params.id, req.body?.reason, req.seller!.id));
  } catch (err) {
    fail(err, res, "Татгалзаж");
  }
});

router.get("/products", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listSellerProducts(req.seller!.id));
  } catch (err) {
    fail(err, res, "Бараа татаж");
  }
});

// Худалдагч ЗӨВХӨН өөрийн барааны үнэ, нөөц, харуулах/нуухыг засна
router.patch("/products/:id", async (req: Request, res: Response) => {
  try {
    res.json(await updateSellerProduct(req.seller!.id, req.params.id, req.body));
  } catch (err) {
    fail(err, res, "Бараа засаж");
  }
});

// ✅ ШИНЭ: Шинэ бараа нэмэх хүсэлт (Staff баталгаажуулна)
router.get("/listings", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listSellerListingRequests(req.seller!.id));
  } catch (err) {
    fail(err, res, "Хүсэлт татаж");
  }
});

router.post("/listings", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createListingRequest(req.seller!.id, req.body));
  } catch (err) {
    fail(err, res, "Хүсэлт илгээж");
  }
});

router.delete("/listings/:id", async (req: Request, res: Response) => {
  try {
    res.json(await withdrawListingRequest(req.seller!.id, req.params.id));
  } catch (err) {
    fail(err, res, "Хүсэлт буцааж");
  }
});

// ✅ ШИНЭ: Худалдагч зураг файлаар оруулах (хөтөч дээр шахсан зураг). Нэг худалдагч өдөрт хязгаартай; шалгалтад унасан файл квот идэхгүй.
const uploadQuota = new DailyQuota(Number(process.env.SELLER_UPLOAD_DAILY_LIMIT) || 60);
router.post("/uploads/image", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb" }), async (req: Request, res: Response) => {
  const key = req.seller!.id;
  if (!uploadQuota.consume(key)) return res.status(429).json({ error: "Өнөөдрийн зураг оруулах хязгаар хэтэрлээ — маргааш дахин оролдоно уу" });
  try {
    res.status(201).json(await saveUploadedImage(getImageStore(), req.body));
  } catch (err) {
    uploadQuota.refund(key);
    fail(err, res, "Зураг оруулж");
  }
});

// ✅ ШИНЭ: Онцлох байрлал (урьдчилж төлнө). Багц, төлбөрийн заавар, миний зарууд / захиалах / цуцлах.
router.get("/featured", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSellerFeatured(req.seller!.id));
  } catch (err) {
    fail(err, res, "Онцлох зар татаж");
  }
});

router.post("/featured/requests", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await requestPromotion(req.seller!.id, req.body));
  } catch (err) {
    fail(err, res, "Онцлох зар захиалж");
  }
});

// ✅ ШИНЭ: Зөвшөөрөгдсөн зарыг QPay-ээр төлөх (бараа захиалахтай ижил), төлөв шалгах, дансаар шилжүүлснээ мэдэгдэх
router.post("/featured/:id/pay-qpay", async (req: Request, res: Response) => {
  try { res.json(await startGatewayPayment(req.seller!.id, req.params.id, req.body?.provider)); } catch (err) { fail(err, res, "Төлбөрийн нэхэмжлэх үүсгэж"); }
});
router.get("/featured/:id/payment-status", async (req: Request, res: Response) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json(await refreshGatewayPayment(req.seller!.id, req.params.id)); } catch (err) { fail(err, res, "Төлөв шалгаж"); }
});
router.post("/featured/:id/report-transfer", async (req: Request, res: Response) => {
  try { res.json(await reportBankTransfer(req.seller!.id, req.params.id)); } catch (err) { fail(err, res, "Төлбөр мэдэгдэж"); }
});

router.delete("/featured/:id", async (req: Request, res: Response) => {
  try {
    res.json(await cancelOwnPromotion(req.seller!.id, req.params.id));
  } catch (err) {
    fail(err, res, "Онцлох зар цуцалж");
  }
});

router.get("/earnings", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSellerEarnings(req.seller!.id));
  } catch (err) {
    fail(err, res, "Орлого татаж");
  }
});

export default router;
