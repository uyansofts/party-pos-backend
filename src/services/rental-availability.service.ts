// ============================================================================
// RENTAL AVAILABILITY SERVICE (TypeScript)
// ----------------------------------------------------------------------------
// "check → act" TOCTOU (race condition) асуудлыг PostgreSQL Advisory Lock-оор
// шийдсэн болно — дэлгэрэнгүй тайлбарыг өмнөх хувилбараас үзнэ үү.
// ============================================================================

import { Prisma, RentalStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { startOfTodayInUlaanbaatar } from "../lib/timezone";


// Order Checkout транзакцаас дамжуулж ирэх Prisma transaction client-ийн төрөл.
// (interactive transaction callback-ийн параметртэй яг адилхан)
type TxClient = Prisma.TransactionClient;

// Түрээсний захиалга "идэвхтэй" гэж тооцогдох (нөөц эзэлдэг) төлвүүд
const BLOCKING_STATUSES: RentalStatus[] = [RentalStatus.BOOKED, RentalStatus.ACTIVE, RentalStatus.OVERDUE];

// ============================================================================
// ✅ ШИНЭ: Түрээсийн огнооны НЭГДСЭН шалгалт (checkAvailability БОЛОН
// reserveRentalWithinTx хоёулаа ашиглана — давхардуулахгүй).
// ----------------------------------------------------------------------------
// "Өнгөрсөн" эсэхийг ӨНӨӨДРИЙН ЭХЭН (00:00)-тэй харьцуулна — өдрөөр
// тооцдог түрээсийн зарчимд нийцүүлж, "өнөөдөр"-ийг ХҮЧИНТЭЙ гэж үзнэ
// (харин "өчигдөр"-өөс эхэлсэн хугацааг хориглоно).
// ============================================================================
function assertValidRentalDates(startDate: Date, endDate: Date) {
  if (startDate >= endDate) {
    throw new Error("Эхлэх огноо дуусах огнооноос өмнө байх ёстой");
  }

  // ✅ ЗАСВАР: Сервер компьютерийн системийн цагийн бүсээс ХАМААРАХГҮЙ
  // (жишээ нь Cloud сервер өөр улсад байрлаж болно) — Улаанбаатарын
  // тогтмол UTC+8-аар "өнөөдөр"-ийг тооцно.
  const todayStart = startOfTodayInUlaanbaatar();

  if (startDate < todayStart) {
    throw new Error("Эхлэх огноо өнгөрсөн байж болохгүй");
  }
}

export interface CheckAvailabilityParams {
  productId: string;
  startDate: Date;
  endDate: Date;
  requestedQty?: number;
  excludeOrderItemId?: string;
}

export interface AvailabilityResult {
  available: boolean;
  availableQty: number;
  totalStock: number;
}

/**
 * Тухайн Product-ыг [startDate, endDate) хугацаанд requestedQty ширхэгээр
 * захиалж болох эсэхийг шалгана. ЗӨВХӨН УНШИХ — сагсанд нэмэхэд ашиглана.
 */
export async function checkAvailability({
  productId,
  startDate,
  endDate,
  requestedQty = 1,
  excludeOrderItemId,
}: CheckAvailabilityParams): Promise<AvailabilityResult> {
  assertValidRentalDates(startDate, endDate);

  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  if (!product.isRental) {
    throw new Error("Энэ бараа түрээслэгддэггүй");
  }

  const totalStock = product.rentalStockQty ?? 0;

  // Интервал давхцлын нөхцөл: existing.start < new.end AND existing.end > new.start
  const overlapping = await prisma.rentalDetail.findMany({
    where: {
      rentalStatus: { in: BLOCKING_STATUSES },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
      orderItem: { productId },
      ...(excludeOrderItemId ? { orderItemId: { not: excludeOrderItemId } } : {}),
    },
    include: { orderItem: { select: { quantity: true } } },
  });

  const reservedQty = overlapping.reduce((sum, r) => sum + r.orderItem.quantity, 0);
  const availableQty = totalStock - reservedQty;

  return {
    available: availableQty >= requestedQty,
    availableQty: Math.max(availableQty, 0),
    totalStock,
  };
}

export interface ReserveRentalParams {
  orderItemId: string;
  productId: string;
  startDate: Date;
  endDate: Date;
  dailyRate: number;
  depositAmount: number;
}

export class RentalUnavailableError extends Error {
  availableQty: number;
  constructor(availableQty: number) {
    super("RENTAL_UNAVAILABLE");
    this.name = "RentalUnavailableError";
    this.availableQty = availableQty;
  }
}

/**
 * ЦӨМ ЛОГИК — Prisma transaction client (tx)-ийг ГАДНААС авна.
 * ----------------------------------------------------------------------------
 * Order Checkout мэт "олон алхамтай, БҮГД амжилттай эсвэл БҮГД буцах ёстой"
 * урсгалд шууд ашиглахын тулд prisma.$transaction()-ийг ӨӨРӨӨ нээхгүй —
 * дуудагч тал (жишээ нь order.service.ts) өгсөн tx-ийг ашиглана. Ингэснээр
 * "захиалга үүсгэх" болон "түрээс баталгаажуулах" хоёр НЭГ АТОМИК үйлдэл
 * болно: түрээс боломжгүй бол ЗАХИАЛГА Ч ҮҮСЭХГҮЙ (бүхэлдээ rollback хийнэ).
 */
export async function reserveRentalWithinTx(tx: TxClient, params: ReserveRentalParams) {
  const { orderItemId, productId, startDate, endDate, dailyRate, depositAmount } = params;

  // ✅ ДАВХАР ХАМГААЛАЛТ — checkAvailability()-д ижил шалгалт байсан ч,
  // Checkout нь ШУУД энэ функцийг дуудаж (checkAvailability-г заавал дахин
  // дуудахгүйгээр) захиалга бүртгэдэг байсан тул буруу/өнгөрсөн огноотой ч
  // гэсэн захиалга бүртгэгдэх цоорхой байсан. Одоо ЭНД ч заавал шалгана.
  assertValidRentalDates(startDate, endDate);

  // ---- 1. Advisory Lock: ЯГ ЭНЭ productId дээр өрсөлдөх бусад
  //         транзакцуудыг ЗОГСООНО (транзакц дуусахад автоматаар суллагдана) ----
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, productId);

  // ---- 2. Lock-ийн ДОТОР дахин шалгана ----
  const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
  const totalStock = product.rentalStockQty ?? 0;

  const overlapping = await tx.rentalDetail.findMany({
    where: {
      rentalStatus: { in: BLOCKING_STATUSES },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
      orderItem: { productId },
    },
    include: { orderItem: { select: { quantity: true } } },
  });

  const requestedItem = await tx.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
  const reservedQty = overlapping.reduce((sum, r) => sum + r.orderItem.quantity, 0);

  if (totalStock - reservedQty < requestedItem.quantity) {
    throw new RentalUnavailableError(Math.max(totalStock - reservedQty, 0));
  }

  // ---- 3. Боломжтой тул RentalDetail-ийг ЭНЭ ЛОК-ИЙН ДОТОР үүсгэнэ ----
  const rentalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  return tx.rentalDetail.create({
    data: {
      orderItemId,
      startDate,
      endDate,
      rentalDays,
      dailyRate,
      depositAmount,
      rentalStatus: RentalStatus.BOOKED,
    },
  });
}

/**
 * Захиалга бүртгэх ҮЕД ГАНЦААРАА (Order Checkout-оос ГАДУУР) дуудагдах
 * ТУСГААР функц. Дотроо ШИНЭ transaction нээгээд reserveRentalWithinTx-ийг
 * дуудна. Order Checkout ашиглахдаа ЭНЭ функцийг БИШ, дээрх
 * reserveRentalWithinTx-ийг шууд ашиглана уу (nested transaction зөвшөөрөгдөхгүй).
 */
export async function reserveRentalSafely(params: ReserveRentalParams) {
  return prisma.$transaction((tx) => reserveRentalWithinTx(tx, params), { timeout: 15000 });
}
