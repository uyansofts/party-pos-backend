// ============================================================================
// FEATURED SERVICE — Төлбөртэй ОНЦЛОХ байрлал (хязгаартай, огноотой).
//   Хүсэлт (REQUESTED) → Staff ЗӨВШӨӨРНӨ: байрлалыг НӨӨЦӨЛНӨ (APPROVED, holdUntil хүртэл) →
//   худалдагч QPay-ээр төлнө (автомат) ЭСВЭЛ данс руу шилжүүлээд "шилжүүлсэн" гэж мэдэгдэнэ (Staff шалгана) → ACTIVE
//   Хугацаандаа төлөөгүй бол байрлал чөлөөлөгдөнө (LAPSED). Хоцорч орсон төлбөрийг байрлал сул бол идэвхжүүлнэ, үгүй бол БУЦААХ ёстой гэж тэмдэглэнэ.
//   Бүх шилжилт атомик (updateMany + төлөвийн нөхцөл), зөвшөөрөл/идэвхжүүлэлт нь lock-той (лимитээс хэтрүүлэхгүй).
// ============================================================================

import { prisma } from "../lib/prisma";
import { createGatewayInvoice, getPaymentGateway } from "./invoice.service";
import {
  AWAITING_APPROVAL, DAY_MS, FeaturedError, MAX_OPEN_PER_SELLER, MAX_LEAD_DAYS, MIN_LEAD_DAYS, OPEN_STATUSES, REPORTED_HOLD_HOURS, REQUEST_TTL_DAYS,
  daysLeft, effectiveStatus, generateReferenceCode, isFeaturedNow, isStaffForeverFeatured, lastDayKey, normalizeHoldMinutes, normalizeSlotLimit, ubKey, ubMidnightMs,
  validatePackageInput, validatePaymentMethod, validateStartDate, windowFor,
} from "../lib/featured";
import { buildCalendar, checkCapacity, nextAvailableStart, productOverlaps, type Booking } from "../lib/featured-slots";

const LOCK_KEY = 7712001; // зөвшөөрөл/идэвхжүүлэлтийг цуваа болгох advisory lock
const num = (v: unknown) => Number(v ?? 0);
const OCCUPYING = ["APPROVED", "PAYMENT_REPORTED", "ACTIVE"];

async function lock(tx: any) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
}

// ----------------------------- Тохиргоо -----------------------------

export async function getSlotSettings(client: any = prisma) {
  const s: any = await client.shopSettings.findUnique({ where: { id: "default" } });
  return { limit: normalizeSlotLimit(s?.featuredSlotLimit), holdMinutes: normalizeHoldMinutes(s?.featuredHoldMinutes) };
}

export async function getPromoPaymentInfo(): Promise<string | null> {
  const s: any = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const t = typeof s?.promoPaymentInfo === "string" ? s.promoPaymentInfo.trim() : "";
  return t || null;
}

// ----------------------------- Багц (Staff) -----------------------------

const packageView = (p: any) => ({ id: p.id, name: p.name, durationDays: p.durationDays, price: num(p.price), isActive: !!p.isActive, sortOrder: p.sortOrder ?? 0 });

export async function listPackages(onlyActive = false) {
  const rows: any[] = await prisma.featuredPackage.findMany({ where: onlyActive ? { isActive: true } : {}, orderBy: [{ sortOrder: "asc" }, { durationDays: "asc" }] } as any);
  return rows.map(packageView);
}

export async function createPackage(body: unknown) {
  const v = validatePackageInput(body, false);
  const created: any = await prisma.featuredPackage.create({ data: { name: v.name!, durationDays: v.durationDays!, price: v.price!, isActive: v.isActive ?? true, sortOrder: v.sortOrder ?? 0 } });
  return packageView(created);
}

export async function updatePackage(id: string, body: unknown) {
  const v = validatePackageInput(body, true);
  const r = await prisma.featuredPackage.updateMany({ where: { id }, data: v as any });
  if (r.count === 0) throw new FeaturedError("Багц олдсонгүй", 404);
  return packageView(await prisma.featuredPackage.findUnique({ where: { id } }));
}

