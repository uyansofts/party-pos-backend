// ============================================================================
// ORDER REFUND SERVICE — төлөгдсөн (PAID) захиалгын буцаалт (ADMIN)
// ----------------------------------------------------------------------------
// Дүрмийг lib/refund-policy.ts тодорхойлно. Энд зөвхөн АТОМИК гүйцэтгэл:
//   - мөр бүрийг `updateMany({ where: { refundedAt: null } })`-аар нэг удаа "буцаагдсан" гэж claim хийнэ
//     → ижил мөрийг хоёр удаа буцаах (мөнгө/нөөц давхар) боломжгүй; claim бүтэлгүйтвэл transaction бүхэлдээ буцна.
//   - бүрэн буцаалт: PAID → REFUNDED (атомик claim). Хэсэгчилсэн: захиалга PAID хэвээр (хайчлагдах барааны мөнгө үлдэнэ).
//   - энгийн SALE барааны нөөцийг сэргээнэ (олгогдсон мөрөөс бусад), StockMovement(ADJUSTMENT) бичнэ.
//   - материалын нөөц ХӨДЛӨХГҮЙ (хайчлагдах бараа буцаагдахгүй).
// ⚠️ OrderItem.refundedAt багана шаардлагатай — prisma/proposed/20261011_order_item_refunded_at-ийг schema-д
//    ӨМНӨ нь хэрэгжүүлсний дараа л ашиглана (хэрэгжүүлээгүй бол буцаалт алдаа өгнө).
// ============================================================================

import { prisma } from "../lib/prisma";
import { planOrderRefund, type RefundItem } from "../lib/refund-policy";
import { toCents } from "../lib/payment-guards";

export class OrderRefundError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "OrderRefundError";
    this.status = status;
  }
}

const CHANGED = "Захиалга эсвэл мөрийн төлөв өөрчлөгдсөн тул буцаалт хийх боломжгүй (дахин ачаалж үзнэ үү)";

export interface OrderRefundResult {
  kind: "full" | "partial";
  /** Харилцагчид буцаах дүн (₮). full: төлсөн бүх дүн; partial: зөвхөн хайчлагдах бус мөрүүдийн subtotal. */
  refundAmount: number;
  /** Буцаагдахгүй үлдэх (хайчлагдах барааны) дүн. */
  keptAmount: number;
  refundedItemIds: string[];
  restocked: Array<{ productId: string; quantity: number }>;
}

export async function refundPaidOrder(orderId: string, actorId?: string | null): Promise<OrderRefundResult> {
  const result = await prisma.$transaction(
    async (tx): Promise<OrderRefundResult & { orderNumber: string }> => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new OrderRefundError("Захиалга олдсонгүй", 404);
      if (order.paymentStatus !== "PAID" || order.cancelledAt) throw new OrderRefundError(CHANGED);

      const items = (await tx.orderItem.findMany({ where: { orderId }, include: { product: true } })) as unknown as RefundItem[];
      const plan = planOrderRefund(items);
      if (plan.kind === "none") throw new OrderRefundError(plan.error);
      // ⚠️ Худалдагчийн (marketplace) захиалгын ХЭСЭГЧИЛСЭН буцаалт: худалдагчид олгох дүн (seller-settlement) нь
      // захиалгын нийт дүн − комиссоор тооцогддог, мөрийн буцаалтыг тооцдоггүй → буцаасан мөрийн мөнгийг худалдагчид давхар олгоно.
      // Тиймээс энд татгалзаж, гараар (худалдагчийн тооцоотой хамт) шийдүүлнэ. Бүрэн буцаалт (REFUNDED) тооцооноос хасагддаг тул зөвшөөрнө.
      if (plan.kind === "partial" && order.sellerId) {
        throw new OrderRefundError(
          "Худалдагчийн захиалгад хэсэгчилсэн буцаалтыг энд хийх боломжгүй: худалдагчид олгох дүн буруу гарна. Худалдагчийн тооцоотой хамт гараар зохицуулна уу"
        );
      }

      const now = new Date();

      // 1) Мөр бүрийн claim (давхар буцаалтаас хамгаална)
      const claim = await tx.orderItem.updateMany({
        where: { orderId, id: { in: plan.refundItemIds }, refundedAt: null } as any,
        data: { refundedAt: now } as any,
      });
      if (claim.count !== plan.refundItemIds.length) throw new OrderRefundError(CHANGED);

      // 2) Захиалгын төлөв: бүрэн бол REFUNDED; хэсэгчилсэн бол PAID хэвээр (зөвхөн мөрийг түгжиж, зэрэгцээ цуцлалтыг шалгана)
      const orderClaim = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: "PAID" as any, cancelledAt: null },
        data: plan.kind === "full" ? { paymentStatus: "REFUNDED" as any, refundedAt: now } : { paymentStatus: "PAID" as any },
      });
      if (orderClaim.count === 0) throw new OrderRefundError(CHANGED);

      // 3) Энгийн барааны нөөц сэргээх
      for (const l of plan.restockLines) {
        const r = await tx.product.updateMany({ where: { id: l.productId }, data: { sellStockQty: { increment: l.quantity } } });
        if (r.count === 0) throw new OrderRefundError(`Бараа олдсонгүй (${l.productId}) тул нөөц сэргээж чадсангүй`);
        await tx.stockMovement.create({
          data: {
            productId: l.productId,
            type: "ADJUSTMENT" as any,
            quantity: l.quantity,
            referenceOrderId: orderId,
            note: `Буцаалт — нөөц сэргээв #${order.orderNumber}`,
          },
        });
      }

      const refundAmount = plan.kind === "full" ? toCents(Number(order.paidAmount)) / 100 : plan.itemsRefundAmount;
      return {
        kind: plan.kind,
        refundAmount,
        keptAmount: plan.keptAmount,
        refundedItemIds: plan.refundItemIds,
        restocked: plan.restockLines,
        orderNumber: order.orderNumber,
      };
    },
    { timeout: 15000 }
  );

  console.warn(
    `[audit] order ${orderId} ${result.kind === "full" ? "PAID→REFUNDED" : "PARTIAL REFUND"} amount=${result.refundAmount} kept=${result.keptAmount} items=${result.refundedItemIds.length} by staff ${actorId ?? "?"}`
  );
  const { orderNumber: _n, ...out } = result;
  return out;
}
