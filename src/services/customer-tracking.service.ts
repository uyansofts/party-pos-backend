import { prisma } from "../lib/prisma";
import { getCourierStats } from "./courier-stats.service";
import { validateRating } from "../lib/courier-identity";
import {
  CustomerTrackingError,
  AttemptLimiter,
  buildCustomerTrackingView,
  normalizeOrderNumber,
  phonesMatch,
  signCustomerToken,
} from "../lib/customer-tracking";

const trackingInclude = {
  customer: { select: { phone: true } },
  seller: { select: { name: true } }, // ✅ ШИНЭ (marketplace)
  items: { include: { product: { select: { name: true } }, rentalDetail: true } },
  courier: { select: { id: true, name: true, nickname: true, vehiclePlate: true, phone: true } },
  rating: { select: { stars: true } },
};

/** Хяналтын хуудас зөвхөн дэлгүүрийн захиалгад. Курьерийн илгээмж (COURIER_ERRAND) энд харагдахгүй. */
async function loadOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: trackingInclude as any });
  if (!order || (order as any).orderType === "COURIER_ERRAND") throw new CustomerTrackingError("Захиалга олдсонгүй", 404);
  return order as any;
}

export async function getCustomerView(orderId: string) {
  const order = await loadOrder(orderId);
  const stats = order.courier ? (await getCourierStats([order.courier.id])).get(order.courier.id) : undefined;

  // ✅ ШИНЭ (marketplace): Нэг сагсны (бүлгийн) захиалга бол нийт төлбөр + бусад захиалгын холбоос
  let group: { total: number; paid: number; payOrderId: string; siblings: Array<{ orderNumber: string; sellerName: string | null; token: string }> } | null = null;
  if (order.orderGroupId) {
    const members = (await prisma.order.findMany({
      where: { orderGroupId: order.orderGroupId },
      select: { id: true, orderNumber: true, totalAmount: true, paidAmount: true, cancelledAt: true, paymentStatus: true, seller: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    })) as any[];
    const live = members.filter((m) => !m.cancelledAt && m.paymentStatus !== "CANCELLED" && m.paymentStatus !== "REFUNDED");
    group = {
      total: live.reduce((s, m) => s + Number(m.totalAmount), 0),
      paid: live.reduce((s, m) => s + Number(m.paidAmount), 0),
      payOrderId: order.orderGroupId,
      siblings: members.filter((m) => m.id !== order.id).map((m) => ({ orderNumber: m.orderNumber, sellerName: m.seller?.name ?? null, token: signCustomerToken(m.id) })),
    };
  }
  // ✅ ШИНЭ: Энэ захиалгын барааны үнэлгээнүүд (үнэлсэн/үнэлээгүйг харуулахад)
  const reviews = (await prisma.productReview.findMany({ where: { orderId: order.id }, select: { productId: true, stars: true, comment: true, createdAt: true } })) as any[];
  return buildCustomerTrackingView({ ...order, group, reviews }, stats);
}

export const lookupLimiter = new AttemptLimiter(5, 15 * 60_000);

/** Захиалгын дугаар + утсаар токеныг сэргээнэ. Алдааны мессеж ҮРГЭЛЖ ижил (дугаар байгаа эсэхийг задруулахгүй). */
export async function lookupCustomerToken(orderNumberRaw: unknown, phoneRaw: unknown, limiter: AttemptLimiter = lookupLimiter) {
  const generic = () => new CustomerTrackingError("Захиалга олдсонгүй эсвэл утасны дугаар таарахгүй байна", 404);
  const orderNumber = normalizeOrderNumber(orderNumberRaw);
  if (!orderNumber) throw generic();

  const gate = limiter.check(orderNumber);
  if (!gate.allowed) {
    throw new CustomerTrackingError(`Хэт олон удаа буруу оролдлоо. ${Math.ceil(gate.retryAfterSec / 60)} минутын дараа дахин оролдоно уу`, 429);
  }

  const order = await prisma.order.findUnique({ where: { orderNumber }, include: { customer: { select: { phone: true } } } });
  const ok = !!order && (order as any).orderType !== "COURIER_ERRAND" && phonesMatch((order as any).customer?.phone, phoneRaw);
  if (!ok || !order) {
    limiter.fail(orderNumber);
    throw generic();
  }
  limiter.success(orderNumber);
  return { token: signCustomerToken(order.id), orderNumber: order.orderNumber };
}

/** Харилцагч хүргэсэн курьерээ үнэлнэ (1-5 од). Нэг захиалгад нэг л удаа. */
export async function rateAsCustomer(orderId: string, stars: unknown, comment: unknown) {
  const v = validateRating(stars, comment);
  if (!v.ok || !v.value) throw new CustomerTrackingError(v.error ?? "Үнэлгээ буруу байна", 400);
  const order = await loadOrder(orderId);
  const view = buildCustomerTrackingView(order);
  if (!view.rating.canRate) {
    throw new CustomerTrackingError(view.rating.myStars != null ? "Та энэ захиалгыг аль хэдийн үнэлсэн байна" : "Хүргэлт хийгдсэний дараа л үнэлэх боломжтой", 409);
  }
  try {
    await prisma.deliveryRating.create({ data: { orderId, courierId: order.courier.id, raterCustomerId: order.customerId ?? null, stars: v.value.stars, comment: v.value.comment } });
  } catch (err: any) {
    if (err?.code === "P2002") throw new CustomerTrackingError("Та энэ захиалгыг аль хэдийн үнэлсэн байна", 409);
    throw err;
  }
  return { stars: v.value.stars };
}
