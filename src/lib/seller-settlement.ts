// ============================================================================
// SELLER SETTLEMENT — Худалдагчид мөнгө (бараа − комисс) олгох тооцоо (цэвэр логик).
// Олгох боломжтой = худалдагч "Бэлэн" болгосон, курьер ХҮРГЭСЭН, харилцагч бүрэн төлсөн, цуцлагдаагүй/буцаагаагүй,
// хараахан олгоогүй, ХҮЛЭЭЛТИЙН хугацаа (анхдагч 3 хоног) өнгөрсөн. Хүлээлт нь харилцагчийн буцаалт/маргааныг
// хүргэснээс хойш шийдэх хугацаа — худалдагчид мөнгийг эртхэн өгчихөөд буцаалт гарвал платформ алдахаас сэргийлнэ.
// ============================================================================

export class SellerSettlementError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "SellerSettlementError";
    this.status = status;
  }
}

export const DEFAULT_PAYOUT_HOLD_DAYS = 3;

export interface SellerSettlementRow {
  id: string;
  orderNumber: string;
  sellerStatus: string | null;
  paymentStatus: string;
  deliveryAssignStatus: string;
  totalAmount: number;
  deliveryFee: number;
  urgentFee: number;
  commissionAmount: number;
  deliveredAt: Date | string | null;
  cancelledAt: Date | string | null;
  refundedAt: Date | string | null;
  sellerPayoutId: string | null;
}

/** Барааны дүн (хүргэлт, яаралтайн нэмэгдэлгүй). */
export function sellerItemsTotal(r: Pick<SellerSettlementRow, "totalAmount" | "deliveryFee" | "urgentFee">): number {
  return Math.max(0, Math.round((Number(r.totalAmount) - Number(r.deliveryFee) - Number(r.urgentFee)) * 100) / 100);
}

/** Худалдагчид очих ЦЭВЭР дүн = бараа − комисс (сөрөг болохгүй). */
export function sellerNetAmount(r: Pick<SellerSettlementRow, "totalAmount" | "deliveryFee" | "urgentFee" | "commissionAmount">): number {
  return Math.max(0, Math.round((sellerItemsTotal(r) - Number(r.commissionAmount ?? 0)) * 100) / 100);
}

export function isSellerPayoutCandidate(r: SellerSettlementRow): boolean {
  return (
    r.sellerStatus === "READY" &&
    r.deliveryAssignStatus === "DELIVERED" &&
    r.paymentStatus === "PAID" &&
    !r.sellerPayoutId &&
    !r.cancelledAt &&
    !r.refundedAt
  );
}

export function payoutReleaseAt(deliveredAt: Date | string | null | undefined, holdDays: number): Date | null {
  if (!deliveredAt) return null;
  const t = new Date(deliveredAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = Number.isFinite(holdDays) && holdDays >= 0 ? holdDays : DEFAULT_PAYOUT_HOLD_DAYS;
  return new Date(t + days * 86400000);
}

export interface SellerSettlementItem {
  orderId: string;
  orderNumber: string;
  itemsTotal: number;
  commission: number;
  net: number;
  deliveredAt: string | null;
  releaseAt: string | null;
  released: boolean; // false = хүлээлтийн хугацаа дуусаагүй, олгох боломжгүй
}

export interface SellerSettlement {
  items: SellerSettlementItem[];
  payableCount: number;
  payableTotal: number;
  heldCount: number;
  heldTotal: number;
}

export function buildSellerSettlement(rows: SellerSettlementRow[], holdDays: number, nowMs: number): SellerSettlement {
  const items: SellerSettlementItem[] = [];
  for (const r of rows) {
    if (!isSellerPayoutCandidate(r)) continue;
    const release = payoutReleaseAt(r.deliveredAt, holdDays);
    items.push({
      orderId: r.id,
      orderNumber: r.orderNumber,
      itemsTotal: sellerItemsTotal(r),
      commission: Number(r.commissionAmount ?? 0),
      net: sellerNetAmount(r),
      deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
      releaseAt: release ? release.toISOString() : null,
      released: !!release && release.getTime() <= nowMs,
    });
  }
  items.sort((a, b) => (a.deliveredAt ?? "").localeCompare(b.deliveredAt ?? ""));
  const ready = items.filter((i) => i.released);
  const held = items.filter((i) => !i.released);
  const sum = (xs: SellerSettlementItem[]) => Math.round(xs.reduce((s, i) => s + i.net, 0) * 100) / 100;
  return { items, payableCount: ready.length, payableTotal: sum(ready), heldCount: held.length, heldTotal: sum(held) };
}

/** Staff-ийн сонгосон захиалгууд бүгд олгох боломжтой (хүлээлт дууссан) жагсаалтад байх ёстой. */
export function selectSellerPayable(settlement: SellerSettlement, orderIds: unknown): SellerSettlementItem[] {
  if (!Array.isArray(orderIds) || orderIds.length === 0) throw new SellerSettlementError("Төлөх захиалгаа сонгоно уу");
  const ids = orderIds.map((x) => String(x));
  if (new Set(ids).size !== ids.length) throw new SellerSettlementError("Захиалга давхардсан байна");
  const byId = new Map(settlement.items.map((i) => [i.orderId, i]));
  const out: SellerSettlementItem[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) throw new SellerSettlementError("Сонгосон захиалгын нэг нь энэ худалдагчид олгох жагсаалтад байхгүй (аль хэдийн олгосон байж магадгүй) — жагсаалтаа шинэчилнэ үү");
    if (!item.released) throw new SellerSettlementError(`#${item.orderNumber} — хүлээлтийн хугацаа (${item.releaseAt ? item.releaseAt.slice(0, 10) : "?"} хүртэл) дуусаагүй тул мөнгө олгох боломжгүй`);
    out.push(item);
  }
  return out;
}
