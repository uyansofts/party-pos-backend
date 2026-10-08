// ============================================================================
// CUSTOMER TRACKING — Storefront-ын ЗАХИАЛГЫН ХЯНАЛТЫН хуудасны цэвэр логик (DB, сүлжээ хэрэггүй).
//
// Дизайны зарчим:
//  1. ХАНДАЛТ: захиалга бүрт гарын үсэгтэй токен (60 хоног). Токенгүй хүн юу ч харахгүй. Өөр төхөөрөмжөөс
//     "захиалгын дугаар + утас"-аар токеныг сэргээнэ (brute-force хамгаалалттай — AttemptLimiter).
//  2. НУУЦЛАЛ: харилцагчид ЗӨВХӨН ЗӨВШӨӨРСӨН талбарыг (allowlist) буцаана — staffId, courierId, курьерийн
//     жинхэнэ нэр/регистр/банк, бусад харилцагчийн мэдээлэл ХЭЗЭЭ Ч орохгүй. Курьер = nickname + машины дугаар + од.
//     Курьерийн утас ЗӨВХӨН хүргэлт идэвхтэй (хүргэгч оноогдсон/замд яваа) үед.
//  3. ТӨЛӨВ: захиалгын талбаруудаас "цаг хугацааны шугам"-ыг тооцно (deriveTimeline). Төлбөр хийгдээгүй бол
//     дараагийн алхмууд "хүлээгдэж байна" — харилцагчид эхлээд төлөхөө ойлгуулна.
// ============================================================================

import crypto from "crypto";
import { courierDisplayName, CourierStats } from "./courier-identity";
import { sellerStepLabel } from "./marketplace";
import { canEditReview, canReviewOrder } from "./reviews";

export class CustomerTrackingError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "CustomerTrackingError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Токен
// ---------------------------------------------------------------------------
export const CUSTOMER_TOKEN_TTL_DAYS = 60;

const b64u = (v: Uint8Array | string) => Buffer.from(v as any).toString("base64url");

function key(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET тохируулаагүй байна");
  return s + "|order-view"; // Нэвтрэлтийн JWT болон газрын зургийн токентой ИЖИЛ түлхүүр БИШ
}

export function signCustomerToken(orderId: string, ttlDays: number = CUSTOMER_TOKEN_TTL_DAYS, nowMs: number = Date.now()): string {
  const body = b64u(JSON.stringify({ t: "order-view", o: orderId, exp: Math.floor(nowMs / 1000) + Math.round(ttlDays * 86400) }));
  const sig = b64u(crypto.createHmac("sha256", key()).update(body).digest());
  return `${body}.${sig}`;
}

/** Зөв токеноос захиалгын id-г буцаана; буруу/хугацаа дууссан бол CustomerTrackingError(401). */
export function verifyCustomerToken(token: unknown, nowMs: number = Date.now()): string {
  const bad = () => new CustomerTrackingError("Холбоос буруу байна — захиалгын дугаар, утсаараа дахин хайна уу", 401);
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad();
  const expected = crypto.createHmac("sha256", key()).update(parts[0]).digest();
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw bad();
  let payload: { t?: string; o?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (payload.t !== "order-view" || typeof payload.o !== "string" || !payload.o) throw bad();
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
    throw new CustomerTrackingError("Холбоосын хугацаа дууссан — захиалгын дугаар, утсаараа дахин хайна уу", 401);
  }
  return payload.o;
}

// ---------------------------------------------------------------------------
// Storefront-ын холбоос (POS-оос харилцагчид илгээх)
// ---------------------------------------------------------------------------
/**
 * STOREFRONT_BASE_URL-ээс харилцагчийн хяналтын холбоосыг бүтээнэ. Буруу тохиргоог (жишээ нь "https//..." эсвэл
 * компьютерийн файлын зам) чимээгүй хугацаа алдсан холбоос болгохгүй — тодорхой зөвлөмж (hint) буцаана.
 * Хаяг .html-ээр төгссөн бол "?track=", үгүй бол "/?track=" залгана.
 */
