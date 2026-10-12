// ============================================================================
// ORDER PAYMENT SERVICE — Захиалгын төлбөрийг хэрэгжүүлэх НЭГ Л ЦЭГ
// ----------------------------------------------------------------------------
// АРХИТЕКТУРЫН ШАЛТГААН: QPay webhook БОЛОН гараар (Мөнгө/Данс шилжүүлэг)
// баталгаажуулах хоёр урсгал ЯГ ИЖИЛ дараах алхмуудыг хийх ёстой:
//   1. Payment мөр бичих (аудит)
//   2. Order.paidAmount нэмэгдүүлж, бүрэн төлөгдсөн эсэхийг шалгах
//   3. Бүрэн төлөгдсөн бол SALE барааны нөөцийг буулгах (SALE_OUT)
//   4. ONLINE захиалга бол ПОС апп руу realtime мэдэгдэл илгээх
// Үүнийг 2 газар давхардуулбал (өмнө нь payment.controller.ts дотор шууд
// бичигдсэн байсан) аль нэгийг нь засаад нөгөөг мартах эрсдэлтэй.
// ============================================================================

import type { Prisma } from "@prisma/client";
import { OrderType, PaymentType, PaymentMethod, PayStatus, DepositStatus, DepositType, DeliveryAssignStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emitToStore } from "../realtime/socket";
import { deductSaleStockInTx } from "./stock.service";
import { InsufficientStockError } from "../lib/stock-guards";
import { consumeMaterialsForOrder, type LowStockMaterial } from "./material.service";
import { offerDeliveryToAllCouriers } from "./delivery-assignment.service";
import type { NewOnlineOrderPayload } from "../types/payment.types";
import { DEFAULT_SELLER_ACCEPT_HOURS, groupRemaining, planGroupAllocation, sellerAcceptDeadlineFrom, type GroupMember } from "../lib/marketplace";
import { PAYABLE_STATUSES, classifyUnapplied, toCents, unappliedMessage, type UnappliedReason } from "../lib/payment-guards";


export class OrderPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPaymentError";
  }
}

/** Зэрэгцээ өөрчлөлтийн улмаас бүлгийн төлбөрийг хэрэгжүүлж чадсангүй — transaction бүхэлдээ буцна, дахин оролдож болно. */
export class PaymentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConflictError";
  }
}

type CoreResult = { ok: true; saved: any; lowStock: LowStockMaterial[] } | { ok: false; reason: UnappliedReason };

/** Нэг transaction-ы үр дүн: хэрэгжсэн захиалгууд, эсвэл хэрэгжүүлж БОЛООГҮЙ төлбөр (мөнгө орсон — Staff буцаана). */
export interface PaymentOutcome {
  applied: Array<{ saved: any; lowStock: LowStockMaterial[] }>;
  unapplied?: { reason: UnappliedReason; amount: number; orderId: string };
}

/**
 * Захиалгад төлбөр хэрэгжүүлэх ГОЛ логик — нэг transaction дотор (нэг захиалга эсвэл бүлгийн хэд хэдэн захиалгад).
 * ----------------------------------------------------------------------------
 * ✅ ШИНЭ (найдвартай байдал): төлөв шалгах + paidAmount нэмэх нь НЭГ атомик `updateMany` (check-then-act биш):
 *   WHERE paymentStatus IN (PENDING, PARTIALLY_PAID) AND cancelledAt IS NULL → paidAmount += amount.
 *   - PAID / CANCELLED / REFUNDED захиалгад төлбөр ХЭРЭГЖИХГҮЙ (ok:false буцаана);
 *   - зэрэгцээ хоёр төлбөр ирвэл Postgres мөрийг түгжиж дарааллуулна → paidAmount алдагдахгүй (абсолют утга БИЧИХГҮЙ);
 *   - PAID болох шилжилт яг НЭГ удаа болно → нөөцийн хасалт (доор) давхар хийгдэхгүй.
 */
