// ============================================================================
// SELLER PRODUCT — Худалдагчийн порталаас барааг (нөөц, үнэ, харуулах/нуух) засах дүрэм (цэвэр логик).
// Худалдагч ЗӨВХӨН дараах 3 зүйлийг засна: үнэ, нөөц, харуулах/нуух. Нэр, зураг, ангилал, өртөг, багц, материал
// зэргийг Staff удирдана (брэндийн чанар, хуурамч бараанаас хамгаалах).
// ============================================================================

export class SellerProductError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "SellerProductError";
    this.status = status;
  }
}

export const MAX_PRICE = 100_000_000;
export const MAX_STOCK = 1_000_000;

export interface ProductFlags {
  usesMaterialPricing: boolean;
  isRental: boolean;
  staffLocked: boolean;
}

/** Бараа бүрт юуг засаж болох вэ: материалаар үнэлэгдэх бараа үнэ/нөөцгүй, түрээсийн бараа нөөцгүй, Staff нуусан бараа асаахгүй. */
export function productEditability(p: ProductFlags): { canEditPrice: boolean; canEditStock: boolean; canToggle: boolean } {
  return { canEditPrice: !p.usesMaterialPricing, canEditStock: !p.usesMaterialPricing && !p.isRental, canToggle: !p.staffLocked };
}

export interface ProductPatch {
  sellPrice?: number;
  sellStockQty?: number;
  expectedStockQty?: number; // Худалдагчийн ХАРСАН нөөцийн тоо — зэрэг орсон захиалгыг дарж бичихээс сэргийлнэ
  isActive?: boolean;
  salePercent?: unknown; // ✅ ШИНЭ — хямдралын ХУВЬ 1-70 (null = цуцлах); үнийг сервер тооцно
  saleStartsAt?: unknown; // "YYYY-MM-DD"
  saleEndsAt?: unknown; // "YYYY-MM-DD"
}

const ALLOWED = ["sellPrice", "sellStockQty", "expectedStockQty", "isActive", "salePercent", "saleStartsAt", "saleEndsAt"];

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
}

export function validateProductPatch(body: unknown, flags: ProductFlags): ProductPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SellerProductError("Мэдээлэл буруу байна");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !ALLOWED.includes(k));
  if (unknown.length > 0) throw new SellerProductError(`Энэ талбарыг порталаас засах боломжгүй: ${unknown[0]}`);
  const can = productEditability(flags);
  const out: ProductPatch = {};

  if (b.sellPrice !== undefined) {
    if (!can.canEditPrice) throw new SellerProductError("Материалаар үнэлэгдэх барааны үнийг дэлгүүр тохируулна");
    const price = toInt(b.sellPrice);
    if (price === null || price < 1 || price > MAX_PRICE) throw new SellerProductError(`Үнэ 1-ээс ${MAX_PRICE.toLocaleString("en-US")}₮ хүртэлх бүхэл тоо байх ёстой`);
    out.sellPrice = price;
  }

  if (b.sellStockQty !== undefined) {
    if (!can.canEditStock) throw new SellerProductError("Энэ барааны нөөцийг порталаас тохируулах боломжгүй (түрээс эсвэл материалаар үнэлэгдэх бараа)");
    const qty = toInt(b.sellStockQty);
    if (qty === null || qty < 0 || qty > MAX_STOCK) throw new SellerProductError(`Нөөц 0-ээс ${MAX_STOCK.toLocaleString("en-US")} хүртэлх бүхэл тоо байх ёстой`);
    const expected = toInt(b.expectedStockQty);
    if (expected === null || expected < 0) throw new SellerProductError("Одоо харж буй нөөцийн тоо (expectedStockQty) шаардлагатай — хуудсаа шинэчилнэ үү");
    out.sellStockQty = qty;
    out.expectedStockQty = expected;
  } else if (b.expectedStockQty !== undefined) {
    throw new SellerProductError("expectedStockQty-г зөвхөн нөөц өөрчлөхтэй хамт өгнө");
  }

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== "boolean") throw new SellerProductError("isActive true эсвэл false байх ёстой");
    if (!can.canToggle) throw new SellerProductError("Дэлгүүр энэ барааг түр нууцалсан тул та дахин харуулах боломжгүй — дэлгүүртэй холбогдоно уу", 403);
    out.isActive = b.isActive;
  }

  if (b.salePercent !== undefined || b.saleStartsAt !== undefined || b.saleEndsAt !== undefined) {
    if (b.salePercent === undefined) throw new SellerProductError("Хямдралын хувийг өгнө үү (цуцлахын тулд хоосон)");
    out.salePercent = b.salePercent;
    out.saleStartsAt = b.saleStartsAt;
    out.saleEndsAt = b.saleEndsAt;
  }

  if (out.sellPrice === undefined && out.sellStockQty === undefined && out.isActive === undefined && out.salePercent === undefined) throw new SellerProductError("Өөрчлөх зүйл алга");
  return out;
}
