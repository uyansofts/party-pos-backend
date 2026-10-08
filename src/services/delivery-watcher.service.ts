// ============================================================================
// DELIVERY WATCHER — Хүргэлтийн хяналт (60 секунд тутамд ажиллана).
// ----------------------------------------------------------------------------
// 1) Курьер хүлээн авснаас хойш ASSIGNED_STALE_MINUTES (анхдагч 120 мин)
//    дотор дэлгүүрт ирж бараагаа аваагүй бол POS-д сануулна.
// 2) Барааг аваад PICKED_UP төлөвт ON_THE_WAY_STALE_MINUTES (анхдагч 180 мин)
//    өнгөрсөн ч хүргээгүй бол POS-д сануулна.
// 3) Түрээсийн буцаалтын өдрөөс RETURN_REMINDER_HOURS (анхдагч 24 цаг) өмнө
//    курьерт push мэдэгдэл явуулна (мөн POS-д мэдэгдэнэ).
// Давхар сануулга явуулахгүйн тулд Order.deliveryAlertLevel / returnReminderSent
// талбарыг ашиглана. Хугацааг .env-ээр өөрчилж болно:
//   DELIVERY_ASSIGNED_STALE_MINUTES, DELIVERY_ON_THE_WAY_STALE_MINUTES,
//   RENTAL_RETURN_REMINDER_HOURS
// ============================================================================

import { DeliveryAssignStatus, OrderType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emitToStore, emitToCourier } from "../realtime/socket";
import { sendPushToCourier } from "../lib/push-notifications";

export const ASSIGNED_STALE_MINUTES = Number(process.env.DELIVERY_ASSIGNED_STALE_MINUTES) || 120;
export const ON_THE_WAY_STALE_MINUTES = Number(process.env.DELIVERY_ON_THE_WAY_STALE_MINUTES) || 180;
export const ERRAND_LOCATION_STALE_MINUTES = Number(process.env.ERRAND_LOCATION_STALE_MINUTES) || 5; // ✅ ШИНЭ
const ERRAND_LOCATION_REALERT_MINUTES = Number(process.env.ERRAND_LOCATION_REALERT_MINUTES) || 15;
const RETURN_REMINDER_HOURS = Number(process.env.RENTAL_RETURN_REMINDER_HOURS) || 24;
const CHECK_INTERVAL_MS = 60_000;

let isRunning = false;

/** Курьер хүлээн авсан ч дэлгүүрт ирж бараагаа аваагүй удсан захиалгууд. */
async function checkNotPickedUp() {
  const cutoff = new Date(Date.now() - ASSIGNED_STALE_MINUTES * 60_000);
  const orders = await prisma.order.findMany({
    where: {
      deliveryAssignStatus: DeliveryAssignStatus.ASSIGNED,
      deliveryAcceptedAt: { lt: cutoff },
      deliveryAlertLevel: { lt: 1 },
      paymentStatus: { not: "CANCELLED" },
    },
    include: { courier: { select: { name: true } } },
  });

  for (const o of orders) {
    const minutes = Math.round((Date.now() - (o.deliveryAcceptedAt as Date).getTime()) / 60_000);
    emitToStore(o.storeId, "delivery_stale_alert", {
      orderId: o.id,
      orderNumber: o.orderNumber,
      kind: "NOT_PICKED_UP",
      isErrand: o.orderType === "COURIER_ERRAND", // ✅ ШИНЭ — POS-д "дэлгүүрт" биш "авах хаягт" гэж бичихэд
      courierName: o.courier?.name ?? null,
      minutes,
    });
    await prisma.order.update({ where: { id: o.id }, data: { deliveryAlertLevel: 1 } });
  }
}

/** Барааг аваад замд гарсан ч хүргээгүй удсан захиалгууд. */
async function checkOnTheWaySlow() {
  const cutoff = new Date(Date.now() - ON_THE_WAY_STALE_MINUTES * 60_000);
  const orders = await prisma.order.findMany({
    where: {
      deliveryAssignStatus: DeliveryAssignStatus.PICKED_UP,
      pickedUpAt: { lt: cutoff },
      deliveryAlertLevel: { lt: 2 },
      paymentStatus: { not: "CANCELLED" },
    },
    include: { courier: { select: { name: true } } },
  });

  for (const o of orders) {
    const minutes = Math.round((Date.now() - (o.pickedUpAt as Date).getTime()) / 60_000);
    emitToStore(o.storeId, "delivery_stale_alert", {
      orderId: o.id,
      orderNumber: o.orderNumber,
      kind: "ON_THE_WAY_SLOW",
      courierName: o.courier?.name ?? null,
      minutes,
    });
    await prisma.order.update({ where: { id: o.id }, data: { deliveryAlertLevel: 2 } });
  }
}

/**
 * ✅ ШИНЭ: Курьерийн илгээмжийг АВСНААС хойш курьерийн байршил ЗААВАЛ шинэчлэгдэж байх ёстой.
 * ERRAND_LOCATION_STALE_MINUTES (анхдагч 5 мин) шинэчлэгдээгүй бол Staff-д анхааруулж, курьерт
 * "байршлаа асаана уу" push явуулна. Асаахгүй бол REALERT (анхдагч 15 мин) тутам давтана.
 */