async function applyPaymentCore(
  tx: Prisma.TransactionClient,
  orderId: string,
  amount: number,
  method: PaymentMethod,
  note: string | undefined,
  combinedDepositRentalIds: string[]
): Promise<CoreResult> {
  if (!(Number.isFinite(amount) && amount > 0)) throw new OrderPaymentError("Төлбөрийн дүн буруу байна");

  // ✅ ШИНЭ: Материалын нөөц доод үлдэгдэлд хүрсэн эсэх (транзакц дууссаны ДАРАА сануулна)
  let lowStockMaterials: LowStockMaterial[] = [];

  const claimed = await tx.order.updateMany({
    where: { id: orderId, paymentStatus: { in: [...PAYABLE_STATUSES] as PayStatus[] }, cancelledAt: null },
    data: { paidAmount: { increment: amount } },
  });
  if (claimed.count === 0) {
    const current = await tx.order.findUnique({ where: { id: orderId }, select: { paymentStatus: true, cancelledAt: true } });
    return { ok: false, reason: classifyUnapplied(current) };
  }

  await tx.payment.create({
    data: { orderId, type: PaymentType.SALE_PAYMENT, method, amount, note },
  });

  // paidAmount-ыг дээрх increment аль хэдийн нэмсэн (мөр бидний transaction-д түгжээтэй тул энэ утга найдвартай).
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { include: { product: true } }, customer: true },
  });

  const isFullyPaid = toCents(Number(order.paidAmount)) >= toCents(Number(order.totalAmount));

  let saved = await tx.order.update({
    where: { id: orderId },
    data: { paymentStatus: isFullyPaid ? PayStatus.PAID : PayStatus.PARTIALLY_PAID },
    include: { items: { include: { product: true } }, customer: true },
  });

  // ---- ✅ ШИНЭ (marketplace): Худалдагчийн захиалга БҮРЭН төлөгдөхөд худалдагчид мэдэгдэж, зөвшөөрөх хугацааг эхлүүлнэ ----
  if (isFullyPaid && saved.sellerId && saved.sellerStatus === "PENDING_PAYMENT") {
    const st = await tx.shopSettings.findUnique({ where: { id: "default" } });
    saved = await tx.order.update({
      where: { id: orderId },
      data: {
        sellerStatus: "AWAITING_SELLER",
        sellerAcceptDeadline: sellerAcceptDeadlineFrom(Date.now(), (st as any)?.sellerAcceptHours ?? DEFAULT_SELLER_ACCEPT_HOURS),
      },
      include: { items: { include: { product: true } }, customer: true },
    });
  }

  // ---- ✅ ШИНЭ: Нэгтгэн төлсөн барьцаа(нуу)-г ЧХАМТ HELD болгоно ----
  // (Захиалгын үндсэн дүн БОЛОН барьцааг нэг QPay/Данс гүйлгээгээр
  // хамт авсан үед л ирдэг жагсаалт.)
  for (const rentalDetailId of combinedDepositRentalIds) {
    const rental = await tx.rentalDetail.findUnique({ where: { id: rentalDetailId } });
    if (rental && rental.depositStatus === DepositStatus.PENDING) {
      await tx.rentalDetail.update({
        where: { id: rentalDetailId },
        data: { depositStatus: DepositStatus.HELD, depositType: DepositType.MONEY },
      });
    }
  }

  // ---- Агуулахын үлдэгдлийг ШУУД буулгах (SALE_OUT) — зөвхөн бүрэн төлөгдсөн үед ----
  if (isFullyPaid) {
    // ✅ F7: нөөцийг АТОМИК (gte) хасна — хүрэлцэхгүй бол InsufficientStockError → транзакц бүхэлдээ буцна.
    // Ижил бараа олон мөрөнд байвал нэгтгэнэ. Материалаар үнэлэгдэх бараа барааны нөөцөөс хасагдахгүй (доор материалын нөөцөөс).
    await deductSaleStockInTx(tx, { id: orderId, orderNumber: saved.orderNumber, orderType: String(saved.orderType) }, saved.items as any);

    for (const item of saved.items) {
      if (item.itemType === "SALE") {
        // ✅ ШИНЭ: POS (биечлэн ирсэн) захиалгад төлбөр орох мөчид бараа
        // ШУУД гардаг тул автоматаар "олгогдсон" гэж тэмдэглэнэ. ONLINE
        // захиалгад хэрэглэгч хожим ирж авах тул false үлдээнэ — кассчин
        // POST /:id/issue-ээр гараар тэмдэглэнэ.
        if (saved.orderType === OrderType.POS) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: { isIssued: true, issuedAt: new Date() },
          });
        }
      }
    }

    // ✅ ШИНЭ: Талбайгаар үнэлэгдсэн материалын нөөцийг (см²) хасна
    lowStockMaterials = await consumeMaterialsForOrder(
      tx,
      { id: orderId, orderNumber: saved.orderNumber },
      saved.items
        .filter((i) => i.itemType === "SALE")
        .map((i) => ({ materialId: i.materialId, areaCm2: i.areaCm2, quantity: i.quantity }))
    );
  }

  return { ok: true, saved, lowStock: lowStockMaterials };
}

