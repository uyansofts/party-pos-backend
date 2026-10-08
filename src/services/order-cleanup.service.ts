// ============================================================================
// ORDER CLEANUP SERVICE — Хугацаа хэтэрсэн PENDING онлайн захиалгуудыг
// автоматаар цуцалдаг (Хуурамч/орхигдсон захиалгаас цэвэрлэх).
// ----------------------------------------------------------------------------
// ⚠️ Тусдаа файлд байгаа шалтгаан: order.service.ts (cancelOrder агуулдаг)
// БОЛОН rental-availability.service.ts хоёулаа импортлодог тул, хэрэв
// энэ логикийг тэдгээрийн аль нэгэнд шууд бичвэл дугуй (circular) import
// үүсэх эрсдэлтэй. Иймд CONTROLLER-ууд л энэ файлыг дуудна.
// ============================================================================

import { prisma } from "../lib/prisma";
import { cancelOrder } from "./order.service";

const STALE_THRESHOLD_HOURS = 2;

/**
 * ONLINE + PENDING + STALE_THRESHOLD_HOURS-аас хуучин захиалгуудыг олж,
 * автоматаар цуцална (cancelOrder() ашигладаг тул холбогдох RentalDetail-
 * ийг ч CANCELLED болгож, боломжийг чөлөөлнө).
 * ----------------------------------------------------------------------------
 * "Санамсаргүй" throttle: сүүлд ажилласнаас хойш 60 секунд болоогүй бол
 * дахин ажиллахгүй (memory-д хадгална) — өндөр давтамжтай дуудагддаг
 * endpoint (check-availability гэх мэт) бүрт DB бүрэн scan хийхээс сэргийлнэ.
 */
let lastRunAt = 0;
const THROTTLE_MS = 60 * 1000;

export async function expireStaleOnlineOrders(): Promise<number> {
  const now = Date.now();
  if (now - lastRunAt < THROTTLE_MS) return 0;
  lastRunAt = now;

  const cutoff = new Date(now - STALE_THRESHOLD_HOURS * 60 * 60 * 1000);

  const staleOrders = await prisma.order.findMany({
    where: { orderType: "ONLINE", paymentStatus: "PENDING", createdAt: { lt: cutoff } },
    select: { id: true, orderNumber: true },
  });

  let cancelledCount = 0;
  for (const o of staleOrders) {
    try {
      await cancelOrder(o.id);
      cancelledCount++;
      console.log(`⏰ Хугацаа хэтэрсэн захиалга автоматаар цуцлагдлаа: #${o.orderNumber}`);
    } catch (err) {
      console.error(`Захиалга #${o.orderNumber} автоматаар цуцлахад алдаа гарлаа:`, err);
    }
  }

  return cancelledCount;
}
