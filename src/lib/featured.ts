// ============================================================================
// FEATURED — Төлбөртэй ОНЦЛОХ байрлал (цэвэр логик).
//   Урсгал: REQUESTED → (Staff зөвшөөрнө, байрлал НӨӨЦӨЛНӨ) APPROVED → (төлнө) ACTIVE → EXPIRED
//   Огноо нь ӨДӨРЧЛӨН (Улаанбаатарын өдөр, UTC+8): эхлэх = тэр өдрийн 00:00, дуусах = сүүлийн өдрийн төгсгөл
//   Онцлох = isFeatured ба (featuredUntil байхгүй = Staff хугацаагүй, эсвэл featuredUntil ирээдүйд)
// ============================================================================

export class FeaturedError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "FeaturedError";
    this.status = status;
  }
}

export const MAX_OPEN_PER_SELLER = 5;
export const MAX_PACKAGE_DAYS = 365;
export const MAX_PACKAGE_PRICE = 10_000_000;
export const MIN_LEAD_DAYS = 1; // эхлэх өдөр хамгийн багадаа маргааш
export const MAX_LEAD_DAYS = 60;
export const REQUEST_TTL_DAYS = 7; // зөвшөөрөл хүлээсэн хүсэлт энэ хугацаанд хариугүй бол автоматаар хаагдана
export const REPORTED_HOLD_HOURS = 24; // "Шилжүүлсэн" гэж мэдэгдсэний дараа Staff шалгах хугацаа
export const DEFAULT_SLOT_LIMIT = 8;
export const DEFAULT_HOLD_MINUTES = 20;
export const DAY_MS = 86400_000;
const UB_MS = 8 * 3600_000;

/** Хүсэлт өгсөн (байрлал нөөцлөөгүй) төлвүүд. PENDING_PAYMENT = өмнөх хувилбарын үлдэгдэл. */
export const AWAITING_APPROVAL = ["REQUESTED", "PENDING_PAYMENT"];
export const OPEN_STATUSES = ["REQUESTED", "PENDING_PAYMENT", "APPROVED", "PAYMENT_REPORTED"];

export function isFeaturedNow(p: { isFeatured?: unknown; featuredUntil?: Date | string | null }, now: Date = new Date()): boolean {
  if (!p || !p.isFeatured) return false;
  if (p.featuredUntil === null || p.featuredUntil === undefined) return true;
  const t = new Date(p.featuredUntil).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/** Staff хугацаагүй онцолсон (төлбөртэй биш) эсэх — худалдагч төлж байрлуулах хэрэггүй, лимитийн суурь тоонд орно. */
export function isStaffForeverFeatured(p: { isFeatured?: unknown; featuredUntil?: Date | string | null }): boolean {
  return !!p && !!p.isFeatured && (p.featuredUntil === null || p.featuredUntil === undefined);
}

/** Улаанбаатарын өдрийн 00:00 (UTC мс). */
export function ubMidnightMs(ms: number): number {
  return Math.floor((ms + UB_MS) / DAY_MS) * DAY_MS - UB_MS;
}

export function ubKey(ms: number): string {
  return new Date(ms + UB_MS).toISOString().slice(0, 10);
}

/** Эхлэх өдөр "YYYY-MM-DD" → УБ-ын тэр өдрийн 00:00. Маргаашаас эхлээд ≤ 60 хоногийн дараа. */
export function validateStartDate(raw: unknown, now: Date = new Date()): Date {
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!m) throw new FeaturedError("Эхлэх огноог YYYY-MM-DD хэлбэрээр оруулна уу");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new FeaturedError("Эхлэх огноо буруу байна");
  const startMs = Date.UTC(y, mo - 1, d) - UB_MS;
  const today = ubMidnightMs(now.getTime());
  if (startMs < today + MIN_LEAD_DAYS * DAY_MS) throw new FeaturedError("Эхлэх огноо хамгийн багадаа маргааш байх ёстой");
  if (startMs > today + MAX_LEAD_DAYS * DAY_MS) throw new FeaturedError(`Эхлэх огноо хамгийн ихдээ ${MAX_LEAD_DAYS} хоногийн дараа байна`);
  return new Date(startMs);
}

/** Багцын хугацааны цонх: [startsAt, endsAt) — өдрөөр. Жишээ: 7 хоног, 10-12-оос → 10-12 … 10-18 (endsAt = 10-19 00:00 УБ). */
export function windowFor(start: Date, days: number): { startsAt: Date; endsAt: Date } {
  if (!Number.isInteger(days) || days < 1) throw new FeaturedError("Багцын хугацаа буруу байна");
  return { startsAt: start, endsAt: new Date(start.getTime() + days * DAY_MS) };
}

