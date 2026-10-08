// ============================================================================
// PRICING — Хямдрал (хувь + эхлэх/дуусах өдөр) ба онцлох/хямдралтай барааны ДЭЛГҮҮРИЙН ШИМТГЭЛ (цэвэр логик).
//   • Хямдрал = ХУВЬ (эх сурвалж) + эхлэх өдөр + дуусах өдөр (Улаанбаатарын өдрөөр). salePrice = үндсэн үнэ × (1 − хувь), хадгалахдаа тооцно.
//   • Хямдрал ИДЭВХТЭЙ = эхэлсэн, дуусаагүй. Хувь нь бараа бүрийн ӨӨРИЙН үнийн хэсэгт хэрэглэгдэнэ (энгийн: суурь үнэ; материалтай: суурь + материалын үнэ;
//     түрээс: өдрийн үнэ). Вариацын нэмэгдэл, үйлчилгээний төлбөр, барьцаанд хамаарахгүй. Харилцагч төлөх үнэ серверт тооцогдоно (клиентээс ИТГЭХГҮЙ).
//   • Хамгаалалт (хэрэглэгчийн эрх): ≤ 70%, ≤ 30 хоног, үндсэн үнэ хямдрал эхлэхээс ≥ 14 хоногийн өмнө тогтвортой,
//     хямдралтай (эсвэл товлогдсон) үед үндсэн үнийг өөрчлөх боломжгүй.
//   • Худалдагчийн комисс = үндсэн % (+ онцлох бол нэмэлт %, + хямдралтай бол нэмэлт %); дээд хязгаартай
// ============================================================================

export class PricingError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "PricingError";
    this.status = status;
  }
}

export const MAX_SALE_PERCENT = 70;
export const MAX_SALE_DAYS = 30; // хямдралын нийт өдөр (эхлэх, дуусах өдрийг оролцуулан)
export const MAX_SALE_LEAD_DAYS = 60; // эхлэх өдөр хамгийн ихдээ хэдэн хоногийн дараа
export const PRICE_STABLE_DAYS = 14; // үндсэн үнэ хямдрал эхлэхээс өмнө хэдэн хоног өөрчлөгдөөгүй байх
export const MAX_COMMISSION_CAP = 50;
export const MAX_COMMISSION_EXTRA = 20;
const DAY = 86400_000;
const UB_MS = 8 * 3600_000;