/** Зар үүсгэж байсан багцыг устгахгүй (түүх алдагдана) — идэвхгүй болгохыг зөвлөнө. */
export async function deletePackage(id: string) {
  const used = await prisma.featuredPromotion.count({ where: { packageId: id } });
  if (used > 0) throw new FeaturedError(`Энэ багцаар ${used} зар үүссэн тул устгах боломжгүй — "идэвхгүй" болгоно уу`, 409);
  const r = await prisma.featuredPackage.deleteMany({ where: { id } });
  if (r.count === 0) throw new FeaturedError("Багц олдсонгүй", 404);
  return { deleted: true };
}

// ------------------------- Байрлалын хуанли / лимит -------------------------

async function loadBookings(client: any, fromMs: number, days: number): Promise<Booking[]> {
  const rows: any[] = await client.featuredPromotion.findMany({
    where: { status: { in: OCCUPYING }, startsAt: { lt: new Date(fromMs + days * DAY_MS) }, endsAt: { gt: new Date(fromMs) } },
    select: { id: true, productId: true, startsAt: true, endsAt: true, status: true, holdUntil: true },
  });
  return rows as Booking[];
}

const staffForeverCount = (client: any): Promise<number> => client.product.count({ where: { isFeatured: true, featuredUntil: null, isActive: true } });

async function capacityFor(client: any, o: { startsAt: Date; days: number; productId: string; exceptId?: string; now: Date }) {
  const { limit } = await getSlotSettings(client);
  const baseline = await staffForeverCount(client);
  const startMs = o.startsAt.getTime();
  const bookings = await loadBookings(client, startMs, o.days + 60);
  const cap = checkCapacity(bookings, startMs, o.days, limit, o.now, baseline, o.exceptId);
  const overlap = productOverlaps(bookings, o.productId, startMs, startMs + o.days * DAY_MS, o.now, o.exceptId);
  const next = cap.ok ? null : nextAvailableStart(bookings, startMs, o.days, limit, o.now, baseline, 60, o.exceptId);
  return { ok: cap.ok && !overlap, overlap, fullDays: cap.fullDays, limit, next };
}

function noCapacity(c: { overlap: boolean; fullDays: string[]; limit: number; next: Date | null }): FeaturedError {
  if (c.overlap) return new FeaturedError("Энэ бараа тэр хугацаанд аль хэдийн онцлогдсон эсвэл нөөцлөгдсөн байна", 409);
  const next = c.next ? ` Хамгийн ойрын сул огноо: ${ubKey(c.next.getTime())}.` : " 60 хоногт сул огноо олдсонгүй.";
  return new FeaturedError(`${c.fullDays[0]} өдөр онцлох байрлал дүүрсэн (${c.limit}/${c.limit}).${next}`, 409);
}

/** Staff-ийн хуанли: өдөр бүрийн эзэлсэн/лимит, тэр өдөр байрлал эзэлж буй зарууд. */
export async function getCalendar(fromKey?: string, daysRaw?: number, now: Date = new Date()) {
  const days = Number.isInteger(daysRaw) && daysRaw! >= 7 && daysRaw! <= 62 ? daysRaw! : 30;
  const fromMs = typeof fromKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fromKey) ? Date.parse(fromKey + "T00:00:00Z") - 8 * 3600_000 : ubMidnightMs(now.getTime());
  const { limit, holdMinutes } = await getSlotSettings();
  const baseline = await staffForeverCount(prisma);
  const rows: any[] = await prisma.featuredPromotion.findMany({
    where: { status: { in: OCCUPYING }, startsAt: { lt: new Date(fromMs + days * DAY_MS) }, endsAt: { gt: new Date(fromMs) } },
    include: { product: { select: { name: true } }, seller: { select: { name: true } } },
  } as any);
  const cal = buildCalendar(rows as Booking[], fromMs, days, limit, now, baseline);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    limit, holdMinutes, staffForever: baseline,
    days: cal.map((d) => ({
      date: d.date, used: d.used, limit: d.limit, free: d.free,
      items: d.bookingIds.map((id) => { const r = byId.get(id); return { id, productName: r?.product?.name ?? "", sellerName: r?.seller?.name ?? "", status: effectiveStatus(r, now), startsAt: r?.startsAt, endsAt: r?.endsAt }; }),
    })),
  };
}

// ------------------------- Худалдагчийн талаас -------------------------