/** Сүүлийн идэвхтэй өдөр (харуулахад): endsAt-ийн өмнөх өдөр. */
export function lastDayKey(endsAt: Date | string): string {
  const t = new Date(endsAt).getTime();
  return Number.isFinite(t) ? ubKey(t - 1) : "";
}

export function normalizeSlotLimit(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_SLOT_LIMIT;
}

export function normalizeHoldMinutes(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : DEFAULT_HOLD_MINUTES;
}

export interface PackageInput {
  name?: string;
  durationDays?: number;
  price?: number;
  isActive?: boolean;
  sortOrder?: number;
}

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Багцын оролт. partial=true үед (засвар) зөвхөн өгсөн талбарыг шалгана; false үед нэр, хугацаа, үнэ ЗААВАЛ. */
export function validatePackageInput(raw: unknown, partial: boolean): PackageInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FeaturedError("Мэдээлэл буруу байна");
  const b = raw as Record<string, unknown>;
  const bad = Object.keys(b).filter((k) => !["name", "durationDays", "price", "isActive", "sortOrder"].includes(k));
  if (bad.length) throw new FeaturedError(`Зөвшөөрөгдөөгүй талбар: ${bad[0]}`);
  const out: PackageInput = {};
  if (!partial || b.name !== undefined) {
    const n = typeof b.name === "string" ? b.name.replace(/[\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim() : "";
    if (n.length < 1 || n.length > 40) throw new FeaturedError("Багцын нэр 1-40 тэмдэгттэй байх ёстой");
    out.name = n;
  }
  if (!partial || b.durationDays !== undefined) {
    const d = toInt(b.durationDays);
    if (d === null || d < 1 || d > MAX_PACKAGE_DAYS) throw new FeaturedError(`Хугацаа 1-${MAX_PACKAGE_DAYS} хоногийн бүхэл тоо байх ёстой`);
    out.durationDays = d;
  }
  if (!partial || b.price !== undefined) {
    const p = toInt(b.price);
    if (p === null || p < 0 || p > MAX_PACKAGE_PRICE) throw new FeaturedError(`Үнэ 0-${MAX_PACKAGE_PRICE.toLocaleString("en-US")}₮-ийн бүхэл тоо байх ёстой`);
    out.price = p;
  }
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== "boolean") throw new FeaturedError("isActive true эсвэл false байх ёстой");
    out.isActive = b.isActive;
  }
  if (b.sortOrder !== undefined) {
    const o = toInt(b.sortOrder);
    if (o === null || o > 9999) throw new FeaturedError("Эрэмбэ 0-9999 бүхэл тоо байх ёстой");
    out.sortOrder = o;
  }
  if (partial && Object.keys(out).length === 0) throw new FeaturedError("Өөрчлөх зүйл алга");
  return out;
}

/** Дансаар шилжүүлэх гүйлгээний утга: FP-123456. rand тестэд солигдоно. */
export function generateReferenceCode(rand: () => number = Math.random): string {
  return "FP-" + String(Math.floor(rand() * 900000) + 100000);
}

export const PAYMENT_METHODS = ["BANK_TRANSFER", "CASH"];
export function validatePaymentMethod(m: unknown): "BANK_TRANSFER" | "CASH" {
  if (typeof m !== "string" || !PAYMENT_METHODS.includes(m)) throw new FeaturedError("Төлбөрийн аргыг дансаар эсвэл бэлнээр гэж сонгоно уу");
  return m as "BANK_TRANSFER" | "CASH";
}

/**
 * Харуулах төлөв (job ажиллахаас өмнө ч зөв): ACTIVE ч дуусах хугацаа өнгөрсөн → EXPIRED;
 * APPROVED/PAYMENT_REPORTED ч нөөцлөлтийн хугацаа дууссан → LAPSED; хуучин PENDING_PAYMENT → REQUESTED.
 */
export function effectiveStatus(p: { status: string; endsAt?: Date | string | null; holdUntil?: Date | string | null }, now: Date = new Date()): string {
  if (p.status === "PENDING_PAYMENT") return "REQUESTED";
  if (p.status === "ACTIVE" && p.endsAt) {
    const t = new Date(p.endsAt).getTime();
    if (Number.isFinite(t) && t <= now.getTime()) return "EXPIRED";
  }
  if ((p.status === "APPROVED" || p.status === "PAYMENT_REPORTED") && p.holdUntil) {
    const t = new Date(p.holdUntil).getTime();
    if (Number.isFinite(t) && t <= now.getTime()) return "LAPSED";
  }
  return p.status;
}

export function daysLeft(endsAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!endsAt) return 0;
  const t = new Date(endsAt).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS)) : 0;
}
