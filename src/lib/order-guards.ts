// ============================================================================
// ORDER GUARDS — захиалгын төлөв солих / устгах үйлдлийн цэвэр (pure) дүрэм.
// Controller болон тест хоёулаа ижил дүрмийг ашиглана.
// ============================================================================

export type PayState = "PENDING" | "PARTIALLY_PAID" | "PAID" | "REFUNDED" | "CANCELLED";

export type TransitionPlan =
  | { kind: "noop" }
  | { kind: "pay" } // markOrderPaidManually
  | { kind: "cancel" } // cancelOrder (rental/stock-ийг зөв суллана)
  | { kind: "refund"; adminOnly: true } // PAID -> REFUNDED (атомик claim)
  | { kind: "reject"; error: string };

/**
 * Гар аргаар төлөв солих боломжит шилжилтүүд.
 *  PENDING/PARTIALLY_PAID -> PAID       : markOrderPaidManually (Payment мөр + нөөц)
 *  PENDING/PARTIALLY_PAID -> CANCELLED  : cancelOrder
 *  PAID                   -> REFUNDED   : ADMIN, атомик
 *  бусад (PAID->PENDING, CANCELLED->*, *->PARTIALLY_PAID …) : татгалзана —
 *  Payment/нөөц/түрээсийн бүртгэлтэй зөрчилдөж, нөөц хоёр дахин хасагдах эсвэл
 *  мөнгөний түүх алдагдана.
 */
export function planStatusChange(from: string, to: string): TransitionPlan {
  if (from === to) return { kind: "noop" };
  const open = from === "PENDING" || from === "PARTIALLY_PAID";
  if (to === "PAID" && open) return { kind: "pay" };
  if (to === "CANCELLED" && open) return { kind: "cancel" };
  if (to === "REFUNDED" && from === "PAID") return { kind: "refund", adminOnly: true };
  return {
    kind: "reject",
    error: `"${from}" → "${to}" шилжилтийг гараар хийх боломжгүй (төлбөр/нөөцийн бүртгэл зөрчигдөнө). Буцаалт хийх бол PAID → REFUNDED, цуцлах бол PENDING/PARTIALLY_PAID → CANCELLED.`,
  };
}

export interface DeletableOrder {
  paymentStatus: string;
  paidAmount: unknown;
  courierPayoutId?: string | null;
  sellerPayoutId?: string | null;
  courierFeePaid?: boolean | null;
  refundDueAmount?: unknown;
  refundedAt?: Date | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Устгалтын шалгалт. Санхүүгийн ул мөртэй захиалгыг (төлөгдсөн, буцаасан,
 * курьер/худалдагчид олгосон) УСТГАХГҮЙ — ADMIN `force`-той ч payout-д
 * холбогдсон бол хориглоно. Хоосон/цуцлагдсан захиалгыг л чөлөөтэй устгана.
 */
export function assessOrderDeletion(o: DeletableOrder, opts: { isAdmin: boolean; force: boolean }): { ok: true } | { ok: false; status: 403 | 409; error: string } {
  if (o.courierPayoutId || o.sellerPayoutId || o.courierFeePaid) {
    return { ok: false, status: 409, error: "Курьер/худалдагчид олгосон төлбөртэй холбогдсон захиалгыг устгах боломжгүй" };
  }
  const hasMoney = num(o.paidAmount) > 0 || num(o.refundDueAmount) > 0 || o.refundedAt != null || o.paymentStatus === "PAID" || o.paymentStatus === "PARTIALLY_PAID" || o.paymentStatus === "REFUNDED";
  if (!hasMoney) return { ok: true };
  if (!opts.isAdmin) return { ok: false, status: 403, error: "Төлбөртэй захиалгыг зөвхөн ADMIN устгана" };
  if (!opts.force) return { ok: false, status: 409, error: "Төлбөртэй захиалгыг устгахад force=true шаардлагатай (санхүүгийн түүх бүрмөсөн арилна). Цуцлах/буцаалтыг зөвлөнө." };
  return { ok: true };
}
