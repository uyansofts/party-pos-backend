// ============================================================================
// COURIER AUTH MIDDLEWARE — Хүргэлтийн ажилтны REST endpoint-уудыг
// хамгаална (Bearer JWT, courier токен ГАНЦХАН).
// ============================================================================

import { Request, Response, NextFunction } from "express";
import { verifyCourierToken, CourierTokenPayload } from "../services/courier-auth.service";

declare global {
  namespace Express {
    interface Request {
      courier?: CourierTokenPayload;
    }
  }
}

export function requireCourierAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Нэвтрэх шаардлагатай" });
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    req.courier = verifyCourierToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Токен хүчингүй эсвэл хугацаа дууссан байна" });
  }
}