/** Транзакц АМЖИЛТТАЙ дууссаны ДАРАА: realtime мэдэгдэл, курьерийн илгээмжийг автоматаар санал болгох. */
async function afterPayment(updatedOrder: any, lowStockMaterials: LowStockMaterial[]): Promise<void> {
  // ---- REALTIME: Транзакц АМЖИЛТТАЙ дуусаад ГАДНА нь илгээнэ ----
  try {
    // ✅ ШИНЭ: Материалын нөөц доод үлдэгдэлд хүрсэн бол POS-д сануулна
    for (const m of lowStockMaterials) {
      emitToStore(updatedOrder.storeId, "material_low_stock", {
        kind: "MATERIAL_LOW_STOCK",
        materialId: m.id,
        name: m.name,
        stockCm2: m.stockCm2,
        minStockCm2: m.minStockCm2,
      });
    }

    // ✅ ШИНЭ (marketplace): Худалдагчийн захиалга төлөгдлөө — Staff худалдагчид утсаар мэдэгдэж, зөвшөөрүүлнэ
    if (updatedOrder.sellerId && updatedOrder.sellerStatus === "AWAITING_SELLER") {
      emitToStore(updatedOrder.storeId, "seller_order_awaiting", {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        sellerId: updatedOrder.sellerId,
        acceptDeadline: updatedOrder.sellerAcceptDeadline ? new Date(updatedOrder.sellerAcceptDeadline).toISOString() : null,
      });
    }

    if (updatedOrder.orderType === OrderType.ONLINE) {
      // ✅ ШИНЭ: Хуурамч захиалгыг шигших — энэ харилцагчийн ӨМНӨ нь
      // цуцлагдсан захиалгын тоог тооцоод, ажилтанд шууд харуулна.
      const cancelledOrderCount = updatedOrder.customerId
        ? await prisma.order.count({
            where: { customerId: updatedOrder.customerId, paymentStatus: "CANCELLED" },
          })
        : 0;

      const payload: NewOnlineOrderPayload = {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        customerName: updatedOrder.customer?.name ?? "Танихгүй",
        customerPhone: updatedOrder.customer?.phone ?? null,
        totalAmount: Number(updatedOrder.totalAmount),
        items: updatedOrder.items.map((i: any) => ({
          productName: i.product.name,
          quantity: i.quantity,
          itemType: i.itemType as "SALE" | "RENTAL",
        })),
        paidAt: new Date().toISOString(),
        deliveryMethod: updatedOrder.deliveryMethod,
        deliveryAddress: updatedOrder.deliveryAddress,
        deliveryFee: Number(updatedOrder.deliveryFee),
        cancelledOrderCount, // ✅ ШИНЭ
      };

      emitToStore(updatedOrder.storeId, "new_online_order", payload);
      emitToStore(updatedOrder.storeId, "inventory_updated", {
        orderId: updatedOrder.id,
        affectedProductIds: updatedOrder.items.map((i: any) => i.productId),
      });
    }
  } catch (socketErr) {
    console.error("Realtime мэдэгдэл илгээхэд алдаа гарлаа (захиалга бүртгэгдсэн):", socketErr);
  }

  // ✅ ШИНЭ (Uber шиг УРЬДЧИЛЖ ТӨЛӨХ): Курьерийн илгээмжийн төлбөр БҮРЭН орсон
  // даруйд (QPay webhook, Staff гараар, дансаар — бүгд энэ функцээр дамждаг) бусад
  // курьерт АВТОМАТААР санал болгоно. Алдаа гарвал төлбөр бүртгэгдсэн хэвээр, Staff
  // POS-оос гараар санал болгож болно.
  try {
    if (
      updatedOrder.orderType === OrderType.COURIER_ERRAND &&
      updatedOrder.paymentStatus === PayStatus.PAID &&
      updatedOrder.deliveryAssignStatus === DeliveryAssignStatus.UNASSIGNED
    ) {
      await offerDeliveryToAllCouriers(updatedOrder.id);
    }
  } catch (offerErr) {
    console.error("Илгээмжийг курьерт санал болгоход алдаа гарлаа (төлбөр бүртгэгдсэн):", offerErr);
  }}

/**
 * Бүлгийн (нэг сагсны) гишүүд — цуцлагдсан/буцаагдсаныг тэмдэглэнэ.
 * forPayment=true үед аль хэдийн бүрэн төлөгдсөн (PAID) гишүүнийг ч хасна — илүү дүн (барьцаа) PAID захиалгад очихоос сэргийлнэ.
 */
