// ============================================================================
// ERRAND GUARDS — Курьерийн илгээмжийн төлбөрийн аюулгүйн сүлжээ.
// "Урьдчилж төлөх" (pay-first) загварт төлөөгүй илгээмж курьерт хэзээ ч санал
// болдоггүй, гэхдээ Staff гараар оноосон зэрэг ховор тохиолдолд илгээмж ТӨЛӨГДӨӨГҮЙ
// хэвээр ХҮРГЭГДЭЖ дуусаж болзошгүй. Тэр үед тухайн курьерийг ДАРУЙ хаана
// (хугацаа өгөхгүй) — хадгалсан "бан лист" БИШ, шууд ТООЦООЛСОН дүрэм тул төлмөгц
// автоматаар нээгдэнэ (cron, гар цэвэрлэгээ хэрэггүй).
// ============================================================================

import { OrderType, PayStatus, DeliveryAssignStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";

export async function findUnpaidDeliveredErrand(courierId: string) {
  return prisma.order.findFirst({
    where: {
      orderType: OrderType.COURIER_ERRAND,
      requestingCourierId: courierId,
      deliveryAssignStatus: DeliveryAssignStatus.DELIVERED,
      paymentStatus: { notIn: [PayStatus.PAID, PayStatus.CANCELLED] },
    },
    select: { orderNumber: true, deliveryFee: true },
  });
}

export function unpaidErrandMessage(o: { orderNumber: string; deliveryFee: unknown }): string {
  return `#${o.orderNumber} илгээмжийн ${Number(o.deliveryFee).toFixed(0)}₮ төлбөр төлөгдөөгүй тул шинэ илгээмж үүсгэх, хүргэлт авах боломжгүй боллоо. Эхлээд "Миний илгээмж" дээрээс төлнө үү.`;
}
