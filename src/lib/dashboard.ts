// ============================================================================
// DASHBOARD — POS-ын "Хяналтын самбар"-ын тооцоо (цэвэр логик). Өдөр = Улаанбаатарын өдөр (UTC+8).
// ============================================================================

const UB_MS = 8 * 3600_000;
const DAY_MS = 86400_000;

/** Улаанбаатарын өдрийн түлхүүр "YYYY-MM-DD". */
export function ubDayKey(ms: number): string {
  return new Date(ms + UB_MS).toISOString().slice(0, 10);
}

/** n хоногийн түлхүүр: хамгийн хуучин нь эхэнд, өнөөдөр сүүлд. */
export function lastDays(nowMs: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => ubDayKey(nowMs - (n - 1 - i) * DAY_MS));
}

/** n хоногийн өмнөх УБ-ын өдрийн ЭХЛЭЛ (UTC дээр): n=0 өнөөдрийн 00:00 УБ. */
export function ubDayStartUtc(nowMs: number, daysBack: number): Date {
  const key = ubDayKey(nowMs - daysBack * DAY_MS);
  return new Date(Date.parse(key + "T00:00:00Z") - UB_MS);
}

export interface DashOrder {
  createdAt: Date | string;
  paidAmount?: unknown;
  cancelledAt?: Date | string | null;
}

/** Өдөр тутмын захиалгын тоо, ТӨЛСӨН дүн (цуцлагдсаныг оруулахгүй). */
export function aggregateByDay(orders: DashOrder[], keys: string[]): Array<{ day: string; orders: number; revenue: number }> {
  const acc = new Map(keys.map((k) => [k, { day: k, orders: 0, revenue: 0 }]));
  for (const o of orders) {
    if (o.cancelledAt) continue;
    const t = new Date(o.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
    const slot = acc.get(ubDayKey(t));
    if (!slot) continue;
    slot.orders++;
    const paid = Number(o.paidAmount);
    if (Number.isFinite(paid) && paid > 0) slot.revenue += paid;
  }
  return keys.map((k) => {
    const s = acc.get(k)!;
    return { day: s.day, orders: s.orders, revenue: Math.round(s.revenue) };
  });
}

/** Нөөц нь доод хэмжээнд (minStockAlert) хүрсэн/дууссан бараа (түрээс, материалаар үнэлэгдэх, идэвхгүй орохгүй). */
export function countLowStock(products: Array<{ sellStockQty?: unknown; minStockAlert?: unknown; isActive?: boolean; isRental?: boolean; usesMaterialPricing?: boolean }>): number {
  return products.filter((p) => {
    if (p.isActive === false || p.isRental || p.usesMaterialPricing) return false;
    const qty = Number(p.sellStockQty ?? 0);
    const min = Number(p.minStockAlert ?? 0);
    return Number.isFinite(qty) && qty <= (Number.isFinite(min) ? min : 0);
  }).length;
}

/** Өчигдрөөс хувийн өөрчлөлт (бүхэл). Өчигдөр 0 бол: өнөөдөр >0 → null (тооцох боломжгүй), 0 → 0. */
export function trendPercent(today: number, yesterday: number): number | null {
  if (!Number.isFinite(today) || !Number.isFinite(yesterday)) return null;
  if (yesterday === 0) return today === 0 ? 0 : null;
  return Math.round(((today - yesterday) / yesterday) * 100);
}
