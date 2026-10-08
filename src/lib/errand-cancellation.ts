// ============================================================================
// ERRAND CANCELLATION — Курьерийн илгээмж цуцлах дүрмийг НЭГ газарт (цэвэр
// функц — DB, сүлжээ хэрэггүй) тодорхойлно. Backend цуцлах үед БОЛОН апп
// "цуцалвал хураамж X₮, буцаалт Y₮" гэж ӨМНӨ нь харуулахад ИЖИЛ функц ашиглана.
//
// "Цуцлалтын шат":
//   UNPAID           төлөөгүй, хэн ч аваагүй   → үнэгүй, буцаах зүйлгүй
//   PAID_UNACCEPTED  төлсөн, хэн ч аваагүй     → үнэгүй, БҮТЭН буцаана
//   ASSIGNED_FEE     курьер авсан, бараа аваагүй → хураамжтай (хүргэх курьерт нөхөн олговор)
//   (бараа авсан/замд/хүргэсэн                  → цуцлахгүй, Staff гараар шийднэ)
// ============================================================================

export type CancelBranch = "UNPAID" | "PAID_UNACCEPTED" | "ASSIGNED_FEE" | "NOT_ALLOWED";

export interface CancelPlan {
  allowed: boolean;
  branch: CancelBranch;
  fee: number; // Хүргэх курьерт олгох нөхөн олговор (хэрэглэгчээс суутгасан)
  refund: number; // Илгээгчид буцаах дүн
  reason?: string; // allowed=false үед тайлбар
}

export interface CancelInput {
  deliveryAssignStatus: string;
  paymentStatus: string;
  paidAmount: number;
  deliveryFee: number;
}

const notAllowed = (reason: string): CancelPlan => ({ allowed: false, branch: "NOT_ALLOWED", fee: 0, refund: 0, reason });

export function planErrandCancellation(o: CancelInput, feePercentRaw: number): CancelPlan {
  const pct = Number.isFinite(feePercentRaw) ? Math.min(100, Math.max(0, feePercentRaw)) : 0;
  const paid = Math.max(0, Math.round(Number(o.paidAmount) || 0));

  if (o.deliveryAssignStatus === "CANCELLED" || o.paymentStatus === "CANCELLED" || o.paymentStatus === "REFUNDED") {
    return notAllowed("Илгээмж аль хэдийн цуцлагдсан байна");
  }

  if (o.deliveryAssignStatus === "UNASSIGNED" || o.deliveryAssignStatus === "OFFERED") {
    if (paid > 0) return { allowed: true, branch: "PAID_UNACCEPTED", fee: 0, refund: paid };
    return { allowed: true, branch: "UNPAID", fee: 0, refund: 0 };
  }

  if (o.deliveryAssignStatus === "ASSIGNED") {
    // Хураамж нь төлсөн дүнгээс хэтрэхгүй (Math.min) — төлөөгүй бол 0.
    const fee = Math.min(Math.round((Number(o.deliveryFee) * pct) / 100), paid);
    return { allowed: true, branch: "ASSIGNED_FEE", fee, refund: paid - fee };
  }

  return notAllowed("Бараа аль хэдийн авагдсан тул цуцлах боломжгүй — Staff-тай холбогдоно уу");
}
