// ============================================================================
// GATEWAY SETTLEMENT — QPay/SocialPay төлбөрийг НЭГ удаа, найдвартай хэрэгжүүлэх
// ----------------------------------------------------------------------------
// ӨМНӨХ АСУУДАЛ (payment.controller.ts):
//   1. findFirst → "PAID уу?" шалгалт → болзолгүй update → applyOrderPayment нь check-then-act байсан:
//      давхар/зэрэгцээ webhook хоёулаа шалгалтыг давж, төлбөрийг 2 удаа бүртгэж, нөөцийг 2 удаа хасдаг байсан.
//   2. GatewayTransaction PAID болсны дараа applyOrderPayment унавал webhook ямар ч байсан 200 буцааж,
//      дахин оролдох зам байхгүй → мөнгө орсон ч захиалга PENDING үлддэг байсан.
//
// ШИЙДЭЛ:
//   - settleGatewayPayment(): "claim" (status != PAID → PAID, атомик updateMany) БОЛОН төлбөр хэрэгжүүлэлт нь
//     НЭГ transaction. Apply унавал claim ч буцна → гүйлгээ PENDING хэвээр, дараагийн webhook / polling / reconcile дахин оролдоно.
//   - Зэрэгцээ хоёр дуудлагаас зөвхөн нэг нь claim хийнэ (нөгөөх нь DUPLICATE).
//   - Цуцлагдсан/төлөгдсөн захиалгад хоцорч ирсэн мөнгийг алдахгүй: гүйлгээ PAID, `rawCallback._unapplied` тэмдэглэгээ,
//     цуцлагдсан бол Order.refundDueAmount-д нэмнэ.
//   - reconcile: webhook огт ирээгүй / боловсруулалт унасан PENDING гүйлгээг gateway-ээс асууж дахин хэрэгжүүлнэ.
// ============================================================================

import { GatewayProvider, GatewayPurpose, GatewayTxStatus, PaymentMethod } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getPaymentGateway } from "./invoice.service";
import { applyOrderPaymentInTx, recordUnappliedPayment, runAfterPayment, type PaymentOutcome } from "./order-payment.service";
import * as depositService from "./deposit.service";
import { applyPromotionPayment } from "./featured.service"; // ✅ ШИНЭ — онцлох байрлалын төлбөр
import { assessPaidAmount, toCents, type UnappliedReason } from "../lib/payment-guards";
import { InsufficientStockError } from "../lib/stock-guards";

export type SettleResult =
  | { kind: "APPLIED"; overpaid?: number } // overpaid: нэхэмжлэлээс илүү орсон дүн (refund-due болгон бүртгэгдсэн)
  | { kind: "DUPLICATE" } // өөр дуудлага аль хэдийн хэрэгжүүлсэн
  | { kind: "UNAPPLIED"; reason: UnappliedReason; overpaid?: number } // мөнгө орсон, гэхдээ захиалгад хэрэгжүүлэх боломжгүй (Staff шалгаж буцаана)
  | { kind: "NOT_PAID" } // gateway "төлөгдөөгүй" гэж хариулсан
  | { kind: "UNDERPAID" } // gateway-ийн төлсөн дүн нэхэмжлэлээс бага — ГАРААР шалгана (гүйлгээ PENDING хэвээр)
  | { kind: "UNVERIFIABLE_AMOUNT"; reason: "MISSING" | "INVALID" | "INVALID_INVOICE_AMOUNT" }; // gateway төлсөн дүнг мэдээлээгүй / буруу — ХЭЗЭЭ Ч хэрэгжүүлэхгүй, PENDING хэвээр (reconcile дахин шалгана, эсвэл Staff гараар баталгаажуулна)

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : raw === undefined || raw === null ? {} : { value: raw };
}

