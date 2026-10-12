// ============================================================================
// LOGIN THROTTLE — нууц үг/PIN таах (brute-force) оролдлогыг НЭР (identity) тус бүрээр хязгаарлана.
// ХЭЗЭЭ Ч "шалгаад дараа нь тоолох" БИШ: оролдлогын ӨМНӨ слот нөөцөлнэ (fail), амжилттай бол арилгана (success).
// Ингэснээр зэрэг олон хүсэлт илгээж түгжээг тойрох боломжгүй.
// ============================================================================

import { AttemptLimiter } from "./customer-tracking";

export class LoginThrottledError extends Error {
  constructor(public retryAfterSec: number) {
    super("Хэт олон буруу оролдлого. Түр хүлээгээд дахин оролдоно уу.");
    this.name = "LoginThrottledError";
  }
}

/** Нэр (и-мэйл/утас)-ийг түлхүүр болгоно: зөвхөн мөр, 3..120 тэмдэгт. Буруу бол null. */
export function loginKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length >= 3 && v.length <= 120 ? v : null;
}

/**
 * attempt() амжилттай бол утга, буруу нууц үг бол null буцаана. Хязгаар хэтэрсэн бол LoginThrottledError.
 * Слот нь attempt-ээс ӨМНӨ нөөцлөгдөнө → параллель хүсэлт maxFails-ээс илүү attempt-д хүрэхгүй.
 */
export async function throttledLogin<T>(limiter: AttemptLimiter, key: string, attempt: () => Promise<T | null>): Promise<T | null> {
  const c = limiter.check(key);
  if (!c.allowed) throw new LoginThrottledError(c.retryAfterSec);
  limiter.fail(key); // слот нөөцөлнэ
  const r = await attempt();
  if (r) limiter.success(key);
  return r;
}