export interface SaleFields {
  sellPrice?: unknown;
  salePrice?: unknown;
  salePercent?: unknown;
  saleStartsAt?: Date | string | null;
  saleEndsAt?: Date | string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ubMidnight = (ms: number): number => Math.floor((ms + UB_MS) / DAY) * DAY - UB_MS;
const ubKeyOf = (ms: number): string => new Date(ms + UB_MS).toISOString().slice(0, 10);

/** Хугацааны нөхцөл: эхэлсэн (saleStartsAt ≤ одоо) ба дуусаагүй (saleEndsAt > одоо). Буруу огноо → false. */
function windowOk(p: SaleFields, now: Date): boolean {
  if (p.saleStartsAt) {
    const s = new Date(p.saleStartsAt).getTime();
    if (!Number.isFinite(s) || s > now.getTime()) return false;
  }
  if (p.saleEndsAt) {
    const t = new Date(p.saleEndsAt).getTime();
    if (!Number.isFinite(t) || t <= now.getTime()) return false;
  }
  return true;
}

/**
 * Идэвхтэй хямдралын ҮРЖВЭР (0-1) эсвэл null. БҮХ төрлийн барааны (энгийн, материалтай, түрээс) хямдралын цорын ганц эх сурвалж.
 *   • Хувьтай төлөвлөгөө (salePercent): үнэ байхгүй ч (материал, түрээс) ажиллана
 *   • Хуучин (хувьгүй salePrice): үндсэн үнээс багыг ХАРЬЦААГААР хөрвүүлнэ
 */
export function saleFactor(p: SaleFields, now: Date = new Date()): number | null {
  if (!p) return null;
  const pct = num(p.salePercent);
  if (pct !== null) {
    if (pct < 1 || pct > 99 || !windowOk(p, now)) return null;
    return (100 - pct) / 100;
  }
  const price = num(p.sellPrice);
  const sale = num(p.salePrice);
  if (price === null || sale === null || sale <= 0 || sale >= price || !windowOk(p, now)) return null;
  return sale / price;
}

/** Хямдрал одоо идэвхтэй юу (ямар ч төрлийн бараанд). */
export function isSaleActive(p: SaleFields, now: Date = new Date()): boolean {
  return saleFactor(p, now) !== null;
}

/** Нэг үнийн хэсэгт хямдралыг хэрэглэнэ (бүхэл ₮, ≥1 хэвээр). Хямдрал идэвхгүй/үнэ ≤ 0 бол ӨӨРЧЛӨХГҮЙ. Сервер, клиент ЯГ ИЖИЛ томъёо. */
export function applySale(p: SaleFields, amount: number, now: Date = new Date()): number {
  if (!(amount > 0)) return amount;
  const pct = num(p.salePercent);
  const f = saleFactor(p, now);
  if (f === null) return amount;
  const out = pct !== null ? Math.round((amount * (100 - pct)) / 100) : Math.round(amount * f);
  return Math.max(1, out);
}

/** Хямдрал ТОВЛОГДСОН (ирээдүйд эхэлнэ) эсэх. */
export function isSaleScheduled(p: SaleFields, now: Date = new Date()): boolean {
  if (!p.saleStartsAt || (num(p.salePercent) === null && num(p.salePrice) === null)) return false;
  const s = new Date(p.saleStartsAt).getTime();
  const e = p.saleEndsAt ? new Date(p.saleEndsAt).getTime() : Infinity;
  return Number.isFinite(s) && s > now.getTime() && e > now.getTime();
}

/** Үндсэн үнийг өөрчлөхийг хориглох уу: хямдрал идэвхтэй ЭСВЭЛ товлогдсон (хуурамч хямдралаас хамгаална). */
export function saleBlocksPriceChange(p: SaleFields & { salePercent?: unknown }, now: Date = new Date()): boolean {
  const has = num(p.salePercent) !== null || num(p.salePrice) !== null;
  if (!has) return false;
  if (!p.saleEndsAt) return true;
  const e = new Date(p.saleEndsAt).getTime();
  return Number.isFinite(e) && e > now.getTime();
}

/** Харилцагч ТӨЛӨХ үндсэн үнэ (хямдрал идэвхтэй бол хямдралтай). sellPrice байхгүй бол null. */
export function effectiveSellPrice(p: SaleFields, now: Date = new Date()): number | null {
  const price = num(p.sellPrice);
  return price === null ? null : applySale(p, price, now);
}

/** Хямдралын хувь (бүхэл, ≥1) эсвэл хямдрал идэвхгүй бол null. */
export function salePercent(p: SaleFields, now: Date = new Date()): number | null {
  const f = saleFactor(p, now);
  if (f === null) return null;
  const pct = num(p.salePercent);
  return pct !== null ? pct : Math.max(1, Math.round((1 - f) * 100));
}

/** Үндсэн үнэ × (100 − хувь) / 100, бүхэл ₮. Үнэ 1-ээс бага эсвэл үндсэнтэй тэнцүү (хямдрал биш) бол null. */
export function deriveSalePrice(base: number, percent: number): number | null {
  const p = Math.round((base * (100 - percent)) / 100);
  return p >= 1 && p < base ? p : null;
}

export interface SalePlan {
  salePercent: number | null;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}
export const NO_SALE: SalePlan = { salePercent: null, salePrice: null, saleStartsAt: null, saleEndsAt: null };

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function parseDay(raw: unknown, label: string): number {
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!m) throw new PricingError(`${label} YYYY-MM-DD хэлбэртэй байх ёстой`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const c = new Date(Date.UTC(y, mo - 1, d));
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) throw new PricingError(`${label} буруу байна`);
  return Date.UTC(y, mo - 1, d) - UB_MS; // Улаанбаатарын тэр өдрийн 00:00
}

