// ============================================================================
// SELLER ORDER SERVICE — Худалдагчийн захиалгын амьдралын мөчлөг (Staff худалдагчийн өмнөөс удирдана):
//   AWAITING_SELLER → ACCEPTED → READY (→ курьерт автоматаар санал болно) | REJECTED / EXPIRED (→ мөнгө буцаана)
// Бүх төлөв өөрчлөлт "тодорхой төлөвөөс" атомик updateMany-аар — хоёр Staff зэрэг дарсан ч эсвэл хугацаа
// дууссан мөчид дарсан ч давхар/буруу шилжилт гарахгүй.
// ============================================================================

import { prisma } from "../lib/prisma";
import { sellerItemView } from "../lib/seller-order-items";
import { emitToStore } from "../realtime/socket";
import { offerDeliveryToAllCouriers } from "./delivery-assignment.service";
import { nextSellerStatus } from "../lib/marketplace";

export class SellerOrderError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "SellerOrderError";
    this.status = status;
  }
}

const LIST_STATUSES = ["AWAITING_SELLER", "ACCEPTED", "READY", "REJECTED", "EXPIRED"];
const STATE_CHANGED = "Төлөв дөнгөж өөрчлөгдлөө (өөр Staff дарсан эсвэл хугацаа дууссан) — жагсаалтаа шинэчилнэ үү";

async function loadSellerOrder(orderId: string, asSellerId?: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId } });
  // ✅ ШИНЭ (портал): Худалдагч ЗӨВХӨН өөрийн захиалгад хандана — бусдынх "олдсонгүй" (оршихуйг ч задруулахгүй)
  if (!o || !o.sellerId || (asSellerId && o.sellerId !== asSellerId)) throw new SellerOrderError("Худалдагчийн захиалга олдсонгүй", 404);
  return o;
}

/** Staff-ийн жагсаалт: худалдагч, бараа, комисс, худалдагчид очих дүн, авах КОД (худалдагчид уншиж өгөхөд). */
export async function listSellerOrders(status?: string, opts: { sellerId?: string; limit?: number } = {}) {
  const orders = await prisma.order.findMany({
    where: {
      sellerId: opts.sellerId ?? { not: null },
      sellerStatus: (status && LIST_STATUSES.includes(status) ? status : { in: LIST_STATUSES }) as any,
    },
    ...(opts.limit ? { take: opts.limit } : {}),
    include: {
      seller: { select: { id: true, name: true, phone: true, pickupAddress: true } },
      items: { include: { product: { select: { name: true, color: true, size: true } } } }, // ✅ өнгө/хэмжээ нэмсэн
      customer: { select: { name: true, phone: true } },
    },
    orderBy: [{ sellerAcceptDeadline: "asc" }, { createdAt: "desc" }],
  });
  const now = Date.now();
  return orders.map((o: any) => {
    const itemsTotal = Number(o.totalAmount) - Number(o.deliveryFee) - Number(o.urgentFee ?? 0);
    const commission = Number(o.commissionAmount ?? 0);
    const picked = ["PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED"].includes(o.deliveryAssignStatus);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      sellerStatus: o.sellerStatus,
      paymentStatus: o.paymentStatus,
      deliveryAssignStatus: o.deliveryAssignStatus,
      createdAt: o.createdAt,
      sellerAcceptDeadline: o.sellerAcceptDeadline,
      overdue: o.sellerStatus === "AWAITING_SELLER" && !!o.sellerAcceptDeadline && new Date(o.sellerAcceptDeadline).getTime() <= now,
      sellerRespondedAt: o.sellerRespondedAt,
      sellerReadyAt: o.sellerReadyAt ?? null, // ✅ ШИНЭ — Staff хэр удаан хүлээснийг харна
      rejectReason: o.sellerRejectReason,
      seller: o.seller,
      // ✅ ЗАСВАР: Худалдагч хийхэд шаардлагатай БҮХ мэдээлэл (өнгө, хэмжээ, сонголт, бичвэр, материал, хэрэгтэй өдөр) — өмнө зөвхөн нэр×тоо байсан
      items: o.items.map((i: any) => sellerItemView(i)),
      neededByDate: o.neededByDate ?? null, // Харилцагчид хэзээ хэрэгтэй
      isUrgent: Number(o.urgentFee ?? 0) > 0, // Яаралтай (нэмэлт төлбөртэй) захиалга
      itemsTotal,
      commissionPercent: o.commissionPercent,
      commissionAmount: commission,
      sellerNet: itemsTotal - commission,
      // Худалдагчаас курьерт өгөх код: курьер бараа авсны дараа нуугдана
      handoffCode: ["ACCEPTED", "READY", "AWAITING_SELLER"].includes(o.sellerStatus) && !picked ? o.pickupOtp : null,
      customerName: o.customer?.name ?? null,
      refundDueAmount: Number(o.refundDueAmount ?? 0),
      refundedAt: o.refundedAt,
    };
  });
}