async function loadGroupMembers(groupId: string, db: Prisma.TransactionClient = prisma as unknown as Prisma.TransactionClient, forPayment = false): Promise<GroupMember[]> {
  const rows = await db.order.findMany({
    where: { orderGroupId: groupId },
    select: { id: true, totalAmount: true, paidAmount: true, cancelledAt: true, paymentStatus: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    totalAmount: Number(r.totalAmount),
    paidAmount: Number(r.paidAmount),
    cancelled:
      !!r.cancelledAt ||
      r.paymentStatus === PayStatus.CANCELLED ||
      r.paymentStatus === PayStatus.REFUNDED ||
      (forPayment && r.paymentStatus === PayStatus.PAID),
  }));
}

/** Захиалга бүлгийн гишүүн бол бүлгийн төлөх үлдэгдэл, үгүй бол null. (Нийтийн invoice-ийн дүнг шалгахад ашиглана.) */
export async function getGroupRemaining(orderId: string): Promise<number | null> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderGroupId: true } });
  if (!o?.orderGroupId) return null;
  return groupRemaining(await loadGroupMembers(o.orderGroupId));
}

/**
 * ✅ ШИНЭ (marketplace): НЭГ төлбөрийг бүлгийн бүх (цуцлагдаагүй, төлөгдөөгүй) захиалгад хуваарилна — дуудагчийн transaction дотор:
 * дундаас алдаа гарвал юу ч хэсэгчлэн бүртгэгдэхгүй. Гишүүдийг transaction ДОТОР уншина (өмнө нь гадна уншдаг байсан).
 * Хуваарилалтын дүрмийг planGroupAllocation (цэвэр функц) тодорхойлно.
 */
async function applyGroupPaymentInTx(
  tx: Prisma.TransactionClient,
  groupId: string,
  invoicedOrderId: string,
  amount: number,
  method: PaymentMethod,
  note: string | undefined,
  combinedDepositRentalIds: string[]
): Promise<PaymentOutcome> {
  const members = await loadGroupMembers(groupId, tx, true);
  const plan = planGroupAllocation(members, amount, groupId);
  if (plan.length === 0) {
    const cur = await tx.order.findUnique({ where: { id: invoicedOrderId }, select: { paymentStatus: true, cancelledAt: true } });
    const reason = classifyUnapplied(cur);
    return { applied: [], unapplied: { reason: reason === "NOTHING_DUE" ? "ALREADY_PAID" : reason, amount, orderId: invoicedOrderId } };
  }

  const applied: PaymentOutcome["applied"] = [];
  for (let i = 0; i < plan.length; i++) {
    const r = await applyPaymentCore(tx, plan[i].orderId, plan[i].amount, method, note, i === 0 ? combinedDepositRentalIds : []);
    // Төлөвлөгөө гаргасны дараа гишүүн цуцлагдсан/төлөгдсөн бол БҮХЭЛД нь буцаана (хэсэгчилсэн бүртгэл үлдээхгүй) — дараа дахин оролдоно.
    if (!r.ok) throw new PaymentConflictError(`Бүлгийн захиалга ${plan[i].orderId} төлбөр хүлээн авах боломжгүй болсон (${r.reason}) — дахин оролдоно уу`);
    applied.push({ saved: r.saved, lowStock: r.lowStock });
  }
  return { applied };
}

/**
 * Захиалгад төлбөр хэрэгжүүлнэ — ДУУДАГЧИЙН transaction дотор (gateway settlement болон гараар төлөлт хоёулаа ашиглана).
 * Захиалга бүлгийн (нэг сагсны) гишүүн бол төлбөрийг бүлгийн захиалгуудад хуваарилна.
 * Төлбөр хэрэгжүүлэх боломжгүй (цуцлагдсан/төлөгдсөн/олдохгүй) бол `unapplied` буцаана — ЯМАР Ч зүйл бичигдэхгүй.
 */
export async function applyOrderPaymentInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  amount: number,
  method: PaymentMethod,
  note?: string,
  combinedDepositRentalIds: string[] = []
): Promise<PaymentOutcome> {
  const target = await tx.order.findUnique({ where: { id: orderId }, select: { orderGroupId: true } });
  if (target?.orderGroupId) {
    return applyGroupPaymentInTx(tx, target.orderGroupId, orderId, amount, method, note, combinedDepositRentalIds);
  }
  const r = await applyPaymentCore(tx, orderId, amount, method, note, combinedDepositRentalIds);
  if (!r.ok) return { applied: [], unapplied: { reason: r.reason, amount, orderId } };
  return { applied: [{ saved: r.saved, lowStock: r.lowStock }] };
}

