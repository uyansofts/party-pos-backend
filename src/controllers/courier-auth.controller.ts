// ============================================================================
// COURIER AUTH CONTROLLER — POST /api/courier-auth/login
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { verifyPin, generateCourierToken } from "../services/courier-auth.service";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) {
      return res.status(400).json({ error: "Утасны дугаар болон PIN заавал шаардлагатай" });
    }

    const courier = await prisma.courier.findUnique({ where: { phone } });
    if (!courier || !courier.isActive) {
      return res.status(401).json({ error: "Утасны дугаар эсвэл PIN буруу байна" });
    }

    const valid = await verifyPin(pin, courier.pinHash);
    if (!valid) {
      return res.status(401).json({ error: "Утасны дугаар эсвэл PIN буруу байна" });
    }

    const token = generateCourierToken({ courierId: courier.id, name: courier.name });
    // ✅ ШИНЭ: isAdmin-ийг JWT-д БИШ (30 хоногийн урт хугацаатай тул хуучирч
    // болзошгүй), зөвхөн энд, шууд DB-ээс ирсэн профайл дата дотор буцаана —
    // курьер апп үүнийг л ашиглаж "Бүх хүргэлт" таб харуулах эсэхээ шийднэ.
    res.json({ token, courier: { id: courier.id, name: courier.name, phone: courier.phone, isAdmin: courier.isAdmin } });
  } catch (err) {
    console.error("Курьер нэвтрэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэвтэрч чадсангүй" });
  }
});

export default router;
