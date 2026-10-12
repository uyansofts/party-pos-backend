// ============================================================================
// OTP GUARD — хүргэлт/буцаалт/авалтын 4 оронтой код (10,000 хувилбар)-ыг таах (brute-force) оролдлогыг хязгаарлана.
// Өмнө нь код буруу бол л алдаа өгч, хязгааргүй оролдох боломжтой байсан тул оноогдсон курьер кодыг таагаад
// "хүргэсэн" гэж баталгаажуулах боломжтой байв. Слотыг оролдлогын ӨМНӨ нөөцөлнэ (параллель хүсэлтээр тойрч болохгүй).
// Хэмжээ: нэг захиалгын нэг төрлийн кодод 15 минутад 6 буруу оролдлого. Санах ой дотор (процесс рестарт хийвэл арилна).
// ============================================================================

import crypto from "crypto";
import { AttemptLimiter } from "./customer-tracking";

export const otpLimiter = new AttemptLimiter(6, 15 * 60_000);

export type OtpResult = "ok" | "wrong" | "locked";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** key = `${kind}:${orderId}` (жишээ нь "deliver:ord1"). expected нь DB дэх код, given нь хэрэглэгчийн оруулсан. */
export function checkOtp(key: string, expected: unknown, given: unknown, limiter: AttemptLimiter = otpLimiter): OtpResult {
  const c = limiter.check(key);
  if (!c.allowed) return "locked";
  limiter.fail(key); // слот нөөцөлнэ
  const ok = typeof expected === "string" && expected.length > 0 && typeof given === "string" && safeEqual(expected, given);
  if (ok) {
    limiter.success(key);
    return "ok";
  }
  return "wrong";
}

export const OTP_LOCKED_MESSAGE = "Хэт олон буруу код оруулсан тул түр түгжигдлээ — 15 минутын дараа дахин оролдоно уу эсвэл дэлгүүртэй холбогдоно уу";
