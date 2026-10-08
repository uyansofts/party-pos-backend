// ============================================================================
// SIMILAR SERVICE — "Төстэй бараа" (оноог lib/product-similarity тодорхойлно). Marketplace унтраатай үед худалдагчийн бараа орохгүй.
// ============================================================================

import { prisma } from "../lib/prisma";
import { publicProductSellerFilter } from "../lib/seller";
import { PUBLIC_PRODUCT_INCLUDE, computeInStock, toPublicProduct } from "../lib/public-product";
import { rankSimilar, type SimProduct } from "../lib/product-similarity";
import { getRatingMap } from "./review.service";

export class SimilarError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 404) {
    super(message);
    this.name = "SimilarError";
    this.status = status;
  }
}

const toSim = (p: any, ratings: Map<string, { avg: number | null; count: number }>): SimProduct => ({
  id: p.id,
  name: p.name,
  categoryId: p.categoryId ?? null,
  sellerId: p.seller?.id ?? p.sellerId ?? null,
  isRental: !!p.isRental,
  sellPrice: Number(p.sellPrice ?? 0),
  rentalPricePerDay: Number(p.rentalPricePerDay ?? 0),
  color: p.color ?? null,
  size: p.size ?? null,
  inStock: computeInStock(p),
  ratingAvg: ratings.get(p.id)?.avg ?? null,
  ratingCount: ratings.get(p.id)?.count ?? 0,
});

export async function getSimilarProducts(productId: string, limit: number = 8) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) throw new SimilarError("Бараа олдсонгүй");
  const settings: any = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const visible = { isActive: true, AND: [publicProductSellerFilter(Boolean(settings?.marketplaceEnabled))] };

  const base: any = await prisma.product.findFirst({ where: { ...visible, id: productId } as any, include: PUBLIC_PRODUCT_INCLUDE as any });
  if (!base) throw new SimilarError("Бараа олдсонгүй");

  const candidates: any[] = await prisma.product.findMany({ where: { ...visible, id: { not: productId } } as any, include: PUBLIC_PRODUCT_INCLUDE as any, orderBy: { createdAt: "desc" }, take: 400 });
  const cats: any[] = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const parentOf = new Map<string, string | null>(cats.map((c) => [c.id, c.parentId ?? null]));
  const ratings = await getRatingMap([base.id, ...candidates.map((c) => c.id)]);

  const ranked = rankSimilar(toSim(base, ratings), candidates.map((c) => toSim(c, ratings)), parentOf, Math.min(16, Math.max(1, Math.floor(limit) || 8)));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return ranked.map((r) => toPublicProduct(byId.get(r.id), ratings.get(r.id)));
}
