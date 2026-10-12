// ============================================================================
// COURIER AUTH CONTROLLER — POST /api/courier-auth/login
// ============================================================================

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { verifyPin, generateCourierToken } from "../services/courier-auth.service";
import { AttemptLimiter } from "../lib/customer-tracking";
import { LoginThrottledError, loginKey, throttledLogin } from "../lib/login-throttle";

const router = Router();

// ✅ АЮУЛГҮЙ БАЙДАЛ: 4 оронтой PIN нь 10,000 хувилбартай тул таах оролдлогыг IP болон утас тус бүрээр хязгаарлана.
const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: "Хэт олон буруу оролдлого. Түр хүлээгээд дахин оролдоно уу." } });
export const courierLoginLimiter = new AttemptLimiter(8, 15 * 60_000);

router.post("/login", loginIpLimiter, async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body ?? {};
    if (!phone || !pin) {
      return res.status(400).json({ error: "Утасны дугаар болон PIN заавал шаардлагатай" });
    }
    const key = loginKey(phone);
    if (key === null || typeof pin !== "string" || pin.length > 100) {
      return res.status(400).json({ error: "Утасны дугаар болон PIN буруу хэлбэртэй байна" });
    }

    const courier = await throttledLogin(courierLoginLimiter, key, async () => {
      const c = await prisma.courier.findUnique({ where: { phone } });
      if (!c || !c.isActive) return null;
      return (await verifyPin(pin, c.pinHash)) ? c : null;
    });
    if (!courier) {
      return res.status(401).json({ error: "Утасны дугаар эсвэл PIN буруу байна" });
    }

    const token = generateCourierToken({ courierId: courier.id, name: courier.name });
    // ✅ ШИНЭ: isAdmin-ийг JWT-д БИШ (30 хоногийн урт хугацаатай тул хуучирч
    // болзошгүй), зөвхөн энд, шууд DB-ээс ирсэн профайл дата дотор буцаана —
    // курьер апп үүнийг л ашиглаж "Бүх хүргэлт" таб харуулах эсэхээ шийднэ.
    res.json({ token, courier: { id: courier.id, name: courier.name, phone: courier.phone, isAdmin: courier.isAdmin } });
  } catch (err) {
    if (err instanceof LoginThrottledError) {
      res.setHeader("Retry-After", String(err.retryAfterSec));
      return res.status(429).json({ error: err.message });
    }
    console.error("Курьер нэвтрэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэвтэрч чадсангүй" });
  }
});

export default router;
