// ============================================================================
// COURIER SETTLEMENT — Курьерт хүргэлтийн хөлсийг ОРОЙ НЭГ МӨСӨН төлөх тооцоо (цэвэр логик).
// Төлөх боломжтой = хүргэгдсэн (эсвэл авсны дараа цуцлагдаж нөхөн олговортой) + хараахан төлөөгүй.
// Харилцагч төлөөгүй (PAID биш) захиалгын хөлсийг нэг мөсөн төлөхөөс ХОРИГЛОНО — Staff шаардлагатай
// бол захиалга бүр дээр гараар тэмдэглэнэ (дэлгүүр өөрийн мөнгөөр урьдчилж өгөхөөс сэргийлнэ).
// ============================================================================

import { computeCourierPayout } from "./courier-payout";

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

export interface SettlementOrderRow {
  id: string;
  orderNumber: string;
  orderType: string;
  deliveryAssignStatus: string;
  paymentStatus: string;
  deliveryFee: number;
  serviceAmount: number;
  cancellationFee: number;
  courierFeePaid: boolean;
  deliveryAddress: string | null;
  deliveredAt: Date | string | null;
  cancelledAt: Date | string | null;
}

export interface SettlementItem {
  orderId: string;
  orderNumber: string;
  isErrand: boolean;
  kind: "DELIVERED" | "CANCELLED_FEE";
  amount: number; // Курьерт очих ЦЭВЭР дүн (дэлгүүрийн хувийг хассан)
  customerPaid: boolean; // false бол нэг мөсөн төлөхөөс хориглоно
  earnedAt: string | null;
  address: string | null;
}

export interface Settlement {
  items: SettlementItem[];
  payableCount: number;
  payableTotal: number;
  blockedCount: number; // Харилцагч төлөөгүй тул нэг мөсөн төлж болохгүй
  blockedTotal: number;
}

export function isPayoutEligible(o: Pick<SettlementOrderRow, "courierFeePaid" | "deliveryAssignStatus" | "cancellationFee">): boolean {
  if (o.courierFeePaid) return false;
  if (o.deliveryAssignStatus === "DELIVERED") return true;
  return o.deliveryAssignStatus === "CANCELLED" && Number(o.cancellationFee) > 0;
}

const toIso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

export function buildSettlement(rows: SettlementOrderRow[], commissionPercent: number, serviceCommissionPercent?: number | null): Settlement {
  const items: SettlementItem[] = [];
  for (const o of rows) {
    if (!isPayoutEligible(o)) continue;
    const cancelled = o.deliveryAssignStatus === "CANCELLED";
    const payout = computeCourierPayout({ deliveryFee: Number(o.deliveryFee), serviceAmount: Number(o.serviceAmount) }, commissionPercent, serviceCommissionPercent);
    items.push({
      orderId: o.id,
      orderNumber: o.orderNumber,
      isErrand: o.orderType === "COURIER_ERRAND",
      kind: cancelled ? "CANCELLED_FEE" : "DELIVERED",
      amount: payout.totalPayout,
      customerPaid: o.paymentStatus === "PAID",
      earnedAt: toIso(cancelled ? o.cancelledAt : o.deliveredAt),
      address: o.deliveryAddress,
    });
  }
  items.sort((a, b) => (a.earnedAt ?? "").localeCompare(b.earnedAt ?? ""));
  const payable = items.filter((i) => i.customerPaid);
  const blocked = items.filter((i) => !i.customerPaid);
  return {
    items,
    payableCount: payable.length,
    payableTotal: payable.reduce((s, i) => s + i.amount, 0),
    blockedCount: blocked.length,
    blockedTotal: blocked.reduce((s, i) => s + i.amount, 0),
  };
}

/** Staff-ийн сонгосон захиалгууд бүгд төлөх боломжтой жагсаалтад байх ёстой; давхардал, хоосон, харь захиалгыг татгалзана. */
export function selectPayable(settlement: Settlement, orderIds: unknown): SettlementItem[] {
  if (!Array.isArray(orderIds) || orderIds.length === 0) throw new SettlementError("Төлөх захиалгаа сонгоно уу");
  const ids = orderIds.map((x) => String(x));
  if (new Set(ids).size !== ids.length) throw new SettlementError("Захиалга давхардсан байна");
  const byId = new Map(settlement.items.map((i) => [i.orderId, i]));
  const selected: SettlementItem[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) throw new SettlementError("Сонгосон захиалгын нэг нь энэ курьерт төлөх жагсаалтад байхгүй (аль хэдийн төлөгдсөн байж магадгүй) — жагсаалтаа шинэчилнэ үү");
    if (!item.customerPaid) throw new SettlementError(`#${item.orderNumber} — харилцагч төлөөгүй тул нэг мөсөн төлөх боломжгүй`);
    selected.push(item);
  }
  return selected;
}
