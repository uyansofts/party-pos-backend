// ============================================================================
// PUBLIC PRODUCT — Нийтэд (storefront) гаргах барааны ХЭЛБЭР (нэг л газар). /products, /home, /similar бүгд ИЖИЛ хэлбэртэй —
// storefront-ын карт, сагслах (addToCart) бүгд нэг объектоор ажиллана.
// ⚠️ ЗӨВХӨН нийтэд зориулсан талбар: costPrice, minStockAlert, дотоод description (Байршил, Баркод) ГАРАХГҮЙ.
// ============================================================================

import { parseStoredCustomFieldDefs } from "./custom-fields";
import { galleryOf } from "./product-images";
import { applySale, isSaleActive, salePercent } from "./pricing";
import { isFeaturedNow } from "./featured";

export const PUBLIC_PRODUCT_INCLUDE = {
        category: { select: { name: true } },
        seller: { select: { id: true, name: true, slug: true } }, // ✅ ШИНЭ
        // ✅ ШИНЭ: Тусгай захиалгын Variation-уудыг storefront-д харуулна
        variationGroups: { include: { values: { orderBy: { sortOrder: "asc" } } }, orderBy: { sortOrder: "asc" } },
        // ✅ ШИНЭ: Энэ бараанд зөвшөөрөгдсөн материалууд (Storefront swatch-даа ашиглана)
        allowedMaterials: { where: { isActive: true }, select: { id: true, name: true, imageUrl: true, sheetWidthCm: true, sheetHeightCm: true } },
      } as const;

/** Нөөцтэй эсэх: материалаар үнэлэгдэх бараа захиалгаар хийгддэг; түрээс — түрээсийн нөөц; бусад — борлуулах нөөц. */
export function computeInStock(p: { usesMaterialPricing?: boolean; isRental?: boolean; rentalStockQty?: number | null; sellStockQty?: number | null }): boolean {
  return p.usesMaterialPricing ? true : p.isRental ? (p.rentalStockQty ?? 0) > 0 : (p.sellStockQty ?? 0) > 0;
}

