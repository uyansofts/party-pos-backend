import { prisma } from "../lib/prisma";
import { roundRating, CourierStats } from "../lib/courier-identity";

/** Курьер бүрийн дундаж од, үнэлгээний тоо, хүргэсэн тоо — 2 асуулгаар (N курьерт N биш). */
export async function getCourierStats(courierIds: string[]): Promise<Map<string, CourierStats>> {
  const ids = Array.from(new Set(courierIds.filter(Boolean)));
  const result = new Map<string, CourierStats>();
  for (const id of ids) result.set(id, { ratingAverage: null, ratingCount: 0, completedDeliveries: 0 });
  if (ids.length === 0) return result;

  const [ratings, deliveries] = await Promise.all([
    prisma.deliveryRating.groupBy({ by: ["courierId"], where: { courierId: { in: ids } }, _avg: { stars: true }, _count: { _all: true } }) as unknown as Promise<any[]>,
    prisma.order.groupBy({ by: ["courierId"], where: { courierId: { in: ids }, deliveryAssignStatus: "DELIVERED" as any }, _count: { _all: true } }) as unknown as Promise<any[]>,
  ]);
  for (const r of ratings) {
    const cur = result.get(r.courierId);
    if (cur) {
      cur.ratingAverage = roundRating(r._avg?.stars);
      cur.ratingCount = r._count?._all ?? 0;
    }
  }
  for (const d of deliveries) {
    const cur = d.courierId ? result.get(d.courierId) : undefined;
    if (cur) cur.completedDeliveries = d._count?._all ?? 0;
  }
  return result;
}