/**
 * Gateway гүйлгээг "төлөгдсөн" гэж БАТАЛГААЖУУЛСАНЫ дараа дуудна (checkPayment амжилттай).
 * Давхар/зэрэгцээ дуудахад аюулгүй (idempotent).
 * ⚠️ Дүнг ЭНД шалгахгүй — дуудагч (confirmAndSettle) assessPaidAmount-аар баталгаажуулсан байх ёстой. `opts.paidAmount` нь баталгаажсан
 *    төлсөн дүн: нэхэмжлэлээс илүү бол илүүг refund-due болгож бүртгэнэ.
 */
export async function settleGatewayPayment(gatewayTxId: string, raw: unknown, opts: { paidAmount?: number } = {}): Promise<SettleResult> {
  let outcome: PaymentOutcome | null = null;
  let promotion: { promotionId: string; amount: number; provider: GatewayProvider } | null = null;

  let result: SettleResult;
  try {
    result = await prisma.$transaction(
    async (tx): Promise<SettleResult> => {
      const claim = await tx.gatewayTransaction.updateMany({
        where: { id: gatewayTxId, status: { not: GatewayTxStatus.PAID } },
        data: { status: GatewayTxStatus.PAID, paidAt: new Date(), rawCallback: asObject(raw) as object },
      });
      if (claim.count === 0) return { kind: "DUPLICATE" };

      const gtx = await tx.gatewayTransaction.findUniqueOrThrow({ where: { id: gatewayTxId } });

      // Илүү төлөлт: нэхэмжилсэн дүнгээр хэрэгжүүлж, илүүг refund-due болгоно (бүгд нэг transaction-д)
      const excess = await recordOverpayment(tx, gtx, raw, opts.paidAmount);
      const rawBase = excess > 0 ? { ...asObject(raw), _overpaid: { invoiced: Number(gtx.amount), paid: opts.paidAmount, excess, at: new Date().toISOString() } } : asObject(raw);
      if (excess > 0) await tx.gatewayTransaction.update({ where: { id: gatewayTxId }, data: { rawCallback: rawBase as object } }); // _overpaid тэмдэг (Staff буцаалт хийхэд харна)

      if (gtx.purpose === GatewayPurpose.ORDER_PAYMENT && gtx.orderId) {
        const method = gtx.provider === GatewayProvider.QPAY ? PaymentMethod.QPAY : PaymentMethod.SOCIALPAY;
        const o = await applyOrderPaymentInTx(tx, gtx.orderId, Number(gtx.amount), method, undefined, gtx.combinedDepositRentalIds);
        if (o.unapplied) {
          await recordUnappliedPayment(tx, o.unapplied);
          await tx.gatewayTransaction.update({
            where: { id: gatewayTxId },
            data: { rawCallback: { ...rawBase, _unapplied: { reason: o.unapplied.reason, amount: o.unapplied.amount, at: new Date().toISOString() } } as object },
          });
          console.error(`[PAYMENT_UNAPPLIED] gatewayTx=${gatewayTxId} order=${o.unapplied.orderId} amount=${o.unapplied.amount} reason=${o.unapplied.reason} — мөнгө орсон, Staff шалгаж буцаана`);
          return { kind: "UNAPPLIED", reason: o.unapplied.reason, ...(excess > 0 ? { overpaid: excess } : {}) };
        }
        outcome = o;
      } else if (gtx.purpose === GatewayPurpose.DEPOSIT && gtx.rentalDetailId) {
        await depositService.markDepositPaid(gtx.rentalDetailId, gtx.id, tx as any);
      } else if (gtx.purpose === GatewayPurpose.FEATURED_PROMOTION && gtx.promotionId) {
        promotion = { promotionId: gtx.promotionId, amount: Number(gtx.amount), provider: gtx.provider };
      }
      return { kind: "APPLIED", ...(excess > 0 ? { overpaid: excess } : {}) };
    },
    { timeout: 30000 }
    );
  } catch (err) {
    // ✅ F7: мөнгө орсон ч нөөц дутсан → захиалгыг БАТАЛГААЖУУЛАХГҮЙ. Эхний transaction бүхэлдээ буцсан (захиалга PENDING хэвээр).
    // Гүйлгээг "хэрэгжээгүй" гэж тэмдэглэж, буцаах дүнг бүртгэнэ — эс бөгөөс reconcile эцэс төгсгөлгүй дахин оролдоно.
    if (err instanceof InsufficientStockError) return parkInsufficientStock(gatewayTxId, raw, err, opts.paidAmount);
    throw err;
  }

  // Төлбөр аль хэдийн commit хийгдсэн — мэдэгдэл/сокет зэрэг дараах үйлдэл унавал APPLIED-ийг "алдаа" болгохгүй (reconcile дахин оролдож давхар бүртгэхгүй).
  if (outcome) {
    try {
      await runAfterPayment(outcome);
    } catch (err) {
      console.error(`[PAYMENT_AFTER_HOOK] gatewayTx=${gatewayTxId} төлбөр хэрэгжсэн, дараах үйлдэл унав:`, err);
    }
  }

  // Онцлох байрлал: applyPromotionPayment өөрийн transaction-тай, идемпотент. Унавал claim-ийг буцаана — дахин оролдох боломжтой болгоно.
  if (promotion) {
    const p = promotion as { promotionId: string; amount: number; provider: GatewayProvider };
    try {
      await applyPromotionPayment(p.promotionId, p.amount, p.provider === GatewayProvider.QPAY ? "QPAY" : "SOCIALPAY");
    } catch (err) {
      await prisma.gatewayTransaction.updateMany({ where: { id: gatewayTxId, status: GatewayTxStatus.PAID }, data: { status: GatewayTxStatus.PENDING, paidAt: null } });
      throw err;
    }
  }
  return result;
}