export interface SaleInput {
  percent: unknown;
  starts: unknown;
  ends: unknown;
}
export interface SaleContext {
  sellPrice: number | null;
  /** Материалтай/түрээсийн бараа: суурь үнэгүй ч хувиар хямдруулж болно (үнийг захиалах үед хэрэглэнэ). */
  basePriceOptional?: boolean;
  priceChangedAt?: Date | string | null;
  current?: { salePercent?: unknown; saleStartsAt?: Date | string | null } | null;
  now?: Date;
}

/** Хоёр хямдралын төлөвлөгөө ижил эсэх (хувь, эхлэх өдөр, дуусах өдөр — УБ-ын өдрөөр). Маягт өөрчлөгдөөгүй хямдралыг дахин илгээхэд дахин шалгахгүйн тулд. */
export function sameSalePlan(cur: { salePercent?: unknown; saleStartsAt?: Date | string | null; saleEndsAt?: Date | string | null } | null | undefined, input: SaleInput): boolean {
  const emptyInput = input.percent === null || input.percent === "" || input.percent === undefined;
  // Хямдралгүй (эсвэл хуучин salePrice-тэй, хувьгүй) бараа: "цуцлах" хүсэлт хуучин хямдралыг ч арилгах ёстой тул ТЭНЦЭЭГҮЙ
  if (!cur || num(cur.salePercent) === null) return emptyInput && (!cur || num((cur as any).salePrice) === null);
  const dayKey = (v: unknown): string => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
    const t = new Date(v as any).getTime();
    return Number.isFinite(t) ? ubKeyOf(t) : "";
  };
  return num(cur.salePercent) === toInt(input.percent) && !!cur.saleStartsAt && !!cur.saleEndsAt && dayKey(cur.saleStartsAt) === dayKey(input.starts) && dayKey(cur.saleEndsAt) === dayKey(input.ends);
}

/**
 * Хямдралын төлөвлөгөөг шалгаж, үнийг тооцно. percent null/"" → хямдралыг ЦУЦЛАНА.
 * Дүрэм: хувь 1-70; эхлэх, дуусах өдөр ЗААВАЛ; дуусах ≥ эхлэх; нийт ≤ 30 өдөр; дуусах өдөр өнгөрөөгүй.
 * Шинэ/өөрчилсөн эхлэх өдөр: өнөөдрөөс (өмнө БИШ) ≤ 60 хоногийн дотор ба үндсэн үнэ эхлэхээс ≥ 14 хоногийн өмнө тогтвортой.
 * Эхлэх өдөр өөрчлөгдөөгүй (одоо явагдаж буй хямдрал) бол эхлэх өдрийн шалгалтыг алгасна — дуусах өдрийг сунгах, хувийг өөрчлөх боломжтой.
 */
