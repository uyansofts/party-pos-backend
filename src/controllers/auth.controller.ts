// ============================================================================
// AUTH CONTROLLER — Staff нэвтрэх
// ============================================================================

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { verifyPassword, generateStaffToken } from "../services/auth.service";
import { AttemptLimiter } from "../lib/customer-tracking";
import { LoginThrottledError, loginKey, throttledLogin } from "../lib/login-throttle";

const router = Router();

// POST /api/auth/login
// body: { email, password }
// ✅ АЮУЛГҮЙ БАЙДАЛ: нууц үг таах оролдлогыг IP (зөвхөн АМЖИЛТГҮЙ хүсэлтийг тоолно) болон и-мэйл тус бүрээр хязгаарлана.
const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: "Хэт олон буруу оролдлого. Түр хүлээгээд дахин оролдоно уу." } });
export const staffLoginLimiter = new AttemptLimiter(10, 15 * 60_000);

router.post("/login", loginIpLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: "email болон password заавал шаардлагатай" });
    }
    const key = loginKey(email);
    if (key === null || typeof password !== "string" || password.length > 200) {
      return res.status(400).json({ error: "email болон password буруу хэлбэртэй байна" });
    }

    const staff = await throttledLogin(staffLoginLimiter, key, async () => {
      const s = await prisma.staff.findUnique({ where: { email } });
      // Аюулгүй байдлын шалтгаанаар "И-мэйл олдсонгүй" vs "нууц үг буруу" гэж
      // ЯЛГАХГҮЙ, аль аль тохиолдолд ижил мессеж буцаана (email enumeration-с сэргийлнэ).
      if (!s || !s.isActive) return null;
      return (await verifyPassword(password, s.passwordHash)) ? s : null;
    });
    if (!staff) {
      return res.status(401).json({ error: "И-мэйл эсвэл нууц үг буруу байна" });
    }

    const token = generateStaffToken({ staffId: staff.id, role: staff.role, storeId: "default" });

    res.json({
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
    });
  } catch (err) {
    if (err instanceof LoginThrottledError) {
      res.setHeader("Retry-After", String(err.retryAfterSec));
      return res.status(429).json({ error: err.message });
    }
    console.error("Нэвтрэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэвтэрч чадсангүй" });
  }
});

export default router;