async function parkInsufficientStock(gatewayTxId: string, raw: unknown, err: InsufficientStockError, paidAmount?: number): Promise<SettleResult> {
  return prisma.$transaction(async (tx): Promise<SettleResult> => {
    const claim = await tx.gatewayTransaction.updateMany({
      where: { id: gatewayTxId, status: { not: GatewayTxStatus.PAID } },
      data: { status: GatewayTxStatus.PAID, paidAt: new Date() },
    });
    if (claim.count === 0) return { kind: "DUPLICATE" };
    const gtx = await tx.gatewayTransaction.findUniqueOrThrow({ where: { id: gatewayTxId } });
    const amount = Number(gtx.amount);
    const excess = await recordOverpayment(tx, gtx, raw, paidAmount);
    await tx.gatewayTransaction.update({
      where: { id: gatewayTxId },
      data: { rawCallback: { ...asObject(raw), ...(excess > 0 ? { _overpaid: { invoiced: amount, paid: paidAmount, excess, at: new Date().toISOString() } } : {}), _unapplied: { reason: "INSUFFICIENT_STOCK", amount, at: new Date().toISOString(), detail: err.message } } as object },
    });
    if (gtx.orderId) await tx.order.updateMany({ where: { id: gtx.orderId }, data: { refundDueAmount: { increment: amount } } });
    console.error(`[PAYMENT_UNAPPLIED] gatewayTx=${gatewayTxId} order=${gtx.orderId} amount=${amount} reason=INSUFFICIENT_STOCK — ${err.message}`);
    return { kind: "UNAPPLIED", reason: "INSUFFICIENT_STOCK", ...(excess > 0 ? { overpaid: excess } : {}) };
  });
}

/**
 * Нэхэмжлэлээс илүү орсон дүнг (paid − invoiced) transaction дотор бүртгэнэ: захиалгын `refundDueAmount`-д нэмж, лог бичнэ.
 * Захиалгагүй гүйлгээ (барьцаа, онцлох байрлал)-д refundDue-д нэмэх газар байхгүй — зөвхөн лог + rawCallback._overpaid (listOverpaidPayments).
 * Буцаах утга: илүү дүн (0 = илүүгүй).
 */