export async function acceptSellerOrder(orderId: string, asSellerId?: string) {
  const o = await loadSellerOrder(orderId, asSellerId);
  const plan = nextSellerStatus(o.sellerStatus as any, "accept");
  if (!plan.ok) throw new SellerOrderError(plan.error!, 409);
  const r = await prisma.order.updateMany({ where: { id: orderId, sellerStatus: "AWAITING_SELLER" as any, ...(asSellerId ? { sellerId: asSellerId } : {}) }, data: { sellerStatus: "ACCEPTED" as any, sellerRespondedAt: new Date() } });
  if (r.count === 0) throw new SellerOrderError(STATE_CHANGED, 409);
  return { orderId, sellerStatus: "ACCEPTED" };
}

/**
 * Худалдагч "Бэлэн" болгоно → захиалга курьерүүдэд АВТОМАТААР санал болно (төлбөр урьдчилж орсон, Uber шиг).
 * Санал болгох боломжгүй бол (жишээ нь шөнийн цаг) төлөв READY хэвээр үлдэж, Staff өглөө POS-оос гаргана —
 * тухайн шалтгааныг (offerError) буцаана.
 */
export async function markSellerOrderReady(orderId: string, asSellerId?: string) {
  const o = await loadSellerOrder(orderId, asSellerId);
  const plan = nextSellerStatus(o.sellerStatus as any, "ready");
  if (!plan.ok) throw new SellerOrderError(plan.error!, 409);
  const r = await prisma.order.updateMany({
    where: { id: orderId, sellerStatus: { in: ["AWAITING_SELLER", "ACCEPTED"] as any }, ...(asSellerId ? { sellerId: asSellerId } : {}) },
    data: { sellerStatus: "READY" as any, sellerRespondedAt: o.sellerRespondedAt ?? new Date(), sellerReadyAt: new Date() },
  });
  if (r.count === 0) throw new SellerOrderError(STATE_CHANGED, 409);

  // ✅ ШИНЭ: Худалдагч өөрөө портал дээрээс "Бэлэн" дарсан үед (asSellerId) — тохиргоо АВТОМАТ биш бол курьерт шууд санал БОЛГОХГҮЙ:
  // Staff POS дээр "бэлэн болсон" гэдгийг мэдэж, шалгаад өөрөө "Курьерт санал болгох" дарна. Staff өөрөө "Бэлэн" дарсан бол шууд санал болгоно.
  const settings: any = asSellerId ? await prisma.shopSettings.findUnique({ where: { id: "default" } }) : null; // Staff-ийн замд тохиргоо хэрэггүй
  if (asSellerId && !settings?.sellerReadyAutoOffer) {
    try {
      const seller = await prisma.seller.findUnique({ where: { id: o.sellerId as string }, select: { name: true } });
      emitToStore((o as any).storeId ?? "default", "seller_order_ready", { orderId, orderNumber: o.orderNumber, sellerName: seller?.name ?? "" });
    } catch (err) {
      console.error("Худалдагч бэлэн болсон мэдэгдлийг Staff-д илгээхэд алдаа гарлаа (захиалга READY боллоо):", err);
    }
    return { orderId, sellerStatus: "READY", offered: false, offerError: null, awaitingStaff: true };
  }

  let offered = false;
  let offerError: string | null = null;
  try {
    await offerDeliveryToAllCouriers(orderId);
    offered = true;
  } catch (err: any) {
    offerError = err?.message ?? "Курьерт санал болгож чадсангүй";
    console.error("Худалдагчийн захиалгыг курьерт санал болгоход алдаа гарлаа (Staff гараар санал болгоно):", err);
  }
  return { orderId, sellerStatus: "READY", offered, offerError };
}

/** Татгалзсан / хугацаа дууссан: захиалга цуцлагдаж, төлсөн мөнгө БУЦААХ ёстой гэж тэмдэглэгдэнэ, нөөц сэргээгдэнэ. */
async function cancelSellerOrder(orderId: string, status: "REJECTED" | "EXPIRED", reason: string, asSellerId?: string) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } } } });
    if (!o || !o.sellerId || (asSellerId && o.sellerId !== asSellerId)) throw new SellerOrderError("Худалдагчийн захиалга олдсонгүй", 404);
    const plan = nextSellerStatus(o.sellerStatus as any, "reject");
    if (!plan.ok) throw new SellerOrderError(plan.error!, 409);

    const now = new Date();
    const upd = await tx.order.updateMany({
      where: { id: orderId, sellerStatus: { in: ["AWAITING_SELLER", "ACCEPTED"] as any }, ...(asSellerId ? { sellerId: asSellerId } : {}) },
      data: {
        sellerStatus: status as any,
        sellerRespondedAt: now,
        sellerRejectReason: reason,
        cancelledAt: now,
        cancelReason: reason,
        deliveryAssignStatus: "CANCELLED" as any,
        refundDueAmount: Number(o.paidAmount), // Staff харилцагчид буцаах ёстой дүн
      },
    });
    if (upd.count === 0) throw new SellerOrderError(STATE_CHANGED, 409);

    // Төлбөр бүрэн орсон үед нөөц хасагдсан тул сэргээнэ (материалаар үнэлэгдэх бараа нөөцөөс хасагддаггүй)
    if (o.paymentStatus === "PAID") {
      for (const item of o.items) {
        if (item.itemType === "SALE" && !item.product.usesMaterialPricing) {
          await tx.product.update({ where: { id: item.productId }, data: { sellStockQty: { increment: item.quantity } } });
          await tx.stockMovement.create({
            data: { productId: item.productId, type: "ADJUSTMENT" as any, quantity: item.quantity, referenceOrderId: orderId, note: `Худалдагч татгалзсан/хугацаа дууссан — нөөц сэргээв #${o.orderNumber}` },
          });
        }
      }
    }
    return { orderNumber: o.orderNumber, storeId: o.storeId, refundDue: Number(o.paidAmount) };
  });

  try {
    emitToStore(result.storeId, status === "EXPIRED" ? "seller_order_expired" : "seller_order_rejected", {
      orderId,
      orderNumber: result.orderNumber,
      refundDue: result.refundDue,
      reason,
    });
  } catch (err) {
    console.error("Худалдагчийн татгалзлын мэдэгдэл илгээхэд алдаа гарлаа (захиалга цуцлагдсан):", err);
  }
  return { orderId, sellerStatus: status, refundDue: result.refundDue };
}

