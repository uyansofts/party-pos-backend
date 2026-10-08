// ============================================================================
// AUTH MIDDLEWARE — REST endpoint-уудыг Bearer JWT-ээр хамгаалах
// ----------------------------------------------------------------------------
// АШИГЛАХ: router.post("/", requireAuth, async (req, res) => {...})
// эсвэл бүхэл router-т: app.use("/api/products", requireAuth, productRoutes)
//
// ЧУХАЛ: /api/payments/webhook/* endpoint-уудад ЭНЭ middleware-ийг ХЭЗЭЭ Ч
// хэрэглэхгүй — QPay/SocialPay өөрсдөө манай JWT-г мэдэхгүй тул тэдний
// callback үргэлж НЭЭЛТТЭЙ (public) байх ёстой.
// ============================================================================

import { Request, Response, NextFunction } from "express";
import { verifyStaffToken, StaffTokenPayload } from "../services/auth.service";

// Express-ийн Request төрлийг өргөтгөж, req.staff ашиглах боломжтой болгоно
declare global {
  namespace Express {
    interface Request {
      staff?: StaffTokenPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Нэвтрэх шаардлагатай (Authorization: Bearer <token> дутуу байна)" });
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    req.staff = verifyStaffToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Токен хүчингүй эсвэл хугацаа дууссан байна" });
  }
}
