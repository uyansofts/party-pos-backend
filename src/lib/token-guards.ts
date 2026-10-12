// ============================================================================
// TOKEN GUARDS — Staff / Courier / Seller JWT нь НЭГ JWT_SECRET-ээр гарын үсэг зурагддаг тул
// jwt.verify ганцаараа "ямар төрлийн токен вэ" гэдгийг ялгахгүй. Staff токен шалгахдаа
// Courier (type:"courier") болон Seller (type:"seller") токеныг ЗААВАЛ татгалзана.
// ЦЭВЭР логик (jsonwebtoken-д хамааралгүй) — тестлэхэд хялбар.
// ============================================================================

/** Staff токены payload: staffId заавал, `type` талбар ХЭЗЭЭ Ч байхгүй (courier/seller токенууд `type`-тай). */
export function isStaffTokenPayload(p: unknown): boolean {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.staffId === "string" && o.staffId.length > 0 && o.type === undefined;
}

export function assertStaffTokenPayload<T>(p: unknown): T {
  if (!isStaffTokenPayload(p)) throw new Error("Токены төрөл буруу байна");
  return p as T;
}