export async function rejectSellerOrder(orderId: string, reason: unknown, asSellerId?: string) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) throw new SellerOrderError("Татгалзсан шалтгаанаа бичнэ үү (дор хаяж 3 тэмдэгт)");
  if (text.length > 200) throw new SellerOrderError("Шалтгаан 200 тэмдэгтээс ихгүй байх ёстой");
  return cancelSellerOrder(orderId, "REJECTED", text, asSellerId);
}

/**
 * ✅ ШИНЭ (портал): Худалдагчид харагдах ЗӨВШӨӨРСӨН талбарууд (allowlist). Харилцагчийн нэр/утас/хаяг, төлбөрийн төлөв,
 * буцаалтын дүн, Staff-ийн дотоод талбар ХЭЗЭЭ Ч орохгүй — худалдагчид зөвхөн бараа, өөрийн орлого, авах код хэрэгтэй.
 */
export function toPortalOrder(o: any) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    sellerStatus: o.sellerStatus,
    deliveryAssignStatus: o.deliveryAssignStatus,
    createdAt: o.createdAt,
    sellerAcceptDeadline: o.sellerAcceptDeadline,
    overdue: o.overdue,
    neededByDate: o.neededByDate ?? null,
    isUrgent: !!o.isUrgent,
    items: o.items,
    itemsTotal: o.itemsTotal,
    commissionPercent: o.commissionPercent,
    commissionAmount: o.commissionAmount,
    sellerNet: o.sellerNet,
    handoffCode: o.handoffCode,
    rejectReason: o.rejectReason,
  };
}

export async function listPortalOrders(sellerId: string) {
  return (await listSellerOrders(undefined, { sellerId, limit: 200 })).map(toPortalOrder);
}

/** Staff харилцагчид мөнгийг буцааж өгсөн гэж тэмдэглэнэ. */
export async function completeSellerRefund(orderId: string) {
  const o = await loadSellerOrder(orderId);
  if (o.sellerStatus !== "REJECTED" && o.sellerStatus !== "EXPIRED") throw new SellerOrderError("Энэ захиалга цуцлагдаагүй тул буцаалт хийх зүйлгүй", 409);
  const r = await prisma.order.updateMany({
    where: { id: orderId, refundedAt: null, refundDueAmount: { gt: 0 } },
    data: { refundedAt: new Date(), refundDueAmount: 0, paymentStatus: "REFUNDED" as any },
  });
  if (r.count === 0) throw new SellerOrderError("Буцаах дүн алга эсвэл аль хэдийн буцаагдсан байна", 409);
  return { orderId, refunded: Number(o.refundDueAmount) };
}

/** Хугацаандаа зөвшөөрөгдөөгүй захиалгуудыг автоматаар цуцална (cron). Буцаах: цуцалсан тоо. */
export async function expireStaleSellerOrders(nowMs: number = Date.now()): Promise<number> {
  const stale = await prisma.order.findMany({
    where: { sellerStatus: "AWAITING_SELLER" as any, sellerAcceptDeadline: { lte: new Date(nowMs) } },
    select: { id: true },
  });
  let n = 0;
  for (const s of stale) {
    try {
      await cancelSellerOrder(s.id, "EXPIRED", "Худалдагч хугацаандаа зөвшөөрөөгүй");
      n++;
    } catch (err) {
      if (!(err instanceof SellerOrderError && err.status === 409)) console.error(`Худалдагчийн захиалга (${s.id}) хугацаа дуусгахад алдаа:`, err);
    }
  }
  return n;
}

const EXPIRY_CHECK_MS = 10 * 60 * 1000;
export function startSellerOrderExpiryJob() {
  const timer = setInterval(() => {
    expireStaleSellerOrders().catch((err) => console.error("Худалдагчийн захиалгын хугацаа шалгахад алдаа:", err));
  }, EXPIRY_CHECK_MS);
  timer.unref?.();
  return timer;
}
