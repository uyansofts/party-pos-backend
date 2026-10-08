// ============================================================================
// REVIEWS — Барааны үнэлгээний цэвэр логик: шалгалт, нэр нууцлах, нэгтгэл, үнэлэх эрх.
// ============================================================================

export class ReviewError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "ReviewError";
    this.status = status;
  }
}

export const REVIEW_EDIT_WINDOW_MS = 30 * 24 * 3600 * 1000;
export const MAX_REVIEW_COMMENT = 500;

export function validateReviewInput(stars: unknown, comment: unknown): { stars: number; comment: string | null } {
  const s = typeof stars === "string" && /^\d$/.test(stars.trim()) ? Number(stars.trim()) : stars;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 5) throw new ReviewError("Од 1-5 хооронд бүхэл тоо байх ёстой");
  let text: string | null = null;
  if (comment !== undefined && comment !== null && comment !== "") {
    if (typeof comment !== "string") throw new ReviewError("Сэтгэгдэл текст байх ёстой");
    const t = comment.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    if (t.length > MAX_REVIEW_COMMENT) throw new ReviewError(`Сэтгэгдэл ${MAX_REVIEW_COMMENT} тэмдэгтээс ихгүй байх ёстой`);
    text = t || null;
  }
  return { stars: s, comment: text };
}

/** Нийтэд харагдах нэр: ЗӨВХӨН эхний үг (10 тэмдэгтээс урт бол таслана). Утас, бүтэн нэр ХЭЗЭЭ Ч гарахгүй. */
export function maskAuthorName(name: unknown): string {
  const first = typeof name === "string" ? name.trim().split(/\s+/)[0] ?? "" : "";
  const clean = first.replace(/[^\p{L}\p{N}-]/gu, "");
  if (!clean) return "Худалдан авагч";
  return Array.from(clean).length > 10 ? Array.from(clean).slice(0, 10).join("") + "…" : clean;
}

export interface ReviewableOrder {
  deliveryMethod?: string | null;
  deliveryAssignStatus?: string | null;
  paymentStatus?: string | null;
  cancelledAt?: Date | string | null;
  createdAt: Date | string;
}

/**
 * Үнэлэх эрх: төлсөн, цуцлагдаагүй, бараагаа ХҮЛЭЭН АВСАН.
 *   Хүргэлт: курьер хүргэсэн (DELIVERED).  Өөрөө авах/шуудан/UB Cab: төлсөн, 2 хоног өнгөрсөн (хүлээн авсан гэж үзнэ).
 */
export function canReviewOrder(o: ReviewableOrder, nowMs: number = Date.now()): boolean {
  if (o.cancelledAt || o.paymentStatus !== "PAID") return false;
  if (o.deliveryMethod === "DELIVERY") return o.deliveryAssignStatus === "DELIVERED";
  return nowMs - new Date(o.createdAt).getTime() >= 2 * 24 * 3600 * 1000;
}

export function canEditReview(createdAt: Date | string, nowMs: number = Date.now()): boolean {
  return nowMs - new Date(createdAt).getTime() <= REVIEW_EDIT_WINDOW_MS;
}

export interface RatingSummary {
  avg: number | null;
  count: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
}

export function summarizeRatings(rows: Array<{ stars: number }>): RatingSummary {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as RatingSummary["distribution"];
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.stars) || r.stars < 1 || r.stars > 5) continue;
    distribution[r.stars as 1 | 2 | 3 | 4 | 5]++;
    sum += r.stars;
    count++;
  }
  return { avg: count ? Math.round((sum / count) * 10) / 10 : null, count, distribution };
}

/** Хувилбартай бүлгийн (олон productId) үнэлгээг жинлэсэн дундажаар нэгтгэнэ. */
export function combineRatings(stats: Array<{ avg: number | null; count: number } | undefined>): { avg: number | null; count: number } {
  let count = 0;
  let total = 0;
  for (const s of stats) {
    if (!s || !s.count || s.avg == null) continue;
    count += s.count;
    total += s.avg * s.count;
  }
  return { avg: count ? Math.round((total / count) * 10) / 10 : null, count };
}

/** "Өндөр үнэлгээтэй" мөрөнд орох нөхцөл: дор хаяж 2 үнэлгээ, дундаж ≥ 4. */
export function isTopRated(s: { avg: number | null; count: number } | undefined): boolean {
  return !!s && s.avg != null && s.count >= 2 && s.avg >= 4;
}
