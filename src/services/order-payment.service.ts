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
import { OrderType, PaymentType, PaymentMethod, PayStatus, StockMovementType, DepositStatus, DepositType, DeliveryAssignStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emitToStore } from "../realtime/socket";
import { consumeMaterialsForOrder, type LowStockMaterial } from "./material.service";
import { offerDeliveryToAllCouriers } from "./delivery-assignment.service";
import type { NewOnlineOrderPayload } from "../types/payment.types";
import { DEFAULT_SELLER_ACCEPT_HOURS, groupRemaining, planGroupAllocation, sellerAcceptDeadlineFrom, type GroupMember } from "../lib/marketplace";


export class OrderPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPaymentError";
  }
}

/** Захиалгад төлбөр хэрэгжүүлэх ГОЛ логик — нэг transaction дотор (нэг захиалга эсвэл бүлгийн хэд хэдэн захиалгад). */
async function applyPaymentCore(
  tx: Prisma.TransactionClient,
  orderId: string,
  amount: number,
  method: PaymentMethod,
  note: string | undefined,
  combinedDepositRentalIds: string[]
): Promise<{ saved: any; lowStock: LowStockMaterial[] }> {
  // ✅ ШИНЭ: Материалын нөөц доод үлдэгдэлд хүрсэн эсэх (транзакц дууссаны ДАРАА сануулна)
  let lowStockMaterials: LowStockMaterial[] = [];

  await tx.payment.create({
    data: { orderId, type: PaymentType.SALE_PAYMENT, method, amount, note },
  });

  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { include: { product: true } }, customer: true },
  });

  const newPaidAmount = Number(order.paidAmount) + amount;
  const isFullyPaid = newPaidAmount >= Number(order.totalAmount);

  let saved = await tx.order.update({
    where: { id: orderId },
    data: {
      paidAmount: newPaidAmount,
      paymentStatus: isFullyPaid ? PayStatus.PAID : PayStatus.PARTIALLY_PAID,
    },
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
    for (const item of saved.items) {
      if (item.itemType === "SALE") {
        // ✅ ШИНЭ: Материалаар үнэлэгдэх (захиалгаар хийгддэг) бараа нь барааны нөөцөөс биш,
        // доор материалын нөөцөөс (см²) хасагдана — эс бөгөөс барааны нөөц хоосон байгаад сөрөг болно.
        if (!item.product.usesMaterialPricing) {
          await tx.product.update({
            where: { id: item.productId },
            data: { sellStockQty: { decrement: item.quantity } },
          });
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: StockMovementType.SALE_OUT,
              quantity: item.quantity,
              referenceOrderId: orderId,
              note: `${saved.orderType === OrderType.ONLINE ? "Онлайн" : "Кассын"} захиалга #${saved.orderNumber}`,
            },
          });
        }

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

  return { saved, lowStock: lowStockMaterials };
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
        affectedProductIds: updatedOrder.items.map((i:any) => i.productId),
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

/** Бүлгийн (нэг сагсны) гишүүд — цуцлагдсан/буцаагдсаныг тэмдэглэнэ. */
async function loadGroupMembers(groupId: string): Promise<GroupMember[]> {
  const rows = await prisma.order.findMany({
    where: { orderGroupId: groupId },
    select: { id: true, totalAmount: true, paidAmount: true, cancelledAt: true, paymentStatus: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    totalAmount: Number(r.totalAmount),
    paidAmount: Number(r.paidAmount),
    cancelled: !!r.cancelledAt || r.paymentStatus === PayStatus.CANCELLED || r.paymentStatus === PayStatus.REFUNDED,
  }));
}

/** Захиалга бүлгийн гишүүн бол бүлгийн төлөх үлдэгдэл, үгүй бол null. (Нийтийн invoice-ийн дүнг шалгахад ашиглана.) */
export async function getGroupRemaining(orderId: string): Promise<number | null> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderGroupId: true } });
  if (!o?.orderGroupId) return null;
  return groupRemaining(await loadGroupMembers(o.orderGroupId));
}

/**
 * ✅ ШИНЭ (marketplace): НЭГ төлбөрийг бүлгийн бүх (цуцлагдаагүй) захиалгад хуваарилна — БҮГД НЭГ transaction-д:
 * дундаас алдаа гарвал юу ч хэсэгчлэн бүртгэгдэхгүй. Хуваарилалтын дүрмийг planGroupAllocation (цэвэр функц) тодорхойлно.
 */
async function applyGroupPayment(
  groupId: string,
  amount: number,
  method: PaymentMethod,
  note: string | undefined,
  combinedDepositRentalIds: string[]
): Promise<void> {
  const members = await loadGroupMembers(groupId);
  const plan = planGroupAllocation(members, amount, groupId);
  if (plan.length === 0) throw new OrderPaymentError("Төлөх үлдэгдэл дүн алга байна");

  const results = await prisma.$transaction(
    async (tx) => {
      const out: Array<{ saved: any; lowStock: LowStockMaterial[] }> = [];
      for (let i = 0; i < plan.length; i++) {
        out.push(await applyPaymentCore(tx, plan[i].orderId, plan[i].amount, method, note, i === 0 ? combinedDepositRentalIds : []));
      }
      return out;
    },
    { timeout: 30000 }
  );
  for (const r of results) await afterPayment(r.saved, r.lowStock);
}

/**
 * Захиалгад төлбөр хэрэгжүүлнэ (QPay webhook болон гараар баталгаажуулах хоёулаа үүнийг дуудна).
 * Захиалга бүлгийн (нэг сагсны) гишүүн бол төлбөрийг бүлгийн захиалгуудад хуваарилна.
 */
export async function applyOrderPayment(
  orderId: string,
  amount: number,
  method: PaymentMethod,
  note?: string,
  combinedDepositRentalIds: string[] = [] // ✅ ШИНЭ — эдгээр барьцааг ЧХАМТ HELD болгоно
): Promise<void> {
  const target = await prisma.order.findUnique({ where: { id: orderId }, select: { orderGroupId: true } });
  if (target?.orderGroupId) return applyGroupPayment(target.orderGroupId, amount, method, note, combinedDepositRentalIds);

  const result = await prisma.$transaction((tx) => applyPaymentCore(tx, orderId, amount, method, note, combinedDepositRentalIds), { timeout: 15000 }); // ✅ ШИНЭ — SALE_OUT олон бараатай захиалгад анхдагч 5000мс дутуу байсан
  await afterPayment(result.saved, result.lowStock);
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