/** Transaction АМЖИЛТТАЙ дууссаны ДАРАА realtime мэдэгдэл, курьерт санал болгох. */
export async function runAfterPayment(outcome: PaymentOutcome): Promise<void> {
  for (const r of outcome.applied) await afterPayment(r.saved, r.lowStock);
}

/**
 * Хэрэгжүүлж болоогүй төлбөрийн мөнгийг алдахгүй бүртгэнэ (транзакц дотор):
 * захиалга ЦУЦЛАГДСАН бол `refundDueAmount`-д нэмнэ (Dashboard "буцаах ёстой" тоонд орно).
 * Төлөгдсөн (PAID) захиалгыг ӨӨРЧЛӨХГҮЙ — тэр дээр буцаалтын урсгал захиалгыг REFUNDED болгодог тул.
 */
export async function recordUnappliedPayment(tx: Prisma.TransactionClient, u: { reason: UnappliedReason; amount: number; orderId: string }): Promise<void> {
  if (u.reason !== "CANCELLED") return;
  await tx.order.updateMany({
    where: { id: u.orderId },
    data: { refundDueAmount: { increment: u.amount }, refundedAt: null },
  });
}

/**
 * Захиалгад төлбөр хэрэгжүүлнэ (гараар баталгаажуулах гэх мэт ШУУД дуудлагад).
 * Хэрэгжүүлэх боломжгүй бол OrderPaymentError шиднэ (юу ч бичигдэхгүй).
 */
export async function applyOrderPayment(
  orderId: string,
  amount: number,
  method: PaymentMethod,
  note?: string,
  combinedDepositRentalIds: string[] = [] // ✅ ШИНЭ — эдгээр барьцааг ЧХАМТ HELD болгоно
): Promise<void> {
  let outcome: PaymentOutcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const o = await applyOrderPaymentInTx(tx, orderId, amount, method, note, combinedDepositRentalIds);
        if (o.unapplied) throw new OrderPaymentError(unappliedMessage(o.unapplied.reason));
        return o;
      },
      { timeout: 30000 } // SALE_OUT олон бараатай захиалга / бүлгийн олон захиалгад анхдагч 5000мс дутуу
    );
  } catch (err) {
    if (err instanceof InsufficientStockError) throw new OrderPaymentError(err.message); // касс: юу ч бичигдээгүй, 409
    throw err;
  }
  await runAfterPayment(outcome);
}

/**
 * ГАРААР захиалгын төлбөр баталгаажуулах — QPay-гүйгээр (Бэлэн мөнгө эсвэл
 * Дансаар шилжүүлэлт). Үлдэгдэл дүнг (totalAmount - paidAmount) БҮРЭН
 * төлсөн гэж үзнэ.
 */
export async function markOrderPaidManually(
  orderId: string,
  params: { method: PaymentMethod; note?: string; combinedDepositRentalIds?: string[] }
): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  // ✅ ШИНЭ (marketplace): Бүлгийн гишүүн бол НЭГ сагсны БҮХ захиалгын үлдэгдлийг хамт төлсөн гэж бүртгэнэ
  if (order.orderGroupId) {
    const remainingGroup = groupRemaining(await loadGroupMembers(order.orderGroupId));
    if (remainingGroup <= 0) throw new OrderPaymentError("Энэ сагсны захиалгууд аль хэдийн бүрэн төлөгдсөн байна");
    await applyOrderPayment(orderId, remainingGroup, params.method, params.note, params.combinedDepositRentalIds ?? []);
    return;
  }

  if (order.paymentStatus === PayStatus.PAID) {
    throw new OrderPaymentError("Энэ захиалга аль хэдийн бүрэн төлөгдсөн байна");
  }
  if (order.paymentStatus === PayStatus.CANCELLED) {
    throw new OrderPaymentError("Цуцлагдсан захиалгад төлбөр бүртгэх боломжгүй");
  }

  const remaining = Number(order.totalAmount) - Number(order.paidAmount);
  if (remaining <= 0) {
    throw new OrderPaymentError("Төлөх үлдэгдэл дүн алга байна");
  }

  await applyOrderPayment(orderId, remaining, params.method, params.note, params.combinedDepositRentalIds ?? []);
}