const sellerView = (p: any, now: Date) => {
  const st = effectiveStatus(p, now);
  const holding = st === "APPROVED" || st === "PAYMENT_REPORTED";
  return {
    id: p.id, referenceCode: p.referenceCode, productId: p.productId, productName: p.product?.name ?? "", packageName: p.packageName, durationDays: p.durationDays,
    amount: num(p.amount), status: st, requestedStart: p.requestedStart ?? null, startsAt: p.startsAt ?? null, endsAt: p.endsAt ?? null,
    lastDay: p.endsAt ? lastDayKey(p.endsAt) : null, holdUntil: holding ? p.holdUntil ?? null : null,
    daysLeft: st === "ACTIVE" ? daysLeft(p.endsAt, now) : 0, scheduled: st === "ACTIVE" && !!p.startsAt && new Date(p.startsAt).getTime() > now.getTime(),
    rejectReason: st === "REJECTED" ? p.rejectReason ?? null : null, refundDue: num(p.refundDueAmount) > 0 && !p.refundedAt, createdAt: p.createdAt,
  };
};

export async function getSellerFeatured(sellerId: string, now: Date = new Date()) {
  const rows: any[] = await prisma.featuredPromotion.findMany({ where: { sellerId }, orderBy: { createdAt: "desc" }, take: 100, include: { product: { select: { name: true } } } } as any);
  const { holdMinutes } = await getSlotSettings();
  const today = ubMidnightMs(now.getTime());
  return {
    packages: await listPackages(true), paymentInfo: await getPromoPaymentInfo(), holdMinutes,
    minStartDate: ubKey(today + MIN_LEAD_DAYS * DAY_MS), maxStartDate: ubKey(today + MAX_LEAD_DAYS * DAY_MS),
    promotions: rows.map((r) => sellerView(r, now)),
  };
}

/** Худалдагч бараагаа онцлох ХҮСЭЛТ илгээнэ (төлбөргүй, байрлал нөөцлөхгүй). Staff зөвшөөрсний дараа төлнө. */
export async function requestPromotion(sellerId: string, body: unknown, now: Date = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const productId = typeof b.productId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.productId) ? b.productId : null;
  const packageId = typeof b.packageId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.packageId) ? b.packageId : null;
  if (!productId || !packageId) throw new FeaturedError("Бараа болон багцаа сонгоно уу");
  const start = validateStartDate(b.startDate, now);

  const product: any = await prisma.product.findFirst({ where: { id: productId, sellerId } });
  if (!product) throw new FeaturedError("Бараа олдсонгүй", 404);
  if (!product.isActive) throw new FeaturedError("Нуусан барааг онцлох боломжгүй — эхлээд харуулна уу");
  if (product.staffLocked) throw new FeaturedError("Дэлгүүр энэ барааг түр нууцалсан тул онцлох боломжгүй", 403);
  if (isStaffForeverFeatured(product)) throw new FeaturedError("Энэ бараа аль хэдийн хугацаагүй онцлох байна (дэлгүүр сонгосон)", 409);
  const pkg: any = await prisma.featuredPackage.findUnique({ where: { id: packageId } });
  if (!pkg || !pkg.isActive) throw new FeaturedError("Багц олдсонгүй эсвэл идэвхгүй байна", 404);

  const existing: any = await prisma.featuredPromotion.findFirst({ where: { productId, sellerId, status: { in: OPEN_STATUSES } as any }, include: { product: { select: { name: true } } } } as any);
  if (existing) {
    if (existing.packageId === packageId && existing.requestedStart && new Date(existing.requestedStart).getTime() === start.getTime() && effectiveStatus(existing, now) === "REQUESTED") return sellerView(existing, now); // давхар дарсан
    throw new FeaturedError("Энэ барааны онцлох хүсэлт хүлээгдэж байна — эхлээд түүнийг цуцлах эсвэл дуусгана уу", 409);
  }
  const open = await prisma.featuredPromotion.count({ where: { sellerId, status: { in: OPEN_STATUSES } as any } });
  if (open >= MAX_OPEN_PER_SELLER) throw new FeaturedError(`Хүлээгдэж буй онцлох хүсэлт ${MAX_OPEN_PER_SELLER} хүрсэн байна`, 429);

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const created: any = await prisma.featuredPromotion.create({
        data: { referenceCode: generateReferenceCode(), sellerId, productId, packageId, packageName: pkg.name, durationDays: pkg.durationDays, amount: pkg.price, status: "REQUESTED" as any, requestedStart: start },
        include: { product: { select: { name: true } } },
      } as any);
      return sellerView(created, now);
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
    }
  }
  throw new FeaturedError("Лавлах код үүсгэж чадсангүй — дахин оролдоно уу", 500);
}

