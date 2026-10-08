// ============================================================================
// CUSTOMER TRACKING CONTROLLER — Storefront-ын "Захиалга хянах" хуудасны API (нэвтрэлтгүй, токентой).
//   POST /api/public/order-tracking/lookup        { orderNumber, phone } → { token }
//   GET  /api/public/order-tracking/:token        → хяналтын мэдээлэл (5-10 сек тутам татна)
//   POST /api/public/order-tracking/:token/rate   { stars, comment? }
//   POST /api/public/order-tracking/:token/review { productId, stars, comment? }   ← барааны үнэлгээ
//   POST /api/public/order-tracking/:token/cancel
// ============================================================================

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { CustomerTrackingError, verifyCustomerToken } from "../lib/customer-tracking";
import { getCustomerView, lookupCustomerToken, rateAsCustomer } from "../services/customer-tracking.service";
import { ReviewError } from "../lib/reviews";
import { submitProductReview } from "../services/review.service";
import { cancelOrder, OrderCancellationError } from "../services/order.service";
import { buildTrackingUrl } from "./tracking.controller";

export const customerTrackingRouter = Router();

const lookupLimiterIp = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});

const viewLimiterIp = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof CustomerTrackingError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

customerTrackingRouter.post("/lookup", lookupLimiterIp, async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await lookupCustomerToken(req.body?.orderNumber, req.body?.phone));
  } catch (err) {
    fail(err, res, "Захиалга хайж");
  }
});

customerTrackingRouter.get("/:token", viewLimiterIp, async (req: Request, res: Response) => {
  try {
    const orderId = verifyCustomerToken(req.params.token);
    const view = await getCustomerView(orderId);
    // Хүргэж яваа үед газрын зургийн холбоос (энэ ЗӨВХӨН нэг захиалгын хүргэгчийг харуулдаг, nickname-тэй)
    if (view.map.available) view.map.url = buildTrackingUrl(req, { kind: "order", orderId });
    res.setHeader("Cache-Control", "no-store");
    res.json(view);
  } catch (err) {
    fail(err, res, "Захиалга татаж");
  }
});

customerTrackingRouter.post("/:token/rate", viewLimiterIp, async (req: Request, res: Response) => {
  try {
    const orderId = verifyCustomerToken(req.params.token);
    res.json({ success: true, ...(await rateAsCustomer(orderId, req.body?.stars, req.body?.comment)) });
  } catch (err) {
    fail(err, res, "Үнэлгээ бүртгэж");
  }
});

// ✅ ШИНЭ: Барааг үнэлэх (Etsy шиг) — хүлээн авсан бараа бүрт нэг үнэлгээ, 30 хоногийн дотор засна
customerTrackingRouter.post("/:token/review", viewLimiterIp, async (req: Request, res: Response) => {
  try {
    const orderId = verifyCustomerToken(req.params.token);
    res.json({ success: true, ...(await submitProductReview(orderId, req.body?.productId, req.body?.stars, req.body?.comment)) });
  } catch (err) {
    if (err instanceof ReviewError) return res.status(err.status).json({ error: err.message });
    fail(err, res, "Үнэлгээ бүртгэж");
  }
});

customerTrackingRouter.post("/:token/cancel", viewLimiterIp, async (req: Request, res: Response) => {
  try {
    const orderId = verifyCustomerToken(req.params.token);
    await cancelOrder(orderId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof OrderCancellationError) return res.status(409).json({ error: err.message });
    fail(err, res, "Захиалга цуцалж");
  }
});
