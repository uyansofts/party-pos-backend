// ============================================================================
// MARKETPLACE — Etsy шиг marketplace-ийн цэвэр логик (DB, сүлжээ хэрэггүй, тест хийхэд хялбар).
//   • сагсыг худалдагчаар хуваах
//   • комиссын тооцоо
//   • нэг төлбөрийг бүлгийн захиалгуудад хуваарилах
//   • худалдагчийн захиалгын төлвийн шилжилт, хугацаа
// ============================================================================

export const DEFAULT_SELLER_ACCEPT_HOURS = 12;

export type SellerOrderStatusValue = "PENDING_PAYMENT" | "AWAITING_SELLER" | "ACCEPTED" | "READY" | "REJECTED" | "EXPIRED";

/**
 * Сагсны мөрүүдийг худалдагчаар хуваана. Манай өөрийн бараа (sellerId=null) ЭХЭНД, дараа нь худалдагчид
 * анх гарсан дарааллаараа. Мөрийн дараалал хэвээр хадгалагдана.
 */
export function partitionItemsBySeller<T extends { productId: string }>(
  items: T[],
  sellerOf: Map<string, string | null>
): Array<{ sellerId: string | null; items: T[] }> {
  const own: T[] = [];
  const bySeller = new Map<string, T[]>();
  for (const item of items) {
    const sid = sellerOf.get(item.productId) ?? null;
    if (!sid) own.push(item);
    else bySeller.set(sid, [...(bySeller.get(sid) ?? []), item]);
  }
  const parts: Array<{ sellerId: string | null; items: T[] }> = [];
  if (own.length > 0) parts.push({ sellerId: null, items: own });
  for (const [sellerId, list] of bySeller) parts.push({ sellerId, items: list });
  return parts;
}

/** Комисс = бараа × хувь (бүхэл төгрөгт бөөрөнхийлнө). Худалдагчид очих = бараа − комисс. Хувь 0..100-д хязгаарлагдана. */
export function computeCommission(itemsTotal: number, percent: number): { commissionAmount: number; sellerNet: number } {
  const total = Number.isFinite(itemsTotal) && itemsTotal > 0 ? itemsTotal : 0;
  const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const commissionAmount = Math.round((total * pct) / 100);
  return { commissionAmount, sellerNet: Math.round(total) - commissionAmount };
}

export interface GroupMember {
  id: string;
  totalAmount: number;
  paidAmount: number;
  cancelled: boolean;
}

const toCents = (n: number) => Math.round(n * 100);

/** Бүлгийн төлөх үлдэгдэл (цуцлагдсан захиалгыг оруулахгүй). */
export function groupRemaining(members: GroupMember[]): number {
  const cents = members.filter((m) => !m.cancelled).reduce((s, m) => s + Math.max(0, toCents(m.totalAmount) - toCents(m.paidAmount)), 0);
  return cents / 100;
}

/**
 * Нэг төлбөрийн дүнг бүлгийн (цуцлагдаагүй) захиалгуудад хуваарилна: ҮНДСЭН захиалга эхэнд, дараа нь жагсаалтын
 * дарааллаар, тус бүр өөрийн үлдэгдлээр. Бүх үлдэгдлийг хаасны дараах илүү дүн (жишээ нь нэгтгэн төлсөн барьцаа)
 * ҮНДСЭН захиалгад (цуцлагдсан бол эхний цуцлагдаагүйд) нэмэгдэнэ — төлсөн мөнгө бүрэн бүртгэгдэнэ.
 * Мөнгийг центээр тооцно (хөвөгч таслалын алдаагүй).
 */
export function planGroupAllocation(members: GroupMember[], amount: number, primaryId: string): Array<{ orderId: string; amount: number }> {
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const live = members.filter((m) => !m.cancelled);
  if (live.length === 0) return [];
  const ordered = [...live.filter((m) => m.id === primaryId), ...live.filter((m) => m.id !== primaryId)];
  let left = toCents(amount);
  const alloc = new Map<string, number>();
  for (const m of ordered) {
    const due = Math.max(0, toCents(m.totalAmount) - toCents(m.paidAmount));
    const pay = Math.min(due, left);
    if (pay > 0) {
      alloc.set(m.id, pay);
      left -= pay;
    }
  }
  if (left > 0) alloc.set(ordered[0].id, (alloc.get(ordered[0].id) ?? 0) + left);
  return ordered.filter((m) => alloc.has(m.id)).map((m) => ({ orderId: m.id, amount: alloc.get(m.id)! / 100 }));
}

export type SellerAction = "accept" | "ready" | "reject";

/**
 * Худалдагчийн захиалгын төлвийн шилжилт:
 *   accept: AWAITING_SELLER → ACCEPTED
 *   ready:  AWAITING_SELLER | ACCEPTED → READY (зөвшөөрөлгүйгээр шууд "бэлэн" гэж болно)
 *   reject: AWAITING_SELLER | ACCEPTED → REJECTED (READY болсны дараа татгалзахгүй — курьерт санал болсон байж болно)
 */
export function nextSellerStatus(current: SellerOrderStatusValue | null | undefined, action: SellerAction): { ok: boolean; next?: SellerOrderStatusValue; error?: string } {
  if (!current) return { ok: false, error: "Энэ худалдагчийн захиалга биш" };
  if (current === "PENDING_PAYMENT") return { ok: false, error: "Харилцагч хараахан төлөөгүй байна" };
  const ACTIVE = ["AWAITING_SELLER", "ACCEPTED"];
  if (action === "accept") {
    return current === "AWAITING_SELLER" ? { ok: true, next: "ACCEPTED" } : { ok: false, error: `Захиалга "${current}" төлөвт байгаа тул зөвшөөрөх боломжгүй` };
  }
  if (action === "ready") {
    return ACTIVE.includes(current) ? { ok: true, next: "READY" } : { ok: false, error: `Захиалга "${current}" төлөвт байгаа тул "Бэлэн" болгох боломжгүй` };
  }
  return ACTIVE.includes(current)
    ? { ok: true, next: "REJECTED" }
    : { ok: false, error: current === "READY" ? "Бэлэн болсон захиалгыг татгалзах боломжгүй — Staff-д хандана уу" : `Захиалга "${current}" төлөвт байгаа тул татгалзах боломжгүй` };
}

export function sellerAcceptDeadlineFrom(nowMs: number, hours: number): Date {
  const h = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SELLER_ACCEPT_HOURS;
  return new Date(nowMs + h * 3600000);
}

/** Төлбөр орсон, худалдагч хугацаандаа хариу өгөөгүй захиалга. */
export function isSellerAcceptExpired(o: { sellerStatus?: string | null; sellerAcceptDeadline?: Date | string | null }, nowMs: number = Date.now()): boolean {
  return o.sellerStatus === "AWAITING_SELLER" && !!o.sellerAcceptDeadline && new Date(o.sellerAcceptDeadline).getTime() <= nowMs;
}

/** Харилцагчид харагдах худалдагчийн алхмын шошго. */
export function sellerStepLabel(status: string | null | undefined): string {
  switch (status) {
    case "AWAITING_SELLER":
      return "Худалдагч баталгаажуулж байна";
    case "ACCEPTED":
      return "Худалдагч бэлтгэж байна";
    case "READY":
      return "Худалдагч бэлэн болгосон";
    default:
      return "Худалдагч баталгаажуулна";
  }
}