/** Худалдагч төлөхөөс өмнө цуцална. "Шилжүүлсэн" гэж мэдэгдсэн бол цуцлахгүй (мөнгө явсан байж болно). */
export async function cancelOwnPromotion(sellerId: string, id: string) {
  const r = await prisma.featuredPromotion.updateMany({ where: { id, sellerId, status: { in: ["REQUESTED", "PENDING_PAYMENT", "APPROVED"] } as any }, data: { status: "CANCELLED" as any, cancelReason: "Худалдагч цуцалсан", holdUntil: null } });
  if (r.count === 0) {
    const e = await prisma.featuredPromotion.findFirst({ where: { id, sellerId } });
    if (!e) throw new FeaturedError("Зар олдсонгүй", 404);
    throw new FeaturedError(e.status === "PAYMENT_REPORTED" ? "Төлбөр шилжүүлснээ мэдэгдсэн тул цуцлах боломжгүй — дэлгүүртэй холбогдоно уу" : "Энэ зарыг цуцлах боломжгүй төлөвт байна", 409);
  }
  return { id, status: "CANCELLED" };
}

async function loadOwn(sellerId: string, id: string): Promise<any> {
  const p: any = await prisma.featuredPromotion.findFirst({ where: { id, sellerId }, include: { product: { select: { name: true } } } } as any);
  if (!p) throw new FeaturedError("Зар олдсонгүй", 404);
  return p;
}

/** Зөвшөөрөгдсөн зарыг QPay (эсвэл SocialPay)-ээр төлөх invoice. Нөөцлөлт үргэлжилж байх үед л. Нэг зарт нэг идэвхтэй invoice. */
export async function startGatewayPayment(sellerId: string, id: string, providerRaw: unknown, now: Date = new Date()) {
  const provider = providerRaw === "SOCIALPAY" ? "SOCIALPAY" : "QPAY";
  const p = await loadOwn(sellerId, id);
  if (effectiveStatus(p, now) !== "APPROVED") throw new FeaturedError(p.status === "ACTIVE" ? "Энэ зар аль хэдийн төлөгдсөн" : "Төлөх хугацаа дууссан эсвэл зөвшөөрөгдөөгүй зар байна", 409);
  if (num(p.amount) <= 0) throw new FeaturedError("Энэ зар үнэгүй тул төлбөр шаардлагагүй", 409);
  const existing: any = await prisma.gatewayTransaction.findFirst({ where: { promotionId: id, status: "PENDING" as any, provider: provider as any }, orderBy: { createdAt: "desc" } } as any);
  if (existing && (!existing.expiresAt || new Date(existing.expiresAt).getTime() > now.getTime())) {
    return { gatewayTransactionId: existing.id, qrText: existing.qrText, qrImageUrl: existing.qrImageUrl, amount: num(p.amount), holdUntil: p.holdUntil };
  }
  const inv = await createGatewayInvoice({ provider: provider as any, purpose: "FEATURED_PROMOTION" as any, amount: num(p.amount), description: `Онцлох байрлал ${p.referenceCode}`, promotionId: id });
  return { gatewayTransactionId: inv.gatewayTransactionId, qrText: inv.qrText, qrImageUrl: inv.qrImageUrl, amount: num(p.amount), holdUntil: p.holdUntil };
}

/** Худалдагч данс руу шилжүүлснээ мэдэгдэнэ → нөөцлөлт 24 цагаар хөлдөж, Staff шалгана. */
export async function reportBankTransfer(sellerId: string, id: string, now: Date = new Date()) {
  const p = await loadOwn(sellerId, id);
  const r = await prisma.featuredPromotion.updateMany({
    where: { id, sellerId, status: "APPROVED" as any, holdUntil: { gt: now } } as any,
    data: { status: "PAYMENT_REPORTED" as any, paymentMethod: "BANK_TRANSFER" as any, reportedAt: now, holdUntil: new Date(now.getTime() + REPORTED_HOLD_HOURS * 3600_000) },
  });
  if (r.count === 0) throw new FeaturedError(effectiveStatus(p, now) === "LAPSED" ? "Төлөх хугацаа дууссан — шинээр хүсэлт илгээнэ үү" : "Энэ зар төлбөр мэдэгдэх төлөвт байхгүй байна", 409);
  return sellerView(await loadOwn(sellerId, id), now);
}

