// ============================================================================
// SELLER PRODUCT SERVICE — Худалдагч порталаас ӨӨРИЙН барааны нөөц, үнэ, харуулах/нуухыг засна.
//   • Бараа бүрт sellerId шалгана — бусдын бараа "олдсонгүй" (оршихуйг ч задруулахгүй)
//   • Нөөц: "харсан тоо" (expectedStockQty)-той атомик шинэчлэл — зэрэг орсон захиалгын хасалтыг дарж бичихгүй
//   • Нөөцийн өөрчлөлт бүр StockMovement(ADJUSTMENT, тэмдэгтэй) аудитад үлдэнэ
// ============================================================================

import { prisma } from "../lib/prisma";
import { SellerProductError, productEditability, validateProductPatch } from "../lib/seller-product";
import { PricingError, isSaleActive, isSaleScheduled, planSaleChange, saleBlocksPriceChange } from "../lib/pricing"; // ✅ ШИНЭ — хямдрал
import { isFeaturedNow } from "../lib/featured";

/** Порталд харагдах ЗӨВШӨӨРСӨН талбарууд (allowlist). costPrice, SKU-ийн дотоод, Staff-ийн талбар ГАРАХГҮЙ. */
export function toPortalProduct(p: any) {
  const flags = { usesMaterialPricing: !!p.usesMaterialPricing, isRental: !!p.isRental, staffLocked: !!p.staffLocked };
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    imageUrl: p.imageUrl ?? null,
    sellPrice: Number(p.sellPrice ?? 0),
    sellStockQty: Number(p.sellStockQty ?? 0),
    isActive: !!p.isActive,
    // ✅ ШИНЭ: хямдрал, онцлох (комисс нэмэгдэх тул худалдагч мэдэх ёстой)
    salePercent: p.salePercent ?? null, // хямдралын хувь (эх сурвалж)
    salePrice: p.salePrice != null ? Number(p.salePrice) : null, // тооцогдсон хямдралтай үнэ
    saleStartsAt: p.saleStartsAt ?? null,
    saleEndsAt: p.saleEndsAt ?? null,
    saleActive: isSaleActive(p),
    saleScheduled: isSaleScheduled(p), // ирээдүйд эхэлнэ
    priceLocked: saleBlocksPriceChange(p), // хямдралтай/товлогдсон үед үндсэн үнийг өөрчилж болохгүй
    isFeatured: isFeaturedNow(p),
    featuredUntil: isFeaturedNow(p) ? p.featuredUntil ?? null : null, // төлбөртэй байрлалын дуусах хугацаа (null = дэлгүүр хугацаагүй онцолсон)
    isRental: flags.isRental,
    usesMaterialPricing: flags.usesMaterialPricing,
    staffLocked: flags.staffLocked,
    ...productEditability(flags),
  };
}

export async function listSellerProducts(sellerId: string) {
  const rows = await prisma.product.findMany({ where: { sellerId }, orderBy: { name: "asc" }, take: 500 });
  return rows.map(toPortalProduct);
}

export async function updateSellerProduct(sellerId: string, productId: string, body: unknown) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.product.findFirst({ where: { id: productId, sellerId } });
    if (!p) throw new SellerProductError("Бараа олдсонгүй", 404);

    const patch = validateProductPatch(body, { usesMaterialPricing: !!p.usesMaterialPricing, isRental: !!p.isRental, staffLocked: !!(p as any).staffLocked });
    const data: Record<string, unknown> = {};
    if (patch.isActive !== undefined) data.isActive = patch.isActive;
    if (patch.sellStockQty !== undefined) data.sellStockQty = patch.sellStockQty;
    // Үнэ + хямдрал: НЭГ дүрэм (хувь, огноо, 14 хоногийн тогтвортой байдал, хямдралтай үед үнэ түгжих)
    if (patch.sellPrice !== undefined || patch.salePercent !== undefined) {
      try {
        Object.assign(data, planSaleChange(p as any, {
          sellPrice: patch.sellPrice,
          priceOptional: !!(p as any).usesMaterialPricing || !!(p as any).isRental, // материалтай/түрээсийн бараа суурь үнэгүй ч хямдарна
          sale: patch.salePercent !== undefined ? { percent: patch.salePercent, starts: patch.saleStartsAt, ends: patch.saleEndsAt } : undefined,
        }));
      } catch (err) {
        if (err instanceof PricingError) throw new SellerProductError(err.message, err.status);
        throw err;
      }
    }
    if (patch.sellPrice !== undefined) data.sellPrice = patch.sellPrice;

    const r = await tx.product.updateMany({
      where: { id: productId, sellerId, ...(patch.sellStockQty !== undefined ? { sellStockQty: patch.expectedStockQty } : {}) },
      data: data as any,
    });
    if (r.count === 0) {
      throw new SellerProductError(
        patch.sellStockQty !== undefined ? "Нөөц өөрчлөгдсөн байна (шинэ захиалга орсон байж болно) — шинэчилсэн тоог харж, дахин оруулна уу" : "Бараа олдсонгүй",
        patch.sellStockQty !== undefined ? 409 : 404
      );
    }

    if (patch.sellStockQty !== undefined && patch.sellStockQty !== patch.expectedStockQty) {
      await tx.stockMovement.create({
        data: {
          productId,
          type: "ADJUSTMENT" as any,
          quantity: patch.sellStockQty - (patch.expectedStockQty as number), // тэмдэгтэй: дутсан бол сөрөг (одоогийн нөөц тохируулгын конвенц)
          note: `Худалдагч порталаас тохируулав: ${patch.expectedStockQty} → ${patch.sellStockQty}`,
        },
      });
    }
    const fresh = await tx.product.findFirst({ where: { id: productId, sellerId } });
    return toPortalProduct(fresh);
  });
}
