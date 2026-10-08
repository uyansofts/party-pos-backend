// ============================================================================
// HOME SERVICE — Нүүр хуудасны мөрүүд (Etsy шиг): ⭐ Онцлох, 🆕 Шинэ, 🔥 Эрэлттэй, ⭐ Өндөр үнэлгээтэй.
//   • Marketplace унтраатай үед худалдагчийн бараа ОРОХГҮЙ (нийтийн /products-той ижил дүрэм)
//   • Дууссан бараа мөрөнд орохгүй; бараа бүр (худалдагч + нэр) нэг л удаа — хувилбарууд мөрийг дүүргэхгүй
//   • 60 секундын кэш — нүүр хуудас бүрт хүнд асуулга хийхгүй
// ============================================================================

import { prisma } from "../lib/prisma";
import { publicProductSellerFilter } from "../lib/seller";
import { PUBLIC_PRODUCT_INCLUDE, computeInStock, toPublicProduct } from "../lib/public-product";
import { isTopRated } from "../lib/reviews";
import { isSaleActive, salePercent } from "../lib/pricing";
import { isFeaturedNow } from "../lib/featured";
import { getRatingMap } from "./review.service";

const ROW_SIZE = 12;
const CACHE_MS = 60_000;
const BEST_SELLER_DAYS = 90;
let cache: { at: number; data: any } | null = null;
export function clearHomeCache() {
  cache = null;
}

/** Мөр бүрд бүлэг (худалдагч + нэр) тутамд ЭХНИЙ нэг л бараа; дараалал хэвээр. */
export function dedupeByGroup<T extends { name: string; seller?: { id: string } | null; sellerId?: string | null }>(products: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of products) {
    const key = `${p.seller?.id ?? p.sellerId ?? ""}::${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export async function getHomeSections(nowMs: number = Date.now()) {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.data;

  const settings: any = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const visible = { isActive: true, AND: [publicProductSellerFilter(Boolean(settings?.marketplaceEnabled))] };
  const ratings = await getRatingMap();
  const finish = (rows: any[]) => dedupeByGroup(rows.filter((p) => computeInStock(p))).slice(0, ROW_SIZE).map((p) => toPublicProduct(p, ratings.get(p.id), new Date(nowMs)));
  const byIds = async (ids: string[]) => {
    if (ids.length === 0) return [] as any[];
    const rows: any[] = await prisma.product.findMany({ where: { ...visible, id: { in: ids } } as any, include: PUBLIC_PRODUCT_INCLUDE as any });
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)); // эрэмбийг хадгална
  };

  const featuredRows: any[] = await prisma.product.findMany({
    where: { ...visible, isFeatured: true } as any,
    include: PUBLIC_PRODUCT_INCLUDE as any,
    orderBy: [{ featuredOrder: "asc" }, { name: "asc" }] as any,
    take: 40,
  });
  const newRows: any[] = await prisma.product.findMany({ where: visible as any, include: PUBLIC_PRODUCT_INCLUDE as any, orderBy: { createdAt: "desc" }, take: 60 });

  const sold: any[] = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: { itemType: "SALE", order: { paymentStatus: "PAID", cancelledAt: null, createdAt: { gte: new Date(nowMs - BEST_SELLER_DAYS * 86400000) } } } as any,
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 40,
  } as any);
  const bestRows = await byIds(sold.filter((s) => (s._sum?.quantity ?? 0) > 0).map((s) => s.productId));

  const topIds = [...ratings.entries()]
    .filter(([, r]) => isTopRated(r))
    .sort((a, b) => (b[1].avg ?? 0) - (a[1].avg ?? 0) || b[1].count - a[1].count)
    .map(([id]) => id)
    .slice(0, 40);
  const topRows = await byIds(topIds);

  // 🏷 Хямдралтай: идэхтэй хямдралтай, нөөцтэй бараа — хямдралын хувь их нь эхэнд
  const saleRows: any[] = await prisma.product.findMany({ where: { ...visible, OR: [{ salePercent: { not: null } }, { salePrice: { not: null } }] } as any, include: PUBLIC_PRODUCT_INCLUDE as any, take: 100 });
  const now = new Date(nowMs);
  const onSaleRows = saleRows.filter((p) => isSaleActive(p, now)).sort((a, b) => (salePercent(b, now) ?? 0) - (salePercent(a, now) ?? 0));

  const data = { featured: finish(featuredRows.filter((p) => isFeaturedNow(p, now))), onSale: finish(onSaleRows), newArrivals: finish(newRows), bestSellers: finish(bestRows), topRated: finish(topRows) };
  cache = { at: nowMs, data };
  return data;
}
