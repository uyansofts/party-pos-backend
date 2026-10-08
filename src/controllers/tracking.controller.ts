// ============================================================================
// TRACKING CONTROLLER — Бодит цагийн байршлын газрын зургийн хуудас болон түүний өгөгдөл.
//   GET /track?t=<токен>          — газрын зургийн хуудас (HTML)
//   GET /api/track/data?t=<токен> — 5 сек тутам татах JSON snapshot
// Токеныг зөвхөн нэвтэрсэн Staff / админ курьер / илгээмжийн илгээгч үүсгэнэ (buildTrackingUrl).
// ============================================================================

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { verifyTrackingToken, signTrackingToken, TrackingTokenError, TrackingScope } from "../lib/live-tracking";
import { fetchLiveSnapshot } from "../services/live-tracking.service";
import { TRACKING_PAGE_HTML } from "../lib/tracking-page";

export const trackingRouter = Router();

// Хуудас 5 сек тутам татах тул (12/мин) хэд хэдэн үзэгчтэйг тооцож минутад 90.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});

trackingRouter.get("/track", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // "origin": tile сервер/CDN-д ЗӨВХӨН хаяг (https://host/) явна — токен агуулсан зам/query ЯВАХГҮЙ (алдагдахгүй).
  // ("no-referrer" байсан үед OpenStreetMap Referer-гүй хүсэлтийг 403-аар хаасан.)
  res.setHeader("Referrer-Policy", "origin");
  res.send(TRACKING_PAGE_HTML);
});

trackingRouter.get("/api/track/data", trackLimiter, async (req: Request, res: Response) => {
  try {
    const scope = verifyTrackingToken(String(req.query.t ?? ""));
    const snapshot = await fetchLiveSnapshot(scope);
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  } catch (err) {
    if (err instanceof TrackingTokenError) return res.status(401).json({ error: err.message });
    console.error("Байршлын snapshot татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Байршил татаж чадсангүй" });
  }
});

/** Нэвтэрсэн хэрэглэгчид зориулсан газрын зургийн холбоос (12 цагийн хугацаатай). */
export function buildTrackingUrl(req: Request, scope: TrackingScope): string {
  const token = signTrackingToken(scope);
  const forwarded = (req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim();
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || `${forwarded}://${req.get("host")}`;
  return `${base}/track?t=${token}`;
}
