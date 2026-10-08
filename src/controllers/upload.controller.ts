// ============================================================================
// UPLOAD CONTROLLER — /api/uploads/image (Staff). Зураг файлаар оруулах: бие (raw bytes) = зураг, Content-Type = image/jpeg|png|webp.
// Файлыг агуулгаар нь шалгана (lib/image-upload). Буцаах: { id, url, mime, bytes } — url-ийг барааны imageUrls-д хийнэ.
// ============================================================================

import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.middleware";
import { UploadError, getImageStore, saveUploadedImage } from "../lib/image-upload";

const router = Router();
router.use(requireAuth);

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: "Хэт олон зураг оруулж байна. Түр хүлээнэ үү." } });

router.post("/image", limiter, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb" }), async (req: Request, res: Response) => {
  try {
    res.status(201).json(await saveUploadedImage(getImageStore(), req.body));
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
    console.error("Зураг хадгалахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Зураг хадгалж чадсангүй" });
  }
});

export default router;