export function buildStorefrontLink(baseRaw: string | undefined, token: string): { url: string | null; hint: string | null } {
  const base = (baseRaw ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    return { url: null, hint: "Backend-ийн .env файлд STOREFRONT_BASE_URL (storefront-ын хаяг, жишээ нь https://diyparty.netlify.app) тохируулаад backend-ээ дахин асаана уу." };
  }
  if (!/^(https?|file):\/\/\S+$/i.test(base)) {
    return { url: null, hint: `STOREFRONT_BASE_URL буруу байна ("${base.slice(0, 80)}"). https:// (эсвэл local туршилтад file:///) гэж эхэлсэн бүтэн хаяг байх ёстой, жишээ нь https://diyparty.netlify.app` };
  }
  const sep = /\.html?$/i.test(base) ? "?track=" : "/?track=";
  return { url: `${base}${sep}${token}`, hint: null };
}

// ---------------------------------------------------------------------------
// Захиалгын дугаар + утсаар хайх
// ---------------------------------------------------------------------------
/** Сүүлийн 8 орон таарвал ижил (+976, зай, зураас үл тооно). */
export function phonesMatch(stored: unknown, input: unknown): boolean {
  const digits = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "");
  const a = digits(stored);
  const b = digits(input);
  if (a.length < 8 || b.length < 8) return false;
  return a.slice(-8) === b.slice(-8);
}

export function normalizeOrderNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase().replace(/\s+/g, "");
  return v.length >= 3 && v.length <= 40 && /^[A-Z0-9-]+$/.test(v) ? v : null;
}