/** QPay төлөв шалгах (polling нөөц — webhook ирээгүй үед). Төлөгдсөн бол идэвхжүүлнэ. */
export async function refreshGatewayPayment(sellerId: string, id: string, now: Date = new Date()) {
  const p = await loadOwn(sellerId, id);
  if (p.status !== "ACTIVE") {
    const tx: any = await prisma.gatewayTransaction.findFirst({ where: { promotionId: id, status: "PENDING" as any }, orderBy: { createdAt: "desc" } } as any);
    if (tx) {
      const r = await getPaymentGateway(tx.provider).checkPayment(tx.invoiceId);
      if (r.isPaid) {
        const claimed = await prisma.gatewayTransaction.updateMany({ where: { id: tx.id, status: "PENDING" as any }, data: { status: "PAID" as any, paidAt: now, rawCallback: r.raw as any } });
        if (claimed.count === 1) await applyPromotionPayment(id, num(tx.amount), tx.provider, now);
      }
    }
  }
  return sellerView(await loadOwn(sellerId, id), now);
}

// ------------------------------ Staff ------------------------------

const GROUPS: Record<string, string[]> = { REQUESTS: ["REQUESTED", "PENDING_PAYMENT"], PAYMENT: ["APPROVED", "PAYMENT_REPORTED"], ACTIVE: ["ACTIVE"], DONE: ["EXPIRED", "REJECTED", "CANCELLED", "LAPSED"] };
const ENUMS = ["REQUESTED", "APPROVED", "PAYMENT_REPORTED", "ACTIVE", "EXPIRED", "REJECTED", "CANCELLED", "LAPSED", "PENDING_PAYMENT"];

export async function listPromotions(filter?: string, now: Date = new Date()) {
  const statuses = filter && GROUPS[filter] ? GROUPS[filter] : filter && ENUMS.includes(filter) ? [filter] : null;
  const rows: any[] = await prisma.featuredPromotion.findMany({
    where: statuses ? { status: { in: statuses } as any } : {},
    orderBy: { createdAt: filter === "REQUESTS" ? "asc" : "desc" },
    take: 300,
    include: { product: { select: { name: true } }, seller: { select: { id: true, name: true, phone: true } } },
  } as any);
  return rows.map((r) => ({ ...sellerView(r, now), seller: r.seller, paymentMethod: r.paymentMethod ?? null, paidAt: r.paidAt ?? null, approvedAt: r.approvedAt ?? null, reportedAt: r.reportedAt ?? null, note: r.note ?? null, cancelReason: r.cancelReason ?? null, rejectReason: r.rejectReason ?? null, refundDueAmount: num(r.refundDueAmount), refundedAt: r.refundedAt ?? null }));
}

/** Staff зөвшөөрнө: байрлалыг нөөцөлж (лимит, давхцал шалгана), төлөх хугацаа эхэлнэ. Үнэгүй багц бол шууд идэвхжинэ. */
export async function approvePromotion(id: string, body: unknown, now: Date = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return prisma.$transaction(async (tx: any) => {
    await lock(tx);
    const promo: any = await tx.featuredPromotion.findUnique({ where: { id }, include: { product: { select: { id: true, name: true, isActive: true, isFeatured: true, featuredUntil: true } }, seller: { select: { status: true, name: true } } } });
    if (!promo) throw new FeaturedError("Зар олдсонгүй", 404);
    if (!AWAITING_APPROVAL.includes(promo.status)) throw new FeaturedError(`Энэ зар "${promo.status}" төлөвт байгаа тул зөвшөөрөх боломжгүй`, 409);
    if (promo.seller?.status !== "ACTIVE") throw new FeaturedError(`"${promo.seller?.name ?? "Худалдагч"}" идэвхгүй байна`, 409);
    if (!promo.product?.isActive) throw new FeaturedError("Бараа нуугдсан байна — онцлох боломжгүй", 409);
    if (isStaffForeverFeatured(promo.product)) throw new FeaturedError("Энэ бараа аль хэдийн хугацаагүй онцлогдсон байна", 409);

    let start: Date;
    if (b.startDate !== undefined && b.startDate !== null && b.startDate !== "") start = validateStartDate(b.startDate, now);
    else {
      if (!promo.requestedStart) throw new FeaturedError("Эхлэх огноог сонгоно уу");
      try { start = validateStartDate(ubKey(new Date(promo.requestedStart).getTime()), now); }
      catch { throw new FeaturedError("Худалдагчийн хүссэн огноо өнгөрсөн — шинэ эхлэх огноог сонгоно уу", 409); }
    }
    const w = windowFor(start, promo.durationDays);
    const cap = await capacityFor(tx, { startsAt: w.startsAt, days: promo.durationDays, productId: promo.productId, exceptId: id, now });
    if (!cap.ok) throw noCapacity(cap);

    const free = num(promo.amount) <= 0;
    const { holdMinutes } = await getSlotSettings(tx);
    const data = free
      ? { status: "ACTIVE" as any, startsAt: w.startsAt, endsAt: w.endsAt, approvedAt: now, paidAt: now, holdUntil: null, note: "Үнэгүй багц" }
      : { status: "APPROVED" as any, startsAt: w.startsAt, endsAt: w.endsAt, approvedAt: now, holdUntil: new Date(now.getTime() + holdMinutes * 60_000) };
    const claim = await tx.featuredPromotion.updateMany({ where: { id, status: { in: AWAITING_APPROVAL } as any }, data });
    if (claim.count === 0) throw new FeaturedError("Зарын төлөв дөнгөж өөрчлөгдлөө — жагсаалтаа шинэчилнэ үү", 409);
    return { id, status: free ? "ACTIVE" : "APPROVED", startsAt: w.startsAt, endsAt: w.endsAt, lastDay: lastDayKey(w.endsAt), holdUntil: free ? null : data.holdUntil, holdMinutes, productName: promo.product.name };
  });
}

