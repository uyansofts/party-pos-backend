// ============================================================================
// COURIER FEEDBACK — Курьерийн илгээмжийн илгээгч (1) хүргэсэн курьерт од өгнө,
// (2) курьер бараа аваагүй байхад "таалагдсангүй" гэж өөр курьер сонгуулна.
// ============================================================================

import { OrderType, DeliveryAssignStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emitToCourier } from "../realtime/socket";
import { sendPushToCourier } from "../lib/push-notifications";
import { validateRating } from "../lib/courier-identity";
import { offerDeliveryToAllCouriers } from "./delivery-assignment.service";

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

/** Нэг илгээмжид илгээгч хамгийн ихдээ хэдэн удаа курьер солих (курьер зам туулсныг хүндэтгэж, урхи тоглохоос сэргийлнэ). */
export const MAX_COURIER_SWAPS = 2;

export async function rateErrandCourier(orderId: string, requesterId: string, stars: unknown, comment: unknown) {
  const v = validateRating(stars, comment);
  if (!v.ok || !v.value) throw new FeedbackError(v.error ?? "Үнэлгээ буруу байна");

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderType: true, requestingCourierId: true, courierId: true, deliveryAssignStatus: true },
  });
  if (!order || order.orderType !== OrderType.COURIER_ERRAND) throw new FeedbackError("Илгээмж олдсонгүй");
  if (order.requestingCourierId !== requesterId) throw new FeedbackError("Зөвхөн илгээмжийг илгээсэн курьер үнэлэх боломжтой");
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.DELIVERED || !order.courierId) {
    throw new FeedbackError("Илгээмж хүргэгдсэний дараа л үнэлэх боломжтой");
  }

  try {
    await prisma.deliveryRating.create({
      data: { orderId, courierId: order.courierId, raterCourierId: requesterId, stars: v.value.stars, comment: v.value.comment },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new FeedbackError("Та энэ илгээмжийг аль хэдийн үнэлсэн байна");
    throw err;
  }
  return { stars: v.value.stars };
}

/**
 * Илгээгч курьер бараа АВАХААС ӨМНӨ (ASSIGNED) одоогийн курьерт сэтгэл ханахгүй бол солино:
 * илгээмж сан руу буцаж, тэр курьерээс бусдад дахин санал болно. Илгээгчид хураамж ногдохгүй.
 */
export async function rejectAssignedCourier(orderId: string, requesterId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderType: true, requestingCourierId: true, courierId: true, deliveryAssignStatus: true, orderNumber: true },
  });
  if (!order || order.orderType !== OrderType.COURIER_ERRAND) throw new FeedbackError("Илгээмж олдсонгүй");
  if (order.requestingCourierId !== requesterId) throw new FeedbackError("Зөвхөн илгээмжийг илгээсэн курьер солих боломжтой");
  if (order.deliveryAssignStatus === DeliveryAssignStatus.PICKED_UP) {
    throw new FeedbackError("Курьер бараагаа аль хэдийн авсан тул солих боломжгүй");
  }
  if (order.deliveryAssignStatus !== DeliveryAssignStatus.ASSIGNED || !order.courierId) {
    throw new FeedbackError("Одоогоор илгээмжийг авсан курьер байхгүй байна");
  }

  const swaps = await prisma.deliveryOfferResponse.count({ where: { orderId, response: "REJECTED_BY_REQUESTER" as any } });
  if (swaps >= MAX_COURIER_SWAPS) {
    throw new FeedbackError(`Курьер солих эрх дууссан (${MAX_COURIER_SWAPS} удаа) — илгээмжээ цуцалж дахин үүсгэнэ үү`);
  }

  const oldCourierId = order.courierId;
  const result = await prisma.order.updateMany({
    where: { id: orderId, requestingCourierId: requesterId, courierId: oldCourierId, deliveryAssignStatus: DeliveryAssignStatus.ASSIGNED },
    data: { courierId: null, deliveryAssignStatus: DeliveryAssignStatus.UNASSIGNED, deliveryAcceptedAt: null },
  });
  if (result.count === 0) {
    throw new FeedbackError("Илгээмжийн төлөв дөнгөж өөрчлөгдлөө (жишээ нь курьер бараагаа авлаа) — дахин оролдоно уу");
  }

  await prisma.deliveryOfferResponse
    .upsert({
      where: { orderId_courierId: { orderId, courierId: oldCourierId } },
      update: { response: "REJECTED_BY_REQUESTER" as any, respondedAt: new Date() },
      create: { orderId, courierId: oldCourierId, response: "REJECTED_BY_REQUESTER" as any },
    })
    .catch((e) => console.error("Курьер солилт бүртгэхэд алдаа гарлаа:", e));

  try {
    emitToCourier(oldCourierId, "delivery_rejected_by_sender", { orderId, orderNumber: order.orderNumber });
    await sendPushToCourier(oldCourierId, "🙅 Илгээгч өөр курьер сонголоо", `#${order.orderNumber} — илгээгч өөр курьер сонгосон тул энэ хүргэлт таны жагсаалтаас хасагдлаа`, { orderId });
    await offerDeliveryToAllCouriers(orderId, [oldCourierId]);
  } catch (err) {
    console.error("Курьер солисны дараа дахин санал болгоход алдаа гарлаа (Staff гараар санал болгож болно):", err);
  }
  return { swapsLeft: MAX_COURIER_SWAPS - swaps - 1 };
}
