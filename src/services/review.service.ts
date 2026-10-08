// ============================================================================
// REVIEW SERVICE — Барааны үнэлгээ (Etsy шиг): баталгаажсан худалдан авагч л үнэлнэ, нэр нууцлагдана, Staff хянана.
// ============================================================================

import { prisma } from "../lib/prisma";
import { ReviewError, canEditReview, canReviewOrder, maskAuthorName, summarizeRatings, validateReviewInput, type RatingSummary } from "../lib/reviews";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** productId → { avg, count } (нуугдсан сэтгэгдлийг оруулахгүй). productIds өгөөгүй бол бүх бараа. */
export async function getRatingMap(productIds?: string[]): Promise<Map<string, { avg: number | null; count: number }>> {
  const rows = await prisma.productReview.groupBy({
    by: ["productId"],
    where: { isHidden: false, ...(productIds ? { productId: { in: productIds } } : {}) },
    _avg: { stars: true },
    _count: { _all: true },
  } as any);
  const map = new Map<string, { avg: number | null; count: number }>();
  for (const r of rows as any[]) map.set(r.productId, { avg: r._avg?.stars != null ? round1(Number(r._avg.stars)) : null, count: r._count?._all ?? 0 });
  return map;
}

/** Худалдагчийн shop-ийн дундаж үнэлгээ (түүний бүх барааны нэгтгэл). */
export async function getSellerRating(sellerId: string): Promise<{ avg: number | null; count: number }> {
  const r: any = await prisma.productReview.aggregate({ where: { isHidden: false, product: { sellerId } } as any, _avg: { stars: true }, _count: { _all: true } } as any);
  return { avg: r._avg?.stars != null ? round1(Number(r._avg.stars)) : null, count: r._count?._all ?? 0 };
}

/**
 * Харилцагч (хяналтын токеноор баталгаажсан захиалгаараа) бараагаа үнэлнэ. Захиалга бүрийн бараа бүрт НЭГ үнэлгээ;
 * 30 хоногийн дотор засаж болно. Бараагаа ХҮЛЭЭН АВААГҮЙ бол үнэлж болохгүй (хуурамч үнэлгээнээс хамгаална).
 */
export async function submitProductReview(orderId: string, productId: unknown, stars: unknown, comment: unknown, nowMs: number = Date.now()) {
  const v = validateReviewInput(stars, comment);
  if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) throw new ReviewError("Үнэлэх барааг сонгоно уу");
  const order: any = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, deliveryMethod: true, deliveryAssignStatus: true, paymentStatus: true, cancelledAt: true, createdAt: true, customer: { select: { name: true } }, items: { select: { productId: true } } },
  });
  if (!order) throw new ReviewError("Захиалга олдсонгүй", 404);
  if (!canReviewOrder(order, nowMs)) throw new ReviewError("Бараагаа хүлээн авсны дараа үнэлнэ үү", 403);
  if (!order.items.some((i: any) => i.productId === productId)) throw new ReviewError("Энэ захиалгад тэр бараа байхгүй", 404);

  const existing: any = await prisma.productReview.findUnique({ where: { orderId_productId: { orderId, productId } } } as any);
  if (existing) {
    if (!canEditReview(existing.createdAt, nowMs)) throw new ReviewError("Үнэлгээг засах хугацаа (30 хоног) дууссан", 403);
    const upd: any = await prisma.productReview.update({ where: { id: existing.id }, data: { stars: v.stars, comment: v.comment } });
    return { stars: upd.stars, comment: upd.comment ?? null, updated: true };
  }
  const created: any = await prisma.productReview.create({
    data: { productId, orderId, customerId: order.customerId ?? null, stars: v.stars, comment: v.comment, authorName: maskAuthorName(order.customer?.name) },
  });
  return { stars: created.stars, comment: created.comment ?? null, updated: false };
}

/** Нийтийн жагсаалт: нэг бараа ЭСВЭЛ хувилбартай бүлгийн (олон productId) нийт үнэлгээ + сэтгэгдэл. Нууцлагдсан нэр л гарна. */
export async function listPublicReviews(productIds: string[], limit: number = 10, offset: number = 0) {
  const ids = Array.from(new Set(productIds.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)))).slice(0, 20);
  const take = Math.min(30, Math.max(1, Math.floor(limit) || 10));
  const skip = Math.max(0, Math.floor(offset) || 0);
  if (ids.length === 0) return { summary: summarizeRatings([]), items: [], hasMore: false };
  const where = { isHidden: false, productId: { in: ids } };
  const dist: any[] = await prisma.productReview.groupBy({ by: ["stars"], where, _count: { _all: true } } as any);
  const expanded: Array<{ stars: number }> = [];
  for (const d of dist) for (let i = 0; i < (d._count?._all ?? 0); i++) expanded.push({ stars: d.stars });
  const summary: RatingSummary = summarizeRatings(expanded);
  const rows: any[] = await prisma.productReview.findMany({
    where, orderBy: { createdAt: "desc" }, skip, take: take + 1,
    include: { product: { select: { size: true, color: true } } },
  } as any);
  return {
    summary,
    items: rows.slice(0, take).map((r) => ({ id: r.id, stars: r.stars, comment: r.comment ?? null, author: r.authorName, createdAt: r.createdAt, variant: [r.product?.size, r.product?.color].filter(Boolean).join(", ") || null })),
    hasMore: rows.length > take,
  };
}

// ---------------------------- Staff (хяналт) ----------------------------

export async function listReviewsForModeration(hidden?: boolean) {
  const rows: any[] = await prisma.productReview.findMany({
    where: hidden === undefined ? {} : { isHidden: hidden },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { product: { select: { name: true, size: true, color: true } } },
  } as any);
  return rows.map((r) => ({ id: r.id, stars: r.stars, comment: r.comment ?? null, authorName: r.authorName, isHidden: r.isHidden, createdAt: r.createdAt, productName: r.product?.name ?? "", variant: [r.product?.size, r.product?.color].filter(Boolean).join(", ") || null }));
}

export async function setReviewHidden(id: string, hidden: unknown) {
  if (typeof hidden !== "boolean") throw new ReviewError("hidden true эсвэл false байх ёстой");
  const r = await prisma.productReview.updateMany({ where: { id }, data: { isHidden: hidden } });
  if (r.count === 0) throw new ReviewError("Үнэлгээ олдсонгүй", 404);
  return { id, isHidden: hidden };
}