async function recordOverpayment(tx: any, gtx: { id: string; amount: unknown; orderId: string | null }, _raw: unknown, paidAmount: number | undefined): Promise<number> {
  if (paidAmount === undefined) return 0;
  const v = assessPaidAmount(Number(gtx.amount), paidAmount);
  if (v.kind !== "OVERPAID") return 0;
  if (gtx.orderId) await tx.order.updateMany({ where: { id: gtx.orderId }, data: { refundDueAmount: { increment: v.excess } } });
  console.warn(`[PAYMENT_OVERPAID] gatewayTx=${gtx.id} order=${gtx.orderId ?? "-"} нэхэмжилсэн=${Number(gtx.amount)} төлсөн=${paidAmount} илүү=${v.excess} — нэхэмжилсэн дүнгээр хэрэгжүүлж, илүүг буцаана`);
  return v.excess;
}

interface PendingTxLike {
  id: string;
  invoiceId: string;
  provider: GatewayProvider;
  amount: unknown;
  status: GatewayTxStatus | string;
}

/**
 * Gateway-ээс төлөв асууж (webhook-д ганцаараа итгэхгүй), төлөгдсөн бол settle хийнэ.
 *
 * ДҮНГИЙН БОДЛОГО (assessPaidAmount):
 *   - дүн байхгүй/буруу        → UNVERIFIABLE_AMOUNT (хэрэгжүүлэхгүй, PENDING хэвээр; reconcile дахин шалгана)
 *   - нэхэмжлэлээс бага         → UNDERPAID (хэрэгжүүлэхгүй, PENDING; гараар шалгана)
 *   - яг тэнцүү                 → хэрэгжүүлнэ
 *   - нэхэмжлэлээс илүү         → нэхэмжилсэн дүнгээр хэрэгжүүлж, илүүг refund-due болгоно
 */
export async function confirmAndSettle(gtx: PendingTxLike): Promise<SettleResult> {
  if (gtx.status === GatewayTxStatus.PAID) return { kind: "DUPLICATE" };
  // checkPayment-д ҮРГЭЛЖ манай хадгалсан (найдвартай) invoiceId + provider-ийг ашиглана — callback-ийн утгыг БИШ
  const { isPaid, raw, paidAmount } = await getPaymentGateway(gtx.provider).checkPayment(gtx.invoiceId);
  if (!isPaid) return { kind: "NOT_PAID" };
  const verdict = assessPaidAmount(Number(gtx.amount), paidAmount);
  if (verdict.kind === "UNVERIFIABLE") {
    console.error(`[PAYMENT_UNVERIFIABLE] gatewayTx=${gtx.id} provider=${gtx.provider} шалтгаан=${verdict.reason} — gateway төлөгдсөн гэсэн ч дүн баталгаажаагүй тул хэрэгжүүлэхгүй (PENDING). Дахин шалгана / Staff гараар баталгаажуулна`);
    return { kind: "UNVERIFIABLE_AMOUNT", reason: verdict.reason };
  }
  if (verdict.kind === "UNDERPAID") {
    console.error(`[PAYMENT_UNDERPAID] gatewayTx=${gtx.id} нэхэмжилсэн=${Number(gtx.amount)} төлсөн=${paidAmount} дутуу=${verdict.shortfall} — автоматаар хэрэгжүүлэхгүй, гараар шалгана`);
    return { kind: "UNDERPAID" };
  }
  return settleGatewayPayment(gtx.id, raw, { paidAmount });
}

/** Webhook-ийн түлхүүрээр гүйлгээг ЯГ НЭГЭЭР тодорхойлно. Хоёр түлхүүр өөр гүйлгээ заавал / нэг нь танигдахгүй бол татгалзана. */
export type ResolveTxResult =
  | { ok: true; gtx: NonNullable<Awaited<ReturnType<typeof prisma.gatewayTransaction.findUnique>>> }
  | { ok: false; reason: "NO_KEYS" | "CONFLICTING_KEYS" | "NOT_FOUND" | "AMBIGUOUS_MATCH" };