export async function checkErrandLocationLost() {
  const now = Date.now();
  const staleCutoff = new Date(now - ERRAND_LOCATION_STALE_MINUTES * 60_000);
  const realertCutoff = new Date(now - ERRAND_LOCATION_REALERT_MINUTES * 60_000);
  const orders = await prisma.order.findMany({
    where: {
      orderType: OrderType.COURIER_ERRAND,
      deliveryAssignStatus: DeliveryAssignStatus.PICKED_UP,
      courier: { OR: [{ currentLocationUpdatedAt: null }, { currentLocationUpdatedAt: { lt: staleCutoff } }] },
      AND: [{ OR: [{ locationAlertSentAt: null }, { locationAlertSentAt: { lt: realertCutoff } }] }],
    },
    include: { courier: { select: { id: true, name: true, currentLocationUpdatedAt: true } } },
  });

  for (const o of orders) {
    if (!o.courier) continue;
    const since = o.courier.currentLocationUpdatedAt ?? o.pickedUpAt ?? new Date(now);
    const minutes = Math.max(1, Math.round((now - since.getTime()) / 60_000));
    emitToStore(o.storeId, "delivery_stale_alert", {
      orderId: o.id,
      orderNumber: o.orderNumber,
      kind: "LOCATION_LOST",
      courierName: o.courier.name,
      minutes,
    });
    emitToCourier(o.courier.id, "location_required", { orderId: o.id, orderNumber: o.orderNumber });
    try {
      await sendPushToCourier(o.courier.id, "📍 Байршлаа асаана уу", `#${o.orderNumber} илгээмж таны гарт байна — байршил ${minutes} минут шинэчлэгдсэнгүй. Байршлаа асаана уу`, { orderId: o.id });
    } catch (err) {
      console.error("[watcher] Байршлын push илгээхэд алдаа:", err);
    }
    await prisma.order.update({ where: { id: o.id }, data: { locationAlertSentAt: new Date(now) } });
  }
}

/** Түрээсийн буцаах өдөр ойртсон (GIVEN) захиалгуудад курьерт сануулна. */
async function checkRentalReturnDue() {
  const horizon = new Date(Date.now() + RETURN_REMINDER_HOURS * 3_600_000);
  const orders = await prisma.order.findMany({
    where: {
      deliveryAssignStatus: DeliveryAssignStatus.GIVEN,
      returnReminderSent: false,
      courierId: { not: null },
      items: { some: { rentalDetail: { endDate: { lte: horizon } } } },
    },
    include: { items: { include: { rentalDetail: true } }, courier: { select: { name: true } } },
  });

  for (const o of orders) {
    const endDates = o.items.map((i) => i.rentalDetail?.endDate).filter((d): d is Date => d != null);
    if (endDates.length === 0 || !o.courierId) continue;
    const endDate = endDates.reduce((max, d) => (d > max ? d : max), endDates[0]);
    const endText = endDate.toISOString().slice(0, 10);

    try {
      await sendPushToCourier(o.courierId, "🔄 Түрээс буцаах өдөр ойртлоо", `#${o.orderNumber} — ${endText}-нд харилцагчаас буцаан авна`, {
        orderId: o.id,
      });
    } catch (err) {
      console.error("[watcher] Push илгээхэд алдаа:", err);
    }
    emitToCourier(o.courierId, "delivery_detail_updated", { orderId: o.id });
    emitToStore(o.storeId, "delivery_stale_alert", {
      orderId: o.id,
      orderNumber: o.orderNumber,
      kind: "RETURN_DUE",
      courierName: o.courier?.name ?? null,
      endDate: endText,
    });
    await prisma.order.update({ where: { id: o.id }, data: { returnReminderSent: true } });
  }
}

export async function runDeliveryWatcherOnce() {
  if (isRunning) return; // Өмнөх шалгалт дуусаагүй бол давхар ажиллуулахгүй
  isRunning = true;
  try {
    await checkNotPickedUp();
    await checkOnTheWaySlow();
    await checkErrandLocationLost(); // ✅ ШИНЭ
    await checkRentalReturnDue();
  } catch (err) {
    // DB түр холбогдохгүй байх зэрэг үед сервер унахгүй, дараагийн удаад дахин оролдоно
    console.error("[watcher] Хяналтын шалгалтад алдаа гарлаа:", err);
  } finally {
    isRunning = false;
  }
}

export function startDeliveryAlertWatcher() {
  const timer = setInterval(() => void runDeliveryWatcherOnce(), CHECK_INTERVAL_MS);
  timer.unref?.();
  void runDeliveryWatcherOnce();
  console.log(
    `[watcher] Хүргэлтийн хяналт эхэллээ (аваагүй: ${ASSIGNED_STALE_MINUTES} мин, замд: ${ON_THE_WAY_STALE_MINUTES} мин, түрээс: ${RETURN_REMINDER_HOURS} цаг)`
  );
}