export function validateSalePlan(input: SaleInput, ctx: SaleContext): SalePlan {
  const now = ctx.now ?? new Date();
  if (input.percent === null || input.percent === "") return NO_SALE;
  const pct = toInt(input.percent);
  if (pct === null || pct < 1 || pct > MAX_SALE_PERCENT) throw new PricingError(`Хямдралын хувь 1-${MAX_SALE_PERCENT}% бүхэл тоо байх ёстой`);
  const base = ctx.sellPrice;
  let salePrice: number | null = null;
  if (base !== null && base > 0) {
    salePrice = deriveSalePrice(base, pct);
    if (salePrice === null) throw new PricingError("Үнэ хэт бага тул энэ хувиар хямдрал хэрэгжих боломжгүй");
  } else if (!ctx.basePriceOptional) {
    throw new PricingError("Үндсэн үнэ тохируулаагүй бараанд хямдрал зарлах боломжгүй");
  }
  if (input.starts === undefined || input.starts === null || input.starts === "" || input.ends === undefined || input.ends === null || input.ends === "") throw new PricingError("Хямдралын эхлэх болон дуусах өдрийг оруулна уу");

  const startMs = parseDay(input.starts, "Эхлэх өдөр");
  const endDayMs = parseDay(input.ends, "Дуусах өдөр");
  if (endDayMs < startMs) throw new PricingError("Дуусах өдөр эхлэх өдрөөс өмнө байж болохгүй");
  if ((endDayMs - startMs) / DAY + 1 > MAX_SALE_DAYS) throw new PricingError(`Хямдрал хамгийн ихдээ ${MAX_SALE_DAYS} хоног үргэлжилнэ`);
  const endsAt = new Date(endDayMs + DAY - 1000); // дуусах өдрийн 23:59:59 (УБ)
  if (endsAt.getTime() <= now.getTime()) throw new PricingError("Дуусах өдөр өнгөрсөн байна");

  const cur = ctx.current;
  const startUnchanged = !!cur && num(cur.salePercent) !== null && !!cur.saleStartsAt && ubMidnight(new Date(cur.saleStartsAt).getTime()) === startMs;
  if (!startUnchanged) {
    const today = ubMidnight(now.getTime());
    if (startMs < today) throw new PricingError("Эхлэх өдөр өнөөдрөөс өмнө байж болохгүй");
    if (startMs > today + MAX_SALE_LEAD_DAYS * DAY) throw new PricingError(`Эхлэх өдөр хамгийн ихдээ ${MAX_SALE_LEAD_DAYS} хоногийн дараа байна`);
    if (ctx.priceChangedAt) {
      const changed = new Date(ctx.priceChangedAt).getTime();
      if (Number.isFinite(changed)) {
        const earliest = ubMidnight(changed) + PRICE_STABLE_DAYS * DAY;
        if (startMs < earliest) throw new PricingError(`Үндсэн үнэ ${ubKeyOf(changed)}-нд өөрчлөгдсөн тул хямдралыг ${ubKeyOf(earliest)}-аас эхлүүлж болно (үнэ ${PRICE_STABLE_DAYS} хоног тогтвортой байх ёстой)`);
      }
    }
  }
  return { salePercent: pct, salePrice, saleStartsAt: new Date(startMs), saleEndsAt: endsAt };
}

export interface SaleChangeCurrent {
  sellPrice?: unknown;
  rentalPricePerDay?: unknown;
  priceChangedAt?: Date | string | null;
  salePercent?: unknown;
  salePrice?: unknown;
  saleStartsAt?: Date | string | null;
  saleEndsAt?: Date | string | null;
}

/**
 * Барааны үнэ/хямдралын өөрчлөлтийг НЭГ газраас шийднэ (худалдагчийн портал ба POS хоёр яг ижил дүрэмтэй).
 *   • Хямдрал өөрчлөгдөөгүй (маягт хуучин утгыг дахин илгээсэн) бол дахин шалгахгүй
 *   • Үндсэн үнэ өөрчлөгдвөл priceChangedAt = одоо; хямдрал идэвхтэй/товлогдсон үед үнийг өөрчлөх ХОРИГЛОНО (хямдралыг цуцалж байгаа бол болно)
 *   • Нэг дор үнэ өөрчлөөд хямдрал зарлавал хямдрал 14 хоногийн дараа эхэлнэ
 * Буцаах: баазад бичих талбарууд (priceChangedAt, salePercent, salePrice, saleStartsAt, saleEndsAt). sellPrice-ийг дуудагч өөрөө бичнэ.
 */