export function toPublicProduct(p: any, rating?: { avg: number | null; count: number }, now: Date = new Date()) {
  const onSale = isSaleActive(p, now);
  return {
      id: p.id,
      name: p.name,
      // ✅ ЗАСВАР: description нь ДОТООД (Байршил, Баркод) тул нийтэд ГАРГАХГҮЙ — зөвхөн харилцагчид зориулсан publicDescription
      description: (p as any).publicDescription ?? null,
      imageUrl: p.imageUrl,
      imageUrls: galleryOf(p as any), // ✅ ШИНЭ — олон зураг (түлхүүр нь эхэнд)
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      seller: p.seller ? { id: p.seller.id, name: p.seller.name, slug: p.seller.slug } : null, // ✅ ШИНЭ — null = манай өөрийн бараа
      color: p.color,
      size: p.size,
      isRental: p.isRental,
      isCraft: p.isCraft,
      // ✅ ШИНЭ: sellPrice = харилцагч ТӨЛӨХ үнэ (хямдрал идэвхтэй бол хямдралын үнэ). Сервер захиалгад ЯГ ИЖИЛ үнийг ашиглана.
    // Хямдрал БҮХ төрлийн бараанд: суурь үнэ, түрээсийн өдрийн үнэд хувийг хэрэглэнэ. Материалын үнийг клиент өөрөө (salePercent-аар) тооцно.
    sellPrice: p.sellPrice != null && onSale ? applySale(p, Number(p.sellPrice), now) : p.sellPrice,
    compareAtPrice: onSale && p.sellPrice != null && Number(p.sellPrice) > 0 ? p.sellPrice : null, // хямдралын өмнөх үнэ (зураастай харуулна)
    compareAtRentalPrice: onSale && p.isRental && p.rentalPricePerDay != null ? p.rentalPricePerDay : null,
    salePercent: salePercent(p, now),
    saleEndsAt: onSale ? p.saleEndsAt ?? null : null,
    isFeatured: isFeaturedNow(p, now), // storefront-д "⭐ Онцлох" — төлбөртэй байрлалын хугацаа дууссан бол автоматаар үгүй
      rentalPricePerDay: p.rentalPricePerDay != null && onSale && p.isRental ? applySale(p, Number(p.rentalPricePerDay), now) : p.rentalPricePerDay,
      depositAmount: p.depositAmount,
      // ⚠️ Кассны (сагслах) талд үлдэгдлээс хэтрүүлж нэмэхээс сэргийлэхийн
      // тулд аюулгүй БОЛОМЖИТ ТОО-г буцаана (яг нарийн sellStockQty биш,
      // гэхдээ хязгаарлалт хийхэд хангалттай).
      // ✅ ШИНЭ: Материалаар үнэлэгдэх бараа нь захиалгаар хийгддэг тул барааны нөөцөөс хамаарахгүй
      availableQty: p.usesMaterialPricing ? 999 : p.isRental ? (p.rentalStockQty ?? 0) : p.sellStockQty,
      inStock: p.usesMaterialPricing ? true : p.isRental ? (p.rentalStockQty ?? 0) > 0 : p.sellStockQty > 0,
      usesMaterialPricing: p.usesMaterialPricing, // ✅ ШИНЭ
      customFields: parseStoredCustomFieldDefs(p.customFields), // ✅ ШИНЭ — Хувийн мэдээллийн талбарууд
      serviceEnabled: p.serviceEnabled, // ✅ ШИНЭ — Нэмэлт үйлчилгээ (жишээ: бөмбөлгөн чимэглэлийг биднээр хийлгэх)
      serviceRequiresCourierDelivery: p.serviceRequiresCourierDelivery, // ✅ ШИНЭ — true бол зөвхөн манай курьер, false бол ямар ч аргаар
      serviceLabel: p.serviceLabel,
      serviceFee: p.serviceFee != null ? Number(p.serviceFee) : null,
      // ✅ ЗАСВАР: Дутуу байсан — Тусгай захиалгын талбарууд storefront-д
      // огт хүрдэггүй байсан тул Customization модал ГАРДАГГҮЙ байсан.
      isCustomizable: p.isCustomizable,
      personalizationEnabled: p.personalizationEnabled,
      personalizationLabel: p.personalizationLabel,
      personalizationMaxLength: p.personalizationMaxLength,
      personalizationRequired: p.personalizationRequired,
      variationGroups: p.variationGroups,
      allowedMaterials: p.allowedMaterials, // ✅ ШИНЭ — хоосон бол Storefront БҮХ идэвхтэй материалыг харуулна (хуучин зан төлөвтэй нийцнэ)
    
    ratingAvg: rating?.avg ?? null, // ✅ ШИНЭ — барааны үнэлгээ (хувилбар бүр өөрийнхөөрөө)
    ratingCount: rating?.count ?? 0,
  };
}

/** Staff-ийн "⭐ Онцлох" тохиргоо: isFeatured (boolean), featuredOrder (0-9999, бага нь эхэнд; онцлохоо болиход автоматаар арилна). */
export function parseFeatured(isFeatured: unknown, featuredOrder: unknown): { isFeatured?: boolean; featuredOrder?: number | null } {
  const out: { isFeatured?: boolean; featuredOrder?: number | null } = {};
  if (isFeatured !== undefined) {
    if (typeof isFeatured !== "boolean") throw new Error("isFeatured true эсвэл false байх ёстой");
    out.isFeatured = isFeatured;
    if (!isFeatured) out.featuredOrder = null;
  }
  if (featuredOrder !== undefined && !("featuredOrder" in out)) {
    if (featuredOrder === null || featuredOrder === "") out.featuredOrder = null;
    else {
      const n = typeof featuredOrder === "string" && /^\d{1,4}$/.test(featuredOrder.trim()) ? Number(featuredOrder.trim()) : featuredOrder;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 9999) throw new Error("Онцлох дараалал 0-9999 хоорондох бүхэл тоо байх ёстой");
      out.featuredOrder = n;
    }
  }
  return out;
}
