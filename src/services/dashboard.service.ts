// ============================================================================
// DASHBOARD SERVICE — POS-ын хяналтын самбар: өнөөдрийн борлуулалт, 7 хоногийн график, АНХААРАХ ЗҮЙЛС (хийх ажлууд).
// ============================================================================

import { prisma } from "../lib/prisma";
import { aggregateByDay, countLowStock, lastDays, trendPercent, ubDayStartUtc } from "../lib/dashboard";
import { getSellerSettlementTotals } from "./seller-settlement.service";

export async function getDashboardSummary(nowMs: number = Date.now()) {
  const keys = lastDays(nowMs, 7);
  const since = ubDayStartUtc(nowMs, 6);
  const orders: any[] = await prisma.order.findMany({ where: { createdAt: { gte: since } } as any, select: { createdAt: true, paidAmount: true, cancelledAt: true }, take: 20000 } as any);
  const week = aggregateByDay(orders, keys);
  const today = week[week.length - 1];
  const yesterday = week[week.length - 2];

  const [sellerAwaiting, sellerReadyNotOffered, listingRequests, refundsDue, lowRated, featuredPending, featuredRefunds] = await Promise.all([
    prisma.order.count({ where: { sellerStatus: "AWAITING_SELLER" as any, cancelledAt: null } as any }),
    prisma.order.count({ where: { sellerStatus: "READY" as any, deliveryAssignStatus: "UNASSIGNED" as any, cancelledAt: null } as any }),
    prisma.productListingRequest.count({ where: { status: "PENDING" as any } }),
    prisma.order.count({ where: { refundDueAmount: { gt: 0 }, refundedAt: null } as any }),
    prisma.productReview.count({ where: { stars: { lte: 2 }, isHidden: false, createdAt: { gte: new Date(nowMs - 30 * 86400_000) } } as any }),
    // ✅ Staff-ийн ажил: зөвшөөрөл хүлээж буй хүсэлт + "шилжүүлсэн" гэж мэдэгдсэн (шалгах) онцлох зар
    prisma.featuredPromotion.count({ where: { status: { in: ["REQUESTED", "PENDING_PAYMENT", "PAYMENT_REPORTED"] } as any } }),
    prisma.featuredPromotion.count({ where: { refundDueAmount: { gt: 0 }, refundedAt: null } as any }), // буцаах ёстой мөнгө
  ]);
  const products: any[] = await prisma.product.findMany({ where: { isActive: true, isRental: false, usesMaterialPricing: false } as any, select: { sellStockQty: true, minStockAlert: true, isActive: true, isRental: true, usesMaterialPricing: true } as any });
  let payableTotal = 0;
  let payableSellers = 0;
  for (const t of (await getSellerSettlementTotals(nowMs)).values()) {
    if (t.payableTotal > 0) {
      payableTotal += t.payableTotal;
      payableSellers++;
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    today: { orders: today.orders, revenue: today.revenue, revenueTrend: trendPercent(today.revenue, yesterday.revenue), ordersTrend: trendPercent(today.orders, yesterday.orders) },
    yesterday: { orders: yesterday.orders, revenue: yesterday.revenue },
    week,
    weekTotal: { orders: week.reduce((s, d) => s + d.orders, 0), revenue: week.reduce((s, d) => s + d.revenue, 0) },
    attention: {
      sellerAwaiting,
      sellerReadyNotOffered,
      listingRequests,
      refundsDue,
      lowStock: countLowStock(products),
      lowRatedReviews: lowRated,
      featuredPending,
      featuredRefunds,
      sellerPayableTotal: Math.round(payableTotal),
      sellerPayableCount: payableSellers,
    },
  };
}
