// ============================================================================
// SELLER — Худалдагчийн (Etsy шиг marketplace) цэвэр логик: шалгалт, холбоосын нэр, харагдах дүрэм.
// ============================================================================

import { normalizeMongolianPhone } from "./mongolian-phone";

export const SELLER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED"] as const;
export type SellerStatusValue = (typeof SELLER_STATUSES)[number];

export const MAX_COMMISSION_PERCENT = 50;

/** "Сарааны Гар Урлал" / "my-shop" → "saraany-gar-urlal" / "my-shop" шиг холбоосын нэр. Хэрэглэж болохгүй бол null. */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t) && t.length >= 3 && t.length <= 40 ? t : null;
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n",
  о: "o", ө: "u", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Монгол нэрээс холбоосын нэр гаргана: "Сарааны гар урлал" → "saraany-gar-urlal". Гарахгүй бол null. */
export function slugifyName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const latin = Array.from(name.trim().toLowerCase()).map((ch) => (ch in CYR ? CYR[ch] : ch)).join("");
  const t = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return t.length >= 3 ? t : null;
}

export interface SellerData {
  name?: string;
  slug?: string;
  description?: string | null;
  logoUrl?: string | null;
  phone?: string;
  pickupAddress?: string;
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
  commissionPercent?: number;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountHolder?: string | null;
}

export interface SellerValidation {
  ok: boolean;
  data?: SellerData;
  error?: string;
}

const optText = (v: unknown, max: number, label: string): { ok: boolean; value?: string | null; error?: string } => {
  if (v === undefined) return { ok: true };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: `${label} текст байх ёстой` };
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `${label} ${max} тэмдэгтээс ихгүй байх ёстой` };
  return { ok: true, value: t };
};

const coord = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

/** create: нэр, утас, авах хаяг ЗААВАЛ. update: өгсөн талбарыг л шалгана (null/хоосон → арилгана). */
export function validateSellerInput(raw: unknown, mode: "create" | "update"): SellerValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Мэдээлэл буруу байна" };
  const b = raw as Record<string, unknown>;
  const data: SellerData = {};

  if (b.name !== undefined || mode === "create") {
    if (typeof b.name !== "string" || b.name.trim().length < 2 || b.name.trim().length > 60) return { ok: false, error: "Shop-ийн нэр 2-60 тэмдэгттэй байх ёстой" };
    data.name = b.name.trim();
  }

  if (b.slug !== undefined && b.slug !== null && String(b.slug).trim() !== "") {
    const slug = normalizeSlug(b.slug);
    if (!slug) return { ok: false, error: "Холбоос буруу — латин жижиг үсэг, тоо, зураас ашиглана (3-40 тэмдэгт), жишээ: saraa-craft" };
    data.slug = slug;
  }

  const desc = optText(b.description, 500, "Тайлбар");
  if (!desc.ok) return { ok: false, error: desc.error! };
  if (desc.value !== undefined) data.description = desc.value;

  const logo = optText(b.logoUrl, 500, "Лого холбоос");
  if (!logo.ok) return { ok: false, error: logo.error! };
  if (logo.value !== undefined) {
    if (logo.value !== null && !/^https?:\/\/\S+$/i.test(logo.value)) return { ok: false, error: "Лого холбоос http:// эсвэл https:// гэж эхэлсэн байх ёстой" };
    data.logoUrl = logo.value;
  }

  if (b.phone !== undefined || mode === "create") {
    const phone = normalizeMongolianPhone(b.phone);
    if (!phone) return { ok: false, error: "Утасны дугаарыг зөв (8 оронтой) оруулна уу" };
    data.phone = phone;
  }

  if (b.pickupAddress !== undefined || mode === "create") {
    if (typeof b.pickupAddress !== "string" || b.pickupAddress.trim().length < 5 || b.pickupAddress.trim().length > 200) {
      return { ok: false, error: "Курьер очиж авах хаяг 5-200 тэмдэгттэй байх ёстой" };
    }
    data.pickupAddress = b.pickupAddress.trim();
  }

  const lat = coord(b.pickupLatitude);
  const lng = coord(b.pickupLongitude);
  if (lat !== undefined || lng !== undefined) {
    if (lat === undefined || lng === undefined || (lat === null) !== (lng === null)) return { ok: false, error: "Өргөрөг, уртрагийг хамт оруулна уу (эсвэл хоёуланг нь хоосон орхино)" };
    if (lat !== null && lng !== null) {
      if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: "Өргөрөг/уртраг буруу байна" };
    }
    data.pickupLatitude = lat as number | null;
    data.pickupLongitude = lng as number | null;
  }

  if (b.commissionPercent !== undefined && b.commissionPercent !== null && b.commissionPercent !== "") {
    const c = typeof b.commissionPercent === "string" ? Number(b.commissionPercent) : b.commissionPercent;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > MAX_COMMISSION_PERCENT) return { ok: false, error: `Комиссын хувь 0-${MAX_COMMISSION_PERCENT}% хооронд байх ёстой` };
    data.commissionPercent = c;
  }

  for (const [key, max, label] of [["bankName", 60, "Банкны нэр"], ["bankAccountNumber", 40, "Дансны дугаар"], ["bankAccountHolder", 60, "Данс эзэмшигч"]] as const) {
    const r = optText(b[key], max, label);
    if (!r.ok) return { ok: false, error: r.error! };
    if (r.value !== undefined) data[key] = r.value;
  }

  return { ok: true, data };
}

/** Нийтэд харагдах бараа: манай өөрийн (sellerId=null) эсвэл ИДЭВХТЭЙ худалдагчийн. Prisma where хэсэг. */
export function sellerVisibleWhere() {
  return { OR: [{ sellerId: null }, { seller: { status: "ACTIVE" as const } }] };
}

/**
 * Нийтийн жагсаалтын шүүлт: Marketplace УНТАРСАН бол ЗӨВХӨН манай өөрийн бараа (худалдагчийнх огт харагдахгүй),
 * асаалттай бол манай өөрийн + ИДЭВХТЭЙ худалдагчийн бараа.
 */
export function publicProductSellerFilter(marketplaceEnabled: boolean) {
  return marketplaceEnabled ? sellerVisibleWhere() : { sellerId: null };
}

/** Мөрөн дээрх ижил дүрэм (тест, давхар шалгалтад). */
export function isProductPubliclyVisible(p: { sellerId?: string | null; seller?: { status: string } | null }): boolean {
  if (!p.sellerId) return true;
  return p.seller?.status === "ACTIVE";
}