export async function rejectPromotion(id: string, reason: unknown) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) throw new FeaturedError("Татгалзсан шалтгаанаа бичнэ үү (дор хаяж 3 тэмдэгт) — худалдагчид харагдана");
  const r = await prisma.featuredPromotion.updateMany({ where: { id, status: { in: AWAITING_APPROVAL } as any }, data: { status: "REJECTED" as any, rejectReason: text.slice(0, 200) } });
  if (r.count === 0) {
    const e = await prisma.featuredPromotion.findUnique({ where: { id } });
    if (!e) throw new FeaturedError("Зар олдсонгүй", 404);
    throw new FeaturedError(`Энэ зар "${e.status}" төлөвт байгаа тул татгалзах боломжгүй`, 409);
  }
  return { id, status: "REJECTED" };
}

/**
 * Төлбөр орсны дараа идэвхжүүлнэ. Нөөцлөлт үргэлжилж байвал шууд; хугацаа дууссан/LAPSED бол байрлал одоо сул эсэхийг ДАХИН шалгана.
 * Сул биш бол (хоцорсон төлбөр) идэвхжүүлэхгүй, БУЦААХ ёстой гэж тэмдэглэнэ.
 */
async function activate(tx: any, promo: any, o: { method: string | null; note?: string | null; now: Date; amount?: number }): Promise<"ACTIVATED" | "NO_CAPACITY"> {
  const holdValid = (promo.status === "APPROVED" || promo.status === "PAYMENT_REPORTED") && (!promo.holdUntil || new Date(promo.holdUntil).getTime() > o.now.getTime());
  if (!holdValid) {
    if (!promo.startsAt || new Date(promo.startsAt).getTime() < ubMidnightMs(o.now.getTime())) return "NO_CAPACITY"; // эхлэх өдөр өнгөрсөн
    const cap = await capacityFor(tx, { startsAt: new Date(promo.startsAt), days: promo.durationDays, productId: promo.productId, exceptId: promo.id, now: o.now });
    if (!cap.ok) return "NO_CAPACITY";
  }
  const claim = await tx.featuredPromotion.updateMany({
    where: { id: promo.id, status: { in: ["APPROVED", "PAYMENT_REPORTED", "LAPSED"] } as any },
    data: { status: "ACTIVE" as any, paymentMethod: o.method as any, paidAt: o.now, holdUntil: null, note: o.note ?? promo.note ?? null },
  });
  if (claim.count === 0) throw new FeaturedError("Зарын төлөв дөнгөж өөрчлөгдлөө — жагсаалтаа шинэчилнэ үү", 409);
  return "ACTIVATED";
}

async function markRefundDue(client: any, id: string, amount: number, note: string) {
  await client.featuredPromotion.updateMany({ where: { id }, data: { refundDueAmount: amount, note } });
}

