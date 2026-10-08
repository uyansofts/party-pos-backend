// ============================================================================
// AUTH CONTROLLER — Staff нэвтрэх
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { verifyPassword, generateStaffToken } from "../services/auth.service";

const router = Router();

// POST /api/auth/login
// body: { email, password }
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email болон password заавал шаардлагатай" });
    }

    const staff = await prisma.staff.findUnique({ where: { email } });
    // Аюулгүй байдлын шалтгаанаар "И-мэйл олдсонгүй" vs "нууц үг буруу" гэж
    // ЯЛГАХГҮЙ, аль аль тохиолдолд ижил мессеж буцаана (email enumeration-с сэргийлнэ).
    if (!staff || !staff.isActive) {
      return res.status(401).json({ error: "И-мэйл эсвэл нууц үг буруу байна" });
    }

    const isValid = await verifyPassword(password, staff.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: "И-мэйл эсвэл нууц үг буруу байна" });
    }

    const token = generateStaffToken({ staffId: staff.id, role: staff.role, storeId: "default" });

    res.json({
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
    });
  } catch (err) {
    console.error("Нэвтрэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэвтэрч чадсангүй" });
  }
});

export default router;
