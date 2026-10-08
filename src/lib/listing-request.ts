// ============================================================================
// LISTING REQUEST — Худалдагчийн "шинэ бараа нэмэх хүсэлт"-ийн шалгалт (цэвэр логик).
// Хүсэлт Staff-ээр батлагдтал Product болохгүй. Staff батлахдаа нэр/үнэ/зураг/нөөцийг засаж, ангилал онооно.
// ============================================================================

import { MAX_PRICE, MAX_STOCK } from "./seller-product";

export class ListingError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "ListingError";
    this.status = status;
  }
}

/** Нэг худалдагчийн хүлээгдэж буй хүсэлтийн дээд тоо — Staff-ийг хүсэлтээр дүүргэхээс сэргийлнэ. */
export const MAX_PENDING_REQUESTS = 10;

/** Худалдагч нэг хүсэлтэд хамгийн ихдээ 5 зураг оруулна (Staff батласны дараа барааны маягтаар 10 хүртэл болгож болно). */
export const MAX_LISTING_IMAGES = 5;

export interface ListingFields {
  name: string;
  description: string | null;
  imageUrl: string | null; // түлхүүр зураг = imageUrls[0]
  imageUrls: string[];
  sellPrice: number;
  stockQty: number;
}

const FIELD_KEYS = ["name", "description", "imageUrl", "imageUrls", "sellPrice", "stockQty"];

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Зургууд: imageUrls (жагсаалт) эсвэл хуучин ганц imageUrl. Зөвхөн https; давхардал арилна; дээд тал нь MAX_LISTING_IMAGES. */
function parseListingImages(b: Record<string, unknown>): string[] {
  let raw: unknown[] = [];
  if (b.imageUrls !== undefined && b.imageUrls !== null) {
    if (!Array.isArray(b.imageUrls)) throw new ListingError("Зургийн холбоосууд жагсаалт байх ёстой");
    raw = b.imageUrls;
  } else if (b.imageUrl !== undefined && b.imageUrl !== null && b.imageUrl !== "") {
    raw = [b.imageUrl];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (item === null || item === undefined || (typeof item === "string" && item.trim() === "")) continue; // хоосон мөрийг алгасна
    if (typeof item !== "string") throw new ListingError("Зургийн холбоос буруу байна");
    const u = item.trim();
    // Зөвхөн https (storefront-д mixed-content, javascript:/data: инжекц гарахгүй)
    // Зөвшөөрөх: https:// зураг, ЭСВЭЛ манай өөрийн image-proxy хаяг (upload хийсэн зураг; хөгжүүлэлтийн орчинд http://localhost ч)
    const okUrl = /^https:\/\/[^\s"'<>]+$/i.test(u) || /^https?:\/\/[^\/\s"'<>]+\/api\/images\/[A-Za-z0-9_-]+$/i.test(u);
    if (u.length > 500 || !okUrl) throw new ListingError("Зургийн холбоос https:// гэж эхэлсэн, зайгүй, 500 тэмдэгтээс богино байх ёстой");
    if (!out.includes(u)) out.push(u);
  }
  if (out.length > MAX_LISTING_IMAGES) throw new ListingError(`Нэг хүсэлтэд хамгийн ихдээ ${MAX_LISTING_IMAGES} зураг оруулна`);
  return out;
}

/** Бүх талбарыг шалгана (шинэ хүсэлт болон Staff-ийн засвартай хэлбэр хоёуланд). */
export function validateListingFields(raw: unknown, extraAllowed: string[] = []): ListingFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ListingError("Мэдээлэл буруу байна");
  const b = raw as Record<string, unknown>;
  const bad = Object.keys(b).filter((k) => !FIELD_KEYS.includes(k) && !extraAllowed.includes(k));
  if (bad.length > 0) throw new ListingError(`Зөвшөөрөгдөөгүй талбар: ${bad[0]}`);

  if (typeof b.name !== "string" || b.name.trim().length < 2 || b.name.trim().length > 80) throw new ListingError("Барааны нэр 2-80 тэмдэгттэй байх ёстой");

  let description: string | null = null;
  if (b.description !== undefined && b.description !== null && b.description !== "") {
    if (typeof b.description !== "string" || b.description.trim().length > 1000) throw new ListingError("Тайлбар 1000 тэмдэгтээс ихгүй байх ёстой");
    description = b.description.trim() || null;
  }

  const images = parseListingImages(b);

  const price = toInt(b.sellPrice);
  if (price === null || price < 1 || price > MAX_PRICE) throw new ListingError(`Үнэ 1-ээс ${MAX_PRICE.toLocaleString("en-US")}₮ хүртэлх бүхэл тоо байх ёстой`);
  const stock = toInt(b.stockQty);
  if (stock === null || stock < 0 || stock > MAX_STOCK) throw new ListingError(`Нөөц 0-ээс ${MAX_STOCK.toLocaleString("en-US")} хүртэлх бүхэл тоо байх ёстой`);

  return { name: b.name.trim(), description, imageUrl: images[0] ?? null, imageUrls: images, sellPrice: price, stockQty: stock };
}

/** Staff-ийн батлах үеийн засвар: хүсэлтийн талбарыг дарж бичиж болно + ангилал (заавал биш). Нийлүүлсэн дүнг дахин шалгана. */
export function mergeApproval(request: ListingFields, overrides: unknown): { fields: ListingFields; categoryId: string | null } {
  if (overrides === undefined || overrides === null) return { fields: validateListingFields(request), categoryId: null };
  if (typeof overrides !== "object" || Array.isArray(overrides)) throw new ListingError("Засварын мэдээлэл буруу байна");
  const o = overrides as Record<string, unknown>;
  const unknownKeys = Object.keys(o).filter((k) => ![...FIELD_KEYS, "categoryId"].includes(k));
  if (unknownKeys.length > 0) throw new ListingError(`Зөвшөөрөгдөөгүй талбар: ${unknownKeys[0]}`);
  const { categoryId, ...rest } = o;
  // Зургийн засвар: imageUrls өгвөл түүнийг (imageUrl-ийг орхино), зөвхөн хуучин imageUrl өгвөл түүнийг ашиглана
  const base: Record<string, unknown> = { ...request };
  if ("imageUrls" in rest) delete base.imageUrl;
  else if ("imageUrl" in rest) delete base.imageUrls;
  const merged = validateListingFields({ ...base, ...rest });
  let cat: string | null = null;
  if (categoryId !== undefined && categoryId !== null && categoryId !== "") {
    if (typeof categoryId !== "string" || categoryId.length > 64) throw new ListingError("Ангилал буруу байна");
    cat = categoryId;
  }
  return { fields: merged, categoryId: cat };
}

export function validateRejectReason(reason: unknown): string {
  const t = typeof reason === "string" ? reason.trim() : "";
  if (t.length < 3) throw new ListingError("Татгалзсан шалтгаанаа бичнэ үү (дор хаяж 3 тэмдэгт)");
  if (t.length > 200) throw new ListingError("Шалтгаан 200 тэмдэгтээс ихгүй байх ёстой");
  return t;
}