/** Staff данс/бэлнээр төлбөр орсныг баталгаажуулна (APPROVED, PAYMENT_REPORTED, эсвэл хоцорсон LAPSED). */
export async function confirmPromotionPayment(id: string, body: unknown, now: Date = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const method = validatePaymentMethod(b.method);
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 200) : null;
  const result = await prisma.$transaction(async (tx: any) => {
    await lock(tx);
    const promo: any = await tx.featuredPromotion.findUnique({ where: { id }, include: { product: { select: { name: true } }, seller: { select: { status: true, name: true } } } });
    if (!promo) throw new FeaturedError("Зар олдсонгүй", 404);
    if (!["APPROVED", "PAYMENT_REPORTED", "LAPSED"].includes(promo.status)) throw new FeaturedError(`Энэ зар "${promo.status}" төлөвт байгаа тул төлбөр баталгаажуулах боломжгүй (эхлээд зөвшөөрөх ёстой)`, 409);
    if (promo.seller?.status !== "ACTIVE") throw new FeaturedError(`"${promo.seller?.name ?? "Худалдагч"}" идэвхгүй байна`, 409);
    if (!promo.startsAt) throw new FeaturedError("Эхлээд зарыг зөвшөөрч байрлал нөөцөлнө үү", 409);
    const res = await activate(tx, promo, { method, note, now });
    if (res === "NO_CAPACITY") {
      await markRefundDue(tx, id, num(promo.amount), "Нөөцлөлтийн хугацаа дууссан, байрлал дүүрсэн — мөнгө буцаана");
      return { id, status: promo.status, activated: false, refundDue: true, amount: num(promo.amount), productName: promo.product?.name };
    }
    return { id, status: "ACTIVE", activated: true, refundDue: false, startsAt: promo.startsAt, endsAt: promo.endsAt, lastDay: lastDayKey(promo.endsAt), amount: num(promo.amount), productName: promo.product?.name };
  });
  if (result.activated) await syncWindows(prisma, now).catch((e) => console.error("Онцлох синк алдаа:", e));
  return result;
}

/** QPay/SocialPay webhook болон polling-оос дуудагдана. Давхар дуудагдсан ч нэг л удаа идэвхжинэ. */
export async function applyPromotionPayment(promotionId: string, amount: number, provider: string = "QPAY", now: Date = new Date()) {
  const result = await prisma.$transaction(async (tx: any) => {
    await lock(tx);
    const promo: any = await tx.featuredPromotion.findUnique({ where: { id: promotionId } });
    if (!promo) return { activated: false, missing: true };
    if (promo.status === "ACTIVE") return { activated: true, already: true };
    if (!["APPROVED", "PAYMENT_REPORTED", "LAPSED"].includes(promo.status)) {
      await markRefundDue(tx, promotionId, amount, `Төлбөр ирсэн боловч зар "${promo.status}" төлөвт байсан — мөнгө буцаана`);
      return { activated: false, refundDue: true };
    }
    const res = await activate(tx, promo, { method: provider === "SOCIALPAY" ? "SOCIALPAY" : "QPAY", now });
    if (res === "NO_CAPACITY") {
      await markRefundDue(tx, promotionId, amount, "Төлбөр хоцорч ирсэн — байрлал дүүрсэн, мөнгө буцаана");
      return { activated: false, refundDue: true };
    }
    return { activated: true };
  });
  if ((result as any).activated && !(result as any).already) await syncWindows(prisma, now).catch((e) => console.error("Онцлох синк алдаа:", e));
  return result;
}

