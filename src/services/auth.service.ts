// ============================================================================
// AUTH SERVICE — Нууц үг хэш, Staff JWT токен
// ----------------------------------------------------------------------------
// bcrypt ашиглан нууц үгийг НЭГ ЧИГЛЭЛТЭЙ (irreversible) хэшилнэ — DB алдагдсан
// ч бодит нууц үг задрахгүй. JWT-д staffId+role хадгалж, дараа нь middleware
// үүнийг шалгаж req.staff-руу оруулна.
// ============================================================================

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 10;

export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

export async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, hash);
}

export interface StaffTokenPayload {
  staffId: string;
  role: string;
  storeId: string;
}

export function generateStaffToken(payload: StaffTokenPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "12h" });
}

export function verifyStaffToken(token: string): StaffTokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET as string) as StaffTokenPayload;
}