export async function resolveGatewayTransaction(keys: { invoiceId?: string; senderInvoiceNo?: string; conflict?: boolean }): Promise<ResolveTxResult> {
  if (keys.conflict) return { ok: false, reason: "CONFLICTING_KEYS" };
  if (!keys.invoiceId && !keys.senderInvoiceNo) return { ok: false, reason: "NO_KEYS" };
  // invoiceId, senderInvoiceNo хоёул @unique → тус тусад нь хайна (findFirst+OR нь хоёр өөр мөрөөс санамсаргүй нэгийг сонгодог байсан)
  const byInvoice = keys.invoiceId ? await prisma.gatewayTransaction.findUnique({ where: { invoiceId: keys.invoiceId } }) : null;
  const bySender = keys.senderInvoiceNo ? await prisma.gatewayTransaction.findUnique({ where: { senderInvoiceNo: keys.senderInvoiceNo } }) : null;
  if (keys.invoiceId && keys.senderInvoiceNo) {
    if (!byInvoice || !bySender) return { ok: false, reason: byInvoice || bySender ? "AMBIGUOUS_MATCH" : "NOT_FOUND" }; // нэг нь танигдахгүй = зөрчил
    if (byInvoice.id !== bySender.id) return { ok: false, reason: "AMBIGUOUS_MATCH" };
    return { ok: true, gtx: byInvoice };
  }
  const gtx = byInvoice ?? bySender;
  return gtx ? { ok: true, gtx } : { ok: false, reason: "NOT_FOUND" };
}

/**
 * Gateway webhook боловсруулалт. Provider таарахгүй / тодорхойгүй / зөрчилтэй бол ШУУД зогсоно (gateway-д хандахгүй, юу ч бичихгүй).
 */
export type WebhookResult = SettleResult | { kind: "IGNORED"; reason: "NO_KEYS" | "CONFLICTING_KEYS" | "NOT_FOUND" | "AMBIGUOUS_MATCH" | "PROVIDER_MISMATCH" };

export async function processGatewayWebhook(provider: GatewayProvider, keys: { invoiceId?: string; senderInvoiceNo?: string; conflict?: boolean }): Promise<WebhookResult> {
  const found = await resolveGatewayTransaction(keys);
  if (!found.ok) {
    console.warn(`${provider} webhook татгалзав: ${found.reason}`);
    return { kind: "IGNORED", reason: found.reason };
  }
  if (found.gtx.provider !== provider) {
    console.warn(`${provider} webhook татгалзав: гүйлгээний provider (${found.gtx.provider}) таарахгүй gatewayTx=${found.gtx.id}`);
    return { kind: "IGNORED", reason: "PROVIDER_MISMATCH" };
  }
  return confirmAndSettle(found.gtx);
}

// ---------------------------------------------------------------------------
// RECONCILE — webhook ирээгүй / боловсруулалт унасан PENDING гүйлгээг сэргээх
// ---------------------------------------------------------------------------
const lastChecked = new Map<string, number>();
const MIN_RECHECK_MS = 5_000; // нэг гүйлгээний төлвийг gateway-ээс 5 секундэд нэгээс олон асуухгүй (polling-оос хамгаална)

/** Нэг гүйлгээг шалгаж (хэрэв PENDING бол), шинэ төлөвийг буцаана. Алдаа гарвал throw хийхгүй (polling-ийг эвдэхгүй). */
export async function reconcileGatewayTransaction(id: string, now: number = Date.now()) {
  let gtx = await prisma.gatewayTransaction.findUnique({ where: { id } });
  if (!gtx || gtx.status === GatewayTxStatus.PAID) return gtx;
  const last = lastChecked.get(id) ?? 0;
  if (now - last < MIN_RECHECK_MS) return gtx;
  lastChecked.set(id, now);
  if (lastChecked.size > 5000) lastChecked.clear();
  try {
    const r = await confirmAndSettle(gtx);
    if (r.kind === "APPLIED" || r.kind === "UNAPPLIED" || r.kind === "DUPLICATE") {
      gtx = await prisma.gatewayTransaction.findUnique({ where: { id } });
    }
  } catch (err) {
    console.error(`Gateway reconcile алдаа (gatewayTx=${id}):`, err);
  }
  return gtx;
}