/** Staff цуцална: төлөхөөс өмнө (шалтгаантай); төлсөн ч эхлээгүй бол цуцлаад БУЦААХ ёстой гэж бүртгэнэ; эхэлсэн бол буцаахгүй. */
export async function cancelPromotionByStaff(id: string, reason: unknown, now: Date = new Date()) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) throw new FeaturedError("Цуцласан шалтгаанаа бичнэ үү (дор хаяж 3 тэмдэгт)");
  return prisma.$transaction(async (tx: any) => {
    await lock(tx);
    const p: any = await tx.featuredPromotion.findUnique({ where: { id } });
    if (!p) throw new FeaturedError("Зар олдсонгүй", 404);
    if (p.status === "ACTIVE") {
      if (p.startsAt && new Date(p.startsAt).getTime() <= now.getTime()) throw new FeaturedError("Онцлох хугацаа эхэлсэн тул цуцалж, мөнгө буцаах боломжгүй", 409);
      const r = await tx.featuredPromotion.updateMany({ where: { id, status: "ACTIVE" as any }, data: { status: "CANCELLED" as any, cancelReason: text.slice(0, 200), refundDueAmount: num(p.amount) } });
      if (r.count === 0) throw new FeaturedError("Зарын төлөв дөнгөж өөрчлөгдлөө", 409);
      return { id, status: "CANCELLED", refundDue: num(p.amount) > 0, amount: num(p.amount) };
    }
    if (!OPEN_STATUSES.includes(p.status)) throw new FeaturedError(`Энэ зар "${p.status}" төлөвт байгаа тул цуцлах боломжгүй`, 409);
    await tx.featuredPromotion.updateMany({ where: { id, status: { in: OPEN_STATUSES } as any }, data: { status: "CANCELLED" as any, cancelReason: text.slice(0, 200), holdUntil: null } });
    return { id, status: "CANCELLED", refundDue: false, amount: 0 };
  });
}

/** Staff мөнгийг буцаасныг тэмдэглэнэ. */
export async function markRefunded(id: string, now: Date = new Date()) {
  const r = await prisma.featuredPromotion.updateMany({ where: { id, refundDueAmount: { gt: 0 }, refundedAt: null } as any, data: { refundedAt: now } });
  if (r.count === 0) throw new FeaturedError("Буцаах мөнгө бүртгэгдээгүй эсвэл аль хэдийн буцаасан байна", 409);
  return { id, refunded: true };
}

// ------------------------- Хугацаа, автомат ажил -------------------------

/** Хугацаа дууссан зарыг EXPIRED болгож; хугацаа дууссан барааг онцлох биш болгож; ИДЭВХТЭЙ цонхтой зарын барааг онцлох болгоно. Staff хугацаагүй онцолсонд хөндөхгүй. */
export async function syncWindows(client: any, now: Date) {
  const expired = await client.featuredPromotion.updateMany({ where: { status: "ACTIVE", endsAt: { lte: now } }, data: { status: "EXPIRED" } });
  const un = await client.product.updateMany({ where: { isFeatured: true, featuredUntil: { not: null, lte: now } }, data: { isFeatured: false, featuredUntil: null, featuredOrder: null } });
  const live: any[] = await client.featuredPromotion.findMany({ where: { status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } }, select: { productId: true, endsAt: true } });
  let started = 0;
  for (const p of live) {
    const cur: any = await client.product.findUnique({ where: { id: p.productId }, select: { isFeatured: true, featuredUntil: true } });
    if (!cur || isStaffForeverFeatured(cur)) continue;
    if (cur.isFeatured && cur.featuredUntil && new Date(cur.featuredUntil).getTime() === new Date(p.endsAt).getTime()) continue;
    await client.product.update({ where: { id: p.productId }, data: { isFeatured: true, featuredUntil: p.endsAt } });
    started++;
  }
  return { expired: expired.count, unfeatured: un.count, started };
}

export async function runFeaturedMaintenance(nowMs: number = Date.now()) {
  const now = new Date(nowMs);
  const lapsed = await prisma.featuredPromotion.updateMany({ where: { status: { in: ["APPROVED", "PAYMENT_REPORTED"] } as any, holdUntil: { lte: now } } as any, data: { status: "LAPSED" as any } });
  const stale = await prisma.featuredPromotion.updateMany({ where: { status: { in: AWAITING_APPROVAL } as any, createdAt: { lte: new Date(nowMs - REQUEST_TTL_DAYS * DAY_MS) } } as any, data: { status: "CANCELLED" as any, cancelReason: `Хариу өгөөгүй (${REQUEST_TTL_DAYS} хоног)` } });
  const sync = await syncWindows(prisma, now);
  return { lapsed: lapsed.count, staleRequests: stale.count, ...sync };
}

export function startFeaturedExpiryJob() {
  const run = () => runFeaturedMaintenance().catch((err) => console.error("Онцлох байрлалын хугацаа шалгахад алдаа гарлаа:", err));
  run();
  const t = setInterval(run, 60 * 1000); // 1 минут: нөөцлөлт чөлөөлөх, өдөр шилжихэд (УБ 00:00) шинэ зар идэвхжих
  if (typeof (t as any).unref === "function") (t as any).unref();
}

export { isFeaturedNow };
