// ============================================================================
// ORDER URGENCY — Захиалгын "хэзээ хэрэгтэй" (neededByDate) огноо дээр
// суурилсан яаралтай тэмдэглэл, нэмэгдэл төлбөр, хугацаа хэтэрсэн (улаан)
// шалгалт. Зарах (SALE) захиалгад ЗААВАЛ асуугдана, түрээст (RENTAL)
// эхлэх огнооноос автоматаар тооцогдоно.
// ============================================================================

import { ULAANBAATAR_OFFSET_MS } from "./timezone";

export const URGENT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 цаг — ЭНГИЙН худалдах бараа

/** Яаралтайн босго (цаг): энгийн худалдах бараа 24, ТҮРЭЭС болон ТУСГАЙ ЗАХИАЛГА (бэлтгэх хугацаа шаардсан) 48. */
export const URGENT_HOURS_STANDARD = 24;
export const URGENT_HOURS_LONG_LEAD = 48;

/**
 * Сагсанд түрээс ЭСВЭЛ тусгай захиалга (isCustomizable / материалаар үнэлэгдэх / чимэглэлийн үйлчилгээ захиалсан)
 * байвал 48 цаг, зөвхөн энгийн худалдах бараа бол 24 цаг. Холимог сагсанд ХАМГИЙН УРТЫГ авна — тусгай
 * бараа бэлтгэх хугацаа шаардаж байгаа тул.
 */
export function urgentThresholdHoursFor(o: { hasRental: boolean; hasSpecial: boolean }): number {
  return o.hasRental || o.hasSpecial ? URGENT_HOURS_LONG_LEAD : URGENT_HOURS_STANDARD;
}

export class OrderUrgencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderUrgencyError";
  }
}

/**
 * Захиалгын "хэзээ хэрэгтэй" (neededByDate) огноог тодорхойлно.
 * - Түрээсийн мөр байвал: хамгийн эрт эхлэх огноог ашиглана (клиентийн
 *   илгээсэн утгыг ҮЛ ХАРГАЛЗАНА — түрээсийн огноо аль хэдийн найдвартай).
 * - Зөвхөн ЗАРАХ мөр байвал: клиентээс ЗААВАЛ ирсэн байх ёстой.
 */
export function resolveNeededByDate(input: { neededByDate?: string | Date | null }, hasRental: boolean, earliestRentalStart: Date | null): Date {
  if (hasRental) {
    if (!earliestRentalStart) throw new OrderUrgencyError("Түрээсийн эхлэх огноог тодорхойлж чадсангүй");
    return earliestRentalStart;
  }

  if (!input.neededByDate) {
    throw new OrderUrgencyError('"Хэзээ хэрэгтэй вэ?" огноог заавал сонгоно уу');
  }
  const date = input.neededByDate instanceof Date ? input.neededByDate : new Date(input.neededByDate);
  if (Number.isNaN(date.getTime())) {
    throw new OrderUrgencyError('"Хэзээ хэрэгтэй вэ?" огноог зөв оруулна уу');
  }
  return date;
}

/**
 * "Хэзээ хэрэгтэй вэ"-г ЗӨВХӨН ӨДРӨӨР (YYYY-MM-DD) авна — цаггүй. Сонгосон өдөр нь ЭЦСИЙН хугацаа тул тэр өдрийн
 * ТӨГСГӨЛ (23:59:59 Улаанбаатар)-ийг буцаана: эцсийн өдрөө "хугацаа хэтэрсэн" гэж улаанаар харагдахгүй, 24 цагийн
 * яаралтай нэмэгдэл зөвхөн ӨНӨӨДӨР хэрэгтэй үед ногдоно. Хуучин клиент/POS-ийн цагтай ISO утгыг хэвээр хүлээн авна.
 * Буруу огноо (2026-02-30) → Invalid Date.
 */
export function parseNeededByDate(raw: string | Date | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) return raw;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return new Date(NaN);
    return new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999) - ULAANBAATAR_OFFSET_MS);
  }
  return new Date(String(raw));
}