/** Бүх удаан PENDING байгаа гүйлгээг шалгана (Staff гараар эсвэл scheduler дуудна). */
export async function reconcilePendingGatewayTransactions(opts: { minAgeMs?: number; maxAgeMs?: number; limit?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const minAge = opts.minAgeMs ?? 30_000;
  const maxAge = opts.maxAgeMs ?? 48 * 60 * 60 * 1000;
  const rows = await prisma.gatewayTransaction.findMany({
    where: { status: GatewayTxStatus.PENDING, createdAt: { gte: new Date(now - maxAge), lte: new Date(now - minAge) } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
  });
  const summary = { checked: 0, applied: 0, unapplied: 0, stillPending: 0, underpaid: 0, unverifiable: 0, errors: 0 };
  for (const row of rows) {
    summary.checked++;
    try {
      const r = await confirmAndSettle(row);
      if (r.kind === "APPLIED" || r.kind === "DUPLICATE") summary.applied++;
      else if (r.kind === "UNAPPLIED") summary.unapplied++;
      else if (r.kind === "UNDERPAID") summary.underpaid++;
      else if (r.kind === "UNVERIFIABLE_AMOUNT") summary.unverifiable++;
      else summary.stillPending++;
    } catch (err) {
      summary.errors++;
      console.error(`Gateway reconcile алдаа (gatewayTx=${row.id}):`, err);
    }
  }
  return summary;
}

/** Хэрэгжүүлж болоогүй (мөнгө орсон, Staff-д шалгуулах) төлбөрүүдийн жагсаалт. */
export async function listUnappliedPayments(days = 60) {
  const rows = await prisma.gatewayTransaction.findMany({
    where: { status: GatewayTxStatus.PAID, purpose: GatewayPurpose.ORDER_PAYMENT, paidAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { paidAt: "desc" },
    take: 500,
  });
  return rows
    .map((r) => ({ r, u: (r.rawCallback as any)?._unapplied }))
    .filter((x) => x.u)
    .map(({ r, u }) => ({ gatewayTransactionId: r.id, orderId: r.orderId, provider: r.provider, amount: Number(r.amount), reason: u.reason, at: u.at, paidAt: r.paidAt }));
}

/** Status (polling) endpoint-д буцаах хэлбэр — хэрэгжээгүй төлбөрийг клиентэд "амжилттай" гэж хуурахгүй. */
export function toStatusView(gtx: { status: string; paidAt: Date | null; rawCallback?: unknown }) {
  const reason = (gtx.rawCallback as any)?._unapplied?.reason;
  return { status: gtx.status, paidAt: gtx.paidAt, ...(reason ? { applied: false, unappliedReason: reason } : {}) };
}

/**
 * Staff-ийн /api/payments/status хандалтын эзэмшлийн шалгалт. Гүйлгээ байхгүй → 404. Захиалгын гүйлгээ бол захиалгын салбар (storeId)
 * ажилтны токен дахь салбартай ТААРАХ ёстой (өөр салбарын төлбөрийн төлөв/reconcile-г өдөөж болохгүй); захиалга олдохгүй бол татгалзана.
 * (Барьцаа/онцлох байрлалын гүйлгээ салбарт холбогдоогүй тул идэвхтэй ажилтанд нээлттэй — role шалгалтыг route хийнэ.)
 */
export async function authorizeStaffForGatewayTx(staff: { staffId: string; storeId?: string }, gatewayTxId: string): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  const gtx = await prisma.gatewayTransaction.findUnique({ where: { id: gatewayTxId }, select: { id: true, orderId: true } });
  if (!gtx) return { ok: false, status: 404, error: "Олдсонгүй" };
  if (gtx.orderId) {
    const order = await prisma.order.findUnique({ where: { id: gtx.orderId }, select: { storeId: true } });
    if (!order || !staff.storeId || order.storeId !== staff.storeId) return { ok: false, status: 403, error: "Энэ гүйлгээнд хандах эрхгүй байна" };
  }
  return { ok: true };
}