/** Нэг захиалгын дугаарт утсаар таах оролдлогыг хязгаарлана: 15 минутад 5 удаа буруу → түр түгжинэ. */
export class AttemptLimiter {
  private fails = new Map<string, number[]>();
  constructor(private maxFails = 5, private windowMs = 15 * 60_000, private now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const arr = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length > 0) this.fails.set(key, arr);
    else this.fails.delete(key);
    return arr;
  }

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const arr = this.recent(key);
    if (arr.length >= this.maxFails) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + this.windowMs - this.now()) / 1000)) };
    return { allowed: true, retryAfterSec: 0 };
  }

  fail(key: string): void {
    const arr = this.recent(key);
    arr.push(this.now());
    this.fails.set(key, arr);
    if (this.fails.size > 5000) for (const k of Array.from(this.fails.keys())) this.recent(k); // санах ой цэвэрлэнэ
  }

  success(key: string): void {
    this.fails.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Цаг хугацааны шугам
// ---------------------------------------------------------------------------
const METHOD_LABELS: Record<string, string> = {
  PICKUP: "Дэлгүүрээс өөрөө очиж авна",
  DELIVERY: "Манай унаагаар хүргэнэ",
  POST: "Монгол шуудангаар илгээнэ",
  LOCAL_TRANSPORT: "Орон нутгийн унаагаар илгээнэ",
  UB_CAB: "UB Cab-аар очиж авна",
};

export interface TimelineStep {
  key: string;
  label: string;
  state: "done" | "current" | "pending" | "cancelled";
  at: string | null;
}

export interface Timeline {
  statusLabel: string;
  tone: "info" | "success" | "warn" | "danger";
  finished: boolean;
  steps: TimelineStep[];
}

export interface TimelineInput {
  deliveryMethod: string;
  paymentStatus: string;
  deliveryAssignStatus: string;
  cancelled: boolean;
  allIssued: boolean;
  hasRental: boolean;
  allReturned: boolean;
  courierName?: string | null;
  sellerStatus?: string | null; // ✅ ШИНЭ (marketplace) — худалдагчийн захиалгын төлөв
  rentalEnd?: Date | string | null;
  createdAt: Date | string;
  pickedUpAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  rentalGivenAt?: Date | string | null;
  cancelledAt?: Date | string | null;
}

const iso = (d?: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const dateOnly = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

export function deriveTimeline(i: TimelineInput): Timeline {
  const placed: TimelineStep = { key: "placed", label: "Захиалга бүртгэгдсэн", state: "done", at: iso(i.createdAt) };
  if (i.cancelled) {
    return {
      statusLabel: "Цуцлагдсан",
      tone: "danger",
      finished: true,
      steps: [placed, { key: "cancelled", label: "Захиалга цуцлагдсан", state: "cancelled", at: iso(i.cancelledAt) }],
    };
  }

  const st = i.deliveryAssignStatus;
  const paid = i.paymentStatus === "PAID";
  const raw: Array<{ key: string; label: string; done: boolean; at: string | null }> = [
    { key: "payment", label: paid ? "Төлбөр баталгаажсан" : "Төлбөр хүлээгдэж байна", done: paid, at: null },
  ];

  if (i.deliveryMethod === "DELIVERY") {
    const found = ["ASSIGNED", "PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED"].includes(st);
    const onWay = ["PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED"].includes(st);
    const delivered = st === "DELIVERED" || (i.hasRental && ["GIVEN", "RETURN_PICKED_UP"].includes(st));
    // ✅ ШИНЭ (marketplace): Худалдагчийн захиалгад "худалдагч баталгаажуулж/бэлтгэж байна" алхам нэмэгдэнэ
    if (i.sellerStatus) {
      const sellerDone = i.sellerStatus === "READY" || found;
      raw.push({ key: "seller", label: sellerDone ? "Худалдагч бэлэн болгосон" : sellerStepLabel(i.sellerStatus), done: sellerDone, at: null });
    }
    raw.push({ key: "courier", label: found ? (i.courierName ? `Хүргэгч оноогдсон — ${i.courierName}` : "Хүргэгч оноогдсон") : "Хүргэгч хайж байна", done: found, at: null });
    raw.push({ key: "onway", label: onWay ? "Хүргэлтэд гарсан" : "Хүргэлтэд гарна", done: onWay, at: iso(i.pickedUpAt) });
    raw.push({ key: "delivered", label: delivered ? (i.hasRental ? "Түрээсийн бараа хүргэгдсэн" : "Хүргэгдсэн") : "Хүргэгдэнэ", done: delivered, at: iso(i.hasRental ? i.rentalGivenAt : i.deliveredAt) });
  } else if (i.deliveryMethod === "POST" || i.deliveryMethod === "LOCAL_TRANSPORT") {
    raw.push({ key: "shipped", label: i.allIssued ? "Илгээсэн" : "Бэлтгэж байна — удахгүй илгээнэ", done: i.allIssued, at: null });
  } else {
    raw.push({ key: "collected", label: i.allIssued ? "Дэлгүүрээс авсан" : "Бэлтгэж байна — очиж авч болно", done: i.allIssued, at: null });
  }

  if (i.hasRental) {
    const returned = i.allReturned || (i.deliveryMethod === "DELIVERY" && st === "DELIVERED");
    raw.push({
      key: "return",
      label: returned ? "Түрээс буцаагдсан" : `Түрээс буцаах${i.rentalEnd ? ` (${dateOnly(i.rentalEnd)} хүртэл)` : ""}`,
      done: returned,
      at: null,
    });
  }

  // "Дараалсан" дүрэм: эхний дуусаагүй алхам = одоогийн, түүнээс хойших бүгд хүлээгдэж байгаа
  // (жишээ нь төлбөр хийгдээгүй бол бусад алхам "хүлээгдэж байна" гэж харагдана).
  let currentFound = false;
  const steps: TimelineStep[] = [placed];
  for (const r of raw) {
    let state: TimelineStep["state"];
    if (!currentFound && r.done) state = "done";
    else if (!currentFound) {
      state = "current";
      currentFound = true;
    } else state = "pending";
    steps.push({ key: r.key, label: r.label, state, at: state === "done" ? r.at : null });
  }

  // Одоогийн ТӨЛӨВИЙН шошго: "дараагийн алхам" биш, ЯГ ОДОО юу болж байгааг тодорхой дүрмээр гаргана
  // (жишээ нь замд яваа бараа "Хүргэгдсэн" гэж харагдах ёсгүй).
  const returned = i.allReturned || (i.deliveryMethod === "DELIVERY" && st === "DELIVERED");
  let statusLabel: string;
  let finished: boolean;
  if (!paid) {
    statusLabel = "Төлбөр хүлээгдэж байна";
    finished = false;
  } else if (i.deliveryMethod === "DELIVERY") {
    finished = i.hasRental ? returned : st === "DELIVERED";
    if (st === "DELIVERED") statusLabel = i.hasRental ? "Түрээс буцаагдсан" : "Хүргэгдсэн";
    else if (st === "RETURN_PICKED_UP") statusLabel = "Түрээсийг буцааж авлаа";
    else if (st === "GIVEN") statusLabel = "Түрээсийн бараа хүргэгдсэн";
    else if (st === "PICKED_UP") statusLabel = "Хүргэлтэд гарсан";
    else if (st === "ASSIGNED") statusLabel = i.courierName ? `Хүргэгч оноогдсон — ${i.courierName}` : "Хүргэгч оноогдсон";
    else if (i.sellerStatus === "AWAITING_SELLER" || i.sellerStatus === "ACCEPTED") statusLabel = sellerStepLabel(i.sellerStatus); // ✅ ШИНЭ — худалдагч бэлэн болгоогүй
    else statusLabel = "Хүргэгч хайж байна";
  } else if (i.deliveryMethod === "POST" || i.deliveryMethod === "LOCAL_TRANSPORT") {
    finished = i.allIssued && (!i.hasRental || returned);
    statusLabel = !i.allIssued ? "Бэлтгэж байна" : i.hasRental && !returned ? "Илгээсэн — түрээс буцаах хугацаа хүлээгдэж байна" : "Илгээсэн";
  } else {
    finished = i.allIssued && (!i.hasRental || returned);
    statusLabel = !i.allIssued ? "Бэлтгэж байна — очиж авч болно" : i.hasRental && !returned ? "Түрээслэж авсан — буцаах хугацаа хүлээгдэж байна" : "Дэлгүүрээс авсан";
  }
  return { statusLabel, tone: finished ? "success" : !paid ? "warn" : "info", finished, steps };
}

// ---------------------------------------------------------------------------
// Харилцагчид харагдах ЗӨВШӨӨРСӨН талбарууд (allowlist)
// ---------------------------------------------------------------------------
export interface TrackingOrderInput {
  id: string;
  orderNumber: string;
  createdAt: Date | string;
  totalAmount: unknown;
  paidAmount: unknown;
  paymentStatus: string;
  deliveryMethod: string;
  deliveryAddress: string | null;
  deliveryFee: unknown;
  neededByDate: Date | string | null;
  deliveryAssignStatus: string;
  deliveryOtp: string | null;
  returnOtp: string | null;
  pickedUpAt: Date | string | null;
  deliveredAt: Date | string | null;
  rentalGivenAt: Date | string | null;
  cancelledAt: Date | string | null;
  items: Array<{
    productId?: string | null;
    quantity: number;
    itemType: string;
    subtotal: unknown;
    isIssued: boolean;
    materialNameSnapshot?: string | null;
    customFieldValues?: unknown;
    product?: { name: string } | null;
    rentalDetail?: {
      id: string;
      startDate: Date | string;
      endDate: Date | string;
      depositAmount: unknown;
      depositStatus: string;
      rentalStatus: string;
    } | null;
  }>;
  courier?: { name: string; nickname?: string | null; vehiclePlate?: string | null; phone?: string | null } | null;
  rating?: { stars: number } | null;
  /** ✅ ШИНЭ: Энэ захиалгад хэдийнэ өгсөн барааны үнэлгээнүүд */
  reviews?: Array<{ productId: string; stars: number; comment: string | null; createdAt: Date | string }>;
  // ✅ ШИНЭ (marketplace)
  sellerStatus?: string | null;
  seller?: { name: string } | null;
  cancelReason?: string | null;
  /** Нэг сагсны (нэг төлбөрийн) бүлэг: нийт дүн, төлсөн дүн, төлбөр хийх захиалгын id, бусад захиалгууд */
  group?: { total: number; paid: number; payOrderId: string; siblings: Array<{ orderNumber: string; sellerName: string | null; token: string }> } | null;
}

const COURIER_ACTIVE = ["ASSIGNED", "PICKED_UP"]; // Курьерийн утас ЗӨВХӨН энэ үед харагдана
const RATABLE = ["GIVEN", "RETURN_PICKED_UP", "DELIVERED"];

function itemDetails(it: TrackingOrderInput["items"][number]): string[] {
  const out: string[] = [];
  if (it.materialNameSnapshot) out.push(`Материал: ${it.materialNameSnapshot}`);
  if (Array.isArray(it.customFieldValues)) {
    for (const f of it.customFieldValues as any[]) {
      const label = typeof f?.label === "string" ? f.label : null;
      const value = f?.value;
      if (label && value !== undefined && value !== null && String(value).trim() !== "") {
        out.push(`${label}: ${String(value)}${typeof f?.unit === "string" && f.unit ? " " + f.unit : ""}`);
      }
    }
  }
  return out;
}

export function buildCustomerTrackingView(o: TrackingOrderInput, stats?: CourierStats) {
  const cancelled = !!o.cancelledAt || o.paymentStatus === "CANCELLED" || o.paymentStatus === "REFUNDED" || o.sellerStatus === "REJECTED" || o.sellerStatus === "EXPIRED";
  const rentals = o.items.filter((i) => i.itemType === "RENTAL" && i.rentalDetail).map((i) => i.rentalDetail!);
  const hasRental = rentals.length > 0;
  const allIssued = o.items.length > 0 && o.items.every((i) => i.isIssued);
  const allReturned = hasRental && rentals.every((r) => r.rentalStatus === "RETURNED");
  const rentalEnd = hasRental ? rentals.map((r) => new Date(r.endDate).getTime()).reduce((a, b) => Math.max(a, b)) : null;
  const st = o.deliveryAssignStatus;
  const courierName = o.courier ? courierDisplayName(o.courier) : null;

  const timeline = deriveTimeline({
    deliveryMethod: o.deliveryMethod,
    paymentStatus: o.paymentStatus,
    deliveryAssignStatus: st,
    cancelled,
    allIssued,
    hasRental,
    allReturned,
    courierName,
    sellerStatus: o.sellerStatus ?? null,
    rentalEnd: rentalEnd ? new Date(rentalEnd) : null,
    createdAt: o.createdAt,
    pickedUpAt: o.pickedUpAt,
    deliveredAt: o.deliveredAt,
    rentalGivenAt: o.rentalGivenAt,
    cancelledAt: o.cancelledAt,
  });

  // ✅ ШИНЭ: Бүлгийн (нэг сагсны) захиалгад төлбөр НИЙТ дүнгээр — харилцагч нэг л төлбөр хийнэ
  const total = o.group ? o.group.total : Number(o.totalAmount);
  const paid = o.group ? o.group.paid : Number(o.paidAmount);
  const remaining = Math.max(0, total - paid);
  const isDelivery = o.deliveryMethod === "DELIVERY";
  const returned = allReturned || (isDelivery && st === "DELIVERED");

  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    createdAt: iso(o.createdAt),
    statusLabel: timeline.statusLabel,
    tone: timeline.tone,
    finished: timeline.finished,
    cancelled,
    cancelReason: o.cancelReason ?? null,
    seller: o.seller ? { name: o.seller.name } : null, // Худалдагчийн НИЙТИЙН нэр л (утас, хаяг, комисс ГАРАХГҮЙ)
    siblings: o.group ? o.group.siblings : [], // Нэг сагсны бусад захиалгууд (нэр, холбоос)
    steps: timeline.steps,
    payment: {
      status: o.paymentStatus,
      total,
      paid,
      remaining,
      canPay: !cancelled && remaining > 0 && (o.group ? true : o.paymentStatus !== "PAID"),
      payOrderId: o.group ? o.group.payOrderId : o.id, // Бүлгийн төлбөрийг ҮНДСЭН захиалгаар хийнэ
    },
    items: o.items.map((i) => {
      const rev = i.productId ? (o.reviews ?? []).find((r) => r.productId === i.productId) : undefined;
      return {
      productId: i.productId ?? null, // ✅ ШИНЭ — барааг үнэлэхэд
      // Бараагаа хүлээн авсан (төлсөн, цуцлагдаагүй, хүргэгдсэн) бол үнэлж болно
      canReview: !!i.productId && !cancelled && canReviewOrder(o as any),
      review: rev ? { stars: rev.stars, comment: rev.comment ?? null, canEdit: canEditReview(rev.createdAt) } : null,
      name: i.product?.name ?? "Бараа",
      quantity: i.quantity,
      itemType: i.itemType,
      subtotal: Number(i.subtotal),
      isIssued: !!i.isIssued,
      details: itemDetails(i),
      rental: i.rentalDetail
        ? { startDate: iso(i.rentalDetail.startDate), endDate: iso(i.rentalDetail.endDate), depositAmount: Number(i.rentalDetail.depositAmount), depositStatus: i.rentalDetail.depositStatus, rentalStatus: i.rentalDetail.rentalStatus }
        : null,
      };
    }),
    // Барьцаа төлөх (PENDING) мөрүүд — төлбөрийн урсгалд барааны үнэтэй хамт авна
    deposits: o.items
      .filter((i) => i.itemType === "RENTAL" && i.rentalDetail && i.rentalDetail.depositStatus === "PENDING" && Number(i.rentalDetail.depositAmount) > 0)
      .map((i) => ({ rentalDetailId: i.rentalDetail!.id, productName: i.product?.name ?? "Түрээс", amount: Number(i.rentalDetail!.depositAmount) })),
    delivery: {
      method: o.deliveryMethod,
      methodLabel: METHOD_LABELS[o.deliveryMethod] ?? o.deliveryMethod,
      address: o.deliveryMethod === "PICKUP" || o.deliveryMethod === "UB_CAB" ? null : o.deliveryAddress,
      fee: Number(o.deliveryFee),
      neededBy: iso(o.neededByDate),
      pickupLabel: o.deliveryMethod === "PICKUP" || o.deliveryMethod === "UB_CAB" ? "Дэлгүүр" : null,
    },
    // Хүргэгчид өгөх КОДУУД — харилцагч хэзээ ч алдахгүй (өмнө нь зөвхөн нэг удаагийн alert байсан)
    codes: {
      deliveryOtp: isDelivery && !cancelled && st !== "DELIVERED" && !(hasRental && RATABLE.includes(st)) ? o.deliveryOtp : null,
      returnOtp: hasRental && isDelivery && !cancelled && !returned ? o.returnOtp : null,
    },
    courier:
      o.courier && isDelivery && ["ASSIGNED", "PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED"].includes(st)
        ? {
            displayName: courierName,
            vehiclePlate: o.courier.vehiclePlate ?? null,
            ratingAverage: stats?.ratingAverage ?? null,
            ratingCount: stats?.ratingCount ?? 0,
            completedDeliveries: stats?.completedDeliveries ?? 0,
            phone: COURIER_ACTIVE.includes(st) ? o.courier.phone ?? null : null,
          }
        : null,
    map: { available: !!o.courier && isDelivery && ["ASSIGNED", "PICKED_UP", "RETURN_PICKED_UP"].includes(st) && !cancelled, url: null as string | null },
    rating: {
      myStars: o.rating?.stars ?? null,
      canRate: !!o.courier && isDelivery && RATABLE.includes(st) && !o.rating && !cancelled,
    },
    actions: { canCancel: !cancelled && o.paymentStatus !== "PAID" && ["UNASSIGNED", "OFFERED"].includes(st) },
  };
}

export type CustomerTrackingView = ReturnType<typeof buildCustomerTrackingView>;