/** Харилцагч ӨНГӨРСӨН өдрийг сонгож чадахгүй (өнөөдөр болон түүнээс хойш л). */
export function assertNeededByNotPast(neededBy: Date, nowMs: number = Date.now()): void {
  const ub = new Date(nowMs + ULAANBAATAR_OFFSET_MS);
  const startOfToday = Date.UTC(ub.getUTCFullYear(), ub.getUTCMonth(), ub.getUTCDate()) - ULAANBAATAR_OFFSET_MS;
  if (neededBy.getTime() < startOfToday) {
    throw new OrderUrgencyError("Хэрэгтэй өдрөө өнөөдөр эсвэл дараагийн өдрүүдээс сонгоно уу");
  }
}

/** neededByDate одооноос босгын (анхдагч 24 цаг) дотор (эсвэл аль хэдийн өнгөрсөн) эсэх. */
export function computeIsUrgent(neededByDate: Date, now: Date = new Date(), thresholdMs: number = URGENT_THRESHOLD_MS): boolean {
  return neededByDate.getTime() - now.getTime() <= thresholdMs;
}

export interface FulfillmentCheckOrder {
  deliveryMethod: string;
  deliveryAssignStatus: string | null;
  items: Array<{ itemType: string; isIssued: boolean; rentalDetail?: { rentalStatus: string } | null }>;
}

/**
 * Захиалга АЛЬ ХЭДИЙН биелсэн (харилцагчид хүрсэн/олгосон/буцаагдсан) эсэх —
 * биелсэн бол хугацаа хэтэрсэн ч цаашид "улаан" анхааруулга шаардлагагүй.
 */
export function isOrderFulfilled(order: FulfillmentCheckOrder): boolean {
  if (order.deliveryMethod === "DELIVERY") {
    return order.deliveryAssignStatus === "DELIVERED";
  }
  const saleItems = order.items.filter((i) => i.itemType === "SALE");
  const rentalItems = order.items.filter((i) => i.itemType === "RENTAL");
  const allSaleIssued = saleItems.every((i) => i.isIssued);
  const allRentalDone = rentalItems.every((i) => !i.rentalDetail || i.rentalDetail.rentalStatus === "RETURNED" || i.rentalDetail.rentalStatus === "CANCELLED");
  return allSaleIssued && allRentalDone;
}

export interface OverdueCheckOrder extends FulfillmentCheckOrder {
  neededByDate: Date | null;
  paymentStatus: string;
}

/** Хугацаа (neededByDate) өнгөрсөн ч БИЕЛЭЭГҮЙ, ЦУЦЛАГДААГҮЙ захиалга — POS дээр улаанаар харуулна. */
export function isOrderOverdue(order: OverdueCheckOrder, now: Date = new Date()): boolean {
  if (!order.neededByDate) return false;
  if (order.paymentStatus === "CANCELLED") return false;
  if (order.neededByDate.getTime() > now.getTime()) return false;
  return !isOrderFulfilled(order);
}

/**
 * Захиалгыг цуцлахаас өмнө шалгана: хугацаа (neededByDate) 24 цагийн дотор
 * эсвэл аль хэдийн өнгөрсөн бол, Staff ЗААВАЛ баталгаажуулаагүй л бол
 * OrderUrgencyError шиднэ (POS дээр баталгаажуулах диалог гаргана).
 */
export function assertCancelAllowed(order: { neededByDate: Date | null; urgentThresholdHours?: number | null }, confirmed: boolean, now: Date = new Date()) {
  if (!order.neededByDate || confirmed) return;
  const msLeft = order.neededByDate.getTime() - now.getTime();
  // Захиалга үүсэх үед тогтоосон босгыг (24/48 цаг) ашиглана — яаралтай нэмэгдэлтэй яг ижил дүрэм
  const thresholdMs = (order.urgentThresholdHours && order.urgentThresholdHours > 0 ? order.urgentThresholdHours : URGENT_HOURS_STANDARD) * 3600000;
  if (msLeft <= thresholdMs) {
    throw new OrderUrgencyError("NEEDS_CONFIRMATION");
  }
}