export function planSaleChange(cur: SaleChangeCurrent | null, req: { sellPrice?: number | null; rentalPrice?: number | null; priceOptional?: boolean; sale?: SaleInput }, now: Date = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const oldPrice = cur && cur.sellPrice !== null && cur.sellPrice !== undefined ? Number(cur.sellPrice) : null;
  const oldRental = cur && cur.rentalPricePerDay !== null && cur.rentalPricePerDay !== undefined ? Number(cur.rentalPricePerDay) : null;
  // бараа ҮҮСГЭЖ байгаа (cur=null) анхны үнэ "өөрчлөлт" биш. Түрээсийн өдрийн үнэ ч үндсэн үнэ шиг хамгаалагдана.
  const priceChanges = cur !== null && ((req.sellPrice !== undefined && req.sellPrice !== oldPrice) || (req.rentalPrice !== undefined && req.rentalPrice !== oldRental));
  const finalPrice = req.sellPrice !== undefined ? req.sellPrice : oldPrice;

  let plan: SalePlan | null = null;
  if (req.sale) {
    const same = cur != null && sameSalePlan(cur, req.sale);
    if (!same) plan = validateSalePlan(req.sale, { sellPrice: finalPrice, basePriceOptional: req.priceOptional, priceChangedAt: priceChanges ? now : cur?.priceChangedAt ?? null, current: cur, now });
  }
  if (priceChanges) {
    const cancelling = plan !== null && plan.salePercent === null;
    if (cur && saleBlocksPriceChange(cur, now) && !cancelling) throw new PricingError("Хямдралтай (эсвэл товлогдсон) үед үндсэн үнийг өөрчлөх боломжгүй — эхлээд хямдралыг цуцална уу", 409);
    if (cur) out.priceChangedAt = now;
  }
  if (plan) Object.assign(out, plan);
  return out;
}

// ---------------------------- Дэлгүүрийн шимтгэл ----------------------------

export interface CommissionExtras {
  featured: number; // онцлох барааны нэмэлт % (процентын пункт)
  sale: number; // хямдралтай барааны нэмэлт %
}

const clampExtra = (n: unknown) => (Number.isFinite(Number(n)) ? Math.min(MAX_COMMISSION_EXTRA, Math.max(0, Number(n))) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Нэг барааны шимтгэлийн хувь: үндсэн + (онцлох ? нэмэлт) + (хямдралтай ? нэмэлт). Дээд хязгаар (үндсэн нь хязгаараас их бол үндсэнээс хэтрэхгүй). */
export function commissionPercentFor(base: number, featured: boolean, onSale: boolean, extras: CommissionExtras, cap: number = MAX_COMMISSION_CAP): number {
  const b = Number.isFinite(base) ? Math.min(100, Math.max(0, base)) : 0;
  let pct = b;
  if (featured) pct += clampExtra(extras.featured);
  if (onSale) pct += clampExtra(extras.sale);
  return round2(Math.min(Math.max(cap, b), pct));
}

export interface CommissionLine {
  productId: string;
  subtotal: number;
}

/** Захиалгын шимтгэл: мөр бүр өөрийн хувиар (онцлох/хямдралтай эсэхээр), нийлбэрийг НЭГ удаа бөөрөнхийлнө. effectivePercent = жинлэсэн дундаж (харуулахад). */
export function computeSellerCommission(
  lines: CommissionLine[],
  flags: Map<string, { featured: boolean; onSale: boolean }>,
  basePercent: number,
  extras: CommissionExtras
): { commissionAmount: number; effectivePercent: number; itemsTotal: number } {
  let itemsTotal = 0;
  let raw = 0;
  for (const l of lines) {
    const sub = Number.isFinite(l.subtotal) && l.subtotal > 0 ? l.subtotal : 0;
    const f = flags.get(l.productId) ?? { featured: false, onSale: false };
    itemsTotal += sub;
    raw += (sub * commissionPercentFor(basePercent, f.featured, f.onSale, extras)) / 100;
  }
  const commissionAmount = Math.round(raw);
  const effectivePercent = itemsTotal > 0 ? round2((commissionAmount / itemsTotal) * 100) : round2(Number.isFinite(basePercent) ? basePercent : 0);
  return { commissionAmount, effectivePercent, itemsTotal: Math.round(itemsTotal) };
}
