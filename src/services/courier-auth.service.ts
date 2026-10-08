// ============================================================================
// COURIER AUTH SERVICE — Хүргэлтийн ажилтны нэвтрэлт (Утас + 4 оронтой PIN)
// ----------------------------------------------------------------------------
// Staff-ийн auth.service.ts-тэй ИЖИЛ хэв маягтай, гэхдээ ТУСДАА JWT payload
// бүтэцтэй (courierId) — Staff токеноор Courier endpoint-д нэвтрэх (мөн
// эсрэгээр) боломжгүй байхын тулд ТУСДАА "type" талбар нэмнэ.
// ============================================================================

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 10;

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

export interface CourierTokenPayload {
  type: "courier"; // Staff токентой андуурахгүй байхын тулд
  courierId: string;
  name: string;
}

export function generateCourierToken(payload: Omit<CourierTokenPayload, "type">): string {
  return jwt.sign({ ...payload, type: "courier" }, process.env.JWT_SECRET as string, { expiresIn: "30d" });
  // ⚠️ 30 хоног — хүргэгч өдөр бүр дахин нэвтрэхгүй байхын тулд урт хугацаатай.
  // Ажлаас гарсан хүргэгчийг isActive=false болгож хориглоно.
}

export function verifyCourierToken(token: string): CourierTokenPayload {
  const payload = jwt.verify(token, process.env.JWT_SECRET as string) as CourierTokenPayload;
  if (payload.type !== "courier") {
    throw new Error("Токены төрөл буруу байна");
  }
  return payload;
}
