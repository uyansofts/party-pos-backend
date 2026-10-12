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
import { prisma } from "../lib/prisma";

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

// ============================================================================
// ROLE GUARD — requireAuth-ийн ДАРАА ажиллах эрхийн шалгалт (FAIL-CLOSED).
// Ижил JWT, ижил req.staff; DB дахь Staff.role/isActive-г л бодит эх сурвалж
// болгоно (токен 12 цаг хүчинтэй тул хуучирсан role-д найдахгүй).
//
// Шалгалтыг ямар ч env хувьсагчаар унтраах боломжгүй: STAFF_ROLE_ENFORCEMENT
// (on/off/auto) өмнө нь байсан ч одоо ТАЙЛЕГДЭХГҮЙ. Идэвхтэй ADMIN огт
// байхгүй бол ADMIN route-ууд 403 өгнө — ADMIN-г `scripts/promote-admin.ts`
// (dry-run → --apply)-аар урьдчилж үүсгэнэ.
// ============================================================================

/** @deprecated cache байхгүй болсон; хуучин дуудлагууд эвдрэхгүйн тулд хоосон үлдээв. */
export function resetRoleCache() {}

if (process.env.STAFF_ROLE_ENFORCEMENT) {
  console.warn("[auth] STAFF_ROLE_ENFORCEMENT тохиргоо үл тоомсорлогдоно — эрхийн шалгалт үргэлж идэвхтэй.");
}

/** req.staff аль хэдийн баталгаажсан гэж үзээд эрхийг DB-ээр шалгана. */
export async function staffHasRole(req: Request, roles: string[]): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  if (!req.staff) return { ok: false, status: 401, error: "Нэвтрэх шаардлагатай" };
  const row = await prisma.staff.findUnique({ where: { id: req.staff.staffId }, select: { role: true, isActive: true } });
  if (!row || !row.isActive) return { ok: false, status: 401, error: "Ажилтны эрх идэвхгүй байна" };
  if (!roles.includes(String(row.role))) return { ok: false, status: 403, error: "Энэ үйлдэлд ADMIN эрх шаардлагатай" };
  return { ok: true };
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const run = async () => {
      try {
        const r = await staffHasRole(req, roles);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        next();
      } catch (err) {
        console.error("[auth] requireRole алдаа:", err);
        res.status(500).json({ error: "Эрх шалгаж чадсангүй" });
      }
    };
    if (req.staff) return void run();
    requireAuth(req, res, () => void run());
  };
}

export const requireAdmin = requireRole("ADMIN");
