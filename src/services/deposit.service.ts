// ============================================================================
// DEPOSIT SERVICE — Түрээсийн барьцаа хөрөнгийн бүтэн урсгал (TypeScript)
// ----------------------------------------------------------------------------
// ТӨЛӨВИЙН ДИАГРАМ (Schema v2 нэрсээр):
//
//   [RentalDetail.depositStatus]        [GatewayTransaction.status] (purpose=DEPOSIT)
//   PENDING (хараахан төлөгдөөгүй) <---  PENDING  (QR үзүүлсэн, хүлээж байна)
//         |                                  |
//         | webhook (QPay/SocialPay)         | webhook баталгаажив
//         v                                  v
//   HELD (барьцаа амжилттай                PAID
//         хуримтлагдсан, барааг гаргана)
//         |
//         | бараа буцаж ирэхэд processReturn() дуудагдана
//         v
//   FULLY_REFUNDED / PARTIALLY_REFUNDED / FORFEITED
// ============================================================================

import { DepositStatus, DepositType, RentalStatus, PaymentType, PaymentMethod } from "@prisma/client";
import { prisma } from "../lib/prisma";


export class RentalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RentalLifecycleError";
  }
}

export interface ProcessReturnParams {
  actualReturn: Date;
  damageFee?: number;
  damageNote?: string;
}

/**
 * ГАРААР барьцаа бүртгэх — QPay/SocialPay webhook-гүйгээр.
 * ----------------------------------------------------------------------------
 * 2 тохиолдол:
 *   1. depositType=MONEY  — кассчин бэлэн мөнгөөр авсан (Payment мөр бичигдэнэ,
 *      аудитад үлдэнэ)
 *   2. depositType=DOCUMENT — Иргэний үнэмлэх/бусад бичиг баримтыг биетээр
 *      барьцаалсан (мөнгө шилжээгүй тул Payment мөр ҮҮСГЭХГҮЙ, зөвхөн
 *      documentDescription-д юу барьцаалсныг тэмдэглэнэ)
 *
 * ⚠️ depositStatus ОДООГИЙН ТӨЛӨВ нь PENDING байх ёстой — аль хэдийн HELD
 * (жишээ нь QPay-ээр аль хэдийн төлөгдсөн) бол дахин барьцаалахыг зөвшөөрөхгүй.
 */
export interface MarkDepositHeldManuallyParams {
  depositType: "MONEY" | "DOCUMENT";
  method?: PaymentMethod; // depositType=MONEY үед ашиглана (анхдагч CASH)
  documentDescription?: string; // depositType=DOCUMENT үед ЗААВАЛ
}

export async function markDepositHeldManually(rentalDetailId: string, params: MarkDepositHeldManuallyParams) {
  const rental = await prisma.rentalDetail.findUniqueOrThrow({
    where: { id: rentalDetailId },
    include: { orderItem: true },
  });

  if (rental.depositStatus !== DepositStatus.PENDING) {
    throw new RentalLifecycleError(`Барьцаа аль хэдийн "${rental.depositStatus}" төлөвт байна`);
  }
  if (params.depositType === "DOCUMENT" && !params.documentDescription) {
    throw new RentalLifecycleError("Бичиг баримтын нэрийг заавал бичих ёстой");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.rentalDetail.update({
      where: { id: rentalDetailId },
      data: {
        depositStatus: DepositStatus.HELD,
        depositType: params.depositType === "DOCUMENT" ? DepositType.DOCUMENT : DepositType.MONEY,
        documentDescription: params.depositType === "DOCUMENT" ? params.documentDescription : null,
      },
    });

    // Мөнгөөр авсан бол л Payment түүхэнд бичнэ (баримт бол мөнгө шилжээгүй)
    if (params.depositType === "MONEY") {
      await tx.payment.create({
        data: {
          orderId: rental.orderItem.orderId,
          type: PaymentType.DEPOSIT,
          method: params.method ?? PaymentMethod.CASH,
          amount: rental.depositAmount,
          note: "Гараар (QPay бус) баталгаажуулсан барьцаа",
        },
      });
    }

    return updated;
  }, { timeout: 15000 });
}

/**
 * Webhook-оор барьцааны төлбөр баталгаажсаны дараа дуудагдана.
 */
export async function markDepositPaid(rentalDetailId: string, _gatewayTransactionId: string) {
  return prisma.rentalDetail.update({
    where: { id: rentalDetailId },
    data: { depositStatus: DepositStatus.HELD }, // мөнгө орж ирсэн тул HELD болно
  });
}

/**
 * БАРААГ ХЭРЭГЛЭГЧДЭД ГАРДУУЛАХ (pickup) — кассчин барааг гарт нь өгөхөд дуудна.
 * ----------------------------------------------------------------------------
 * БИЗНЕСИЙН ХатуУ ДҮРЭМ: барьцаа мөнгө HELD (бодитоор орж ирсэн) болоогүй
 * бол барааг гаргаж болохгүй — эс бөгөөс барьцаагүйгээр түрээслэх зөрчил
 * гарна. Энэ шалгалтыг API түвшинд БИШ, service түвшинд хийснээр ямар ч
 * ирээдүйн клиент (Flutter, өөр backend) үүнийг тойрч гарах боломжгүй.
 */
export async function markAsPickedUp(rentalDetailId: string) {
  const rental = await prisma.rentalDetail.findUniqueOrThrow({
    where: { id: rentalDetailId },
    include: { orderItem: true },
  });

  if (rental.rentalStatus !== RentalStatus.BOOKED) {
    throw new RentalLifecycleError(
      `Энэ түрээс "${rental.rentalStatus}" төлөвт байгаа тул гардуулах боломжгүй (BOOKED байх ёстой)`
    );
  }
  if (rental.depositStatus !== DepositStatus.HELD) {
    throw new RentalLifecycleError(
      `Барьцаа мөнгө хараахан баталгаажаагүй (${rental.depositStatus}) тул барааг гардуулж болохгүй`
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.rentalDetail.update({
      where: { id: rentalDetailId },
      data: { rentalStatus: RentalStatus.ACTIVE },
    });

    // Аудитын түүхэнд бараа гарсныг бичнэ (availability тооцоонд НӨЛӨӨЛӨХГҮЙ —
    // тэр логик rentalStatus дээр л тулгуурладаг, энэ зөвхөн түүх).
    await tx.stockMovement.create({
      data: {
        productId: rental.orderItem.productId,
        type: "RENTAL_OUT",
        quantity: rental.orderItem.quantity,
        referenceOrderId: rental.orderItem.orderId,
        note: `Түрээсээр гарсан (RentalDetail: ${rentalDetailId})`,
      },
    });

    return updated;
  }, { timeout: 15000 });
}

/**
 * БАРАА БУЦАЖ ИРЭХЭД дуудагдах гол функц.
 * Хожимдол, гэмтлийг тооцоод depositRefundAmount-ыг тооцно.
 */
export async function processReturn(rentalDetailId: string, params: ProcessReturnParams) {
  const { actualReturn, damageFee = 0, damageNote } = params;

  const rental = await prisma.rentalDetail.findUniqueOrThrow({
    where: { id: rentalDetailId },
    include: { orderItem: true },
  });

  if (rental.rentalStatus !== RentalStatus.ACTIVE && rental.rentalStatus !== RentalStatus.OVERDUE) {
    throw new RentalLifecycleError(
      `Энэ түрээс "${rental.rentalStatus}" төлөвт байгаа тул буцаалт хийх боломжгүй (ACTIVE эсвэл OVERDUE байх ёстой)`
    );
  }

  // ---------- 1. Хожимдлын хоног, торгууль тооцох ----------
  const msPerDay = 1000 * 60 * 60 * 24;
  const overdueDays = Math.max(0, Math.ceil((actualReturn.getTime() - rental.endDate.getTime()) / msPerDay));
  const lateFeePerDay = Number(rental.lateFeePerDay);
  const penaltyFee = overdueDays * lateFeePerDay;

  // ---------- 2. Барьцаанаас хасагдах нийт дүн ----------
  const depositAmount = Number(rental.depositAmount);
  const totalDeduction = damageFee + penaltyFee;
  const depositRefundAmount = Math.max(depositAmount - totalDeduction, 0);

  // ---------- 3. Эцсийн төлөв тодорхойлох ----------
  let depositStatus: DepositStatus;
  if (totalDeduction <= 0) {
    depositStatus = DepositStatus.FULLY_REFUNDED;
  } else if (depositRefundAmount > 0) {
    depositStatus = DepositStatus.PARTIALLY_REFUNDED;
  } else {
    depositStatus = DepositStatus.FORFEITED;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.rentalDetail.update({
      where: { id: rentalDetailId },
      data: {
        actualReturn,
        overdueDays,
        penaltyFee,
        damageFee,
        damageNote,
        depositRefundAmount,
        depositStatus,
        rentalStatus: RentalStatus.RETURNED,
      },
    });

    await tx.stockMovement.create({
      data: {
        productId: rental.orderItem.productId,
        type: "RENTAL_RETURN",
        quantity: rental.orderItem.quantity,
        referenceOrderId: rental.orderItem.orderId,
        note: `Түрээсээс буцсан (RentalDetail: ${rentalDetailId})`,
      },
    });

    // Аудитын зорилгоор буцаалтыг Payment хүснэгтэд бичнэ
    // (бодит мөнгө буцаах ажлыг кассаар гараар эсвэл SocialPay P2P-ээр хийнэ)
    if (depositRefundAmount > 0) {
      const orderItem = await tx.orderItem.findFirst({
        where: { rentalDetail: { id: rentalDetailId } },
      });
      if (orderItem) {
        await tx.payment.create({
          data: {
            orderId: orderItem.orderId,
            type: PaymentType.DEPOSIT_REFUND,
            method: PaymentMethod.CASH, // эсвэл бодит буцаасан аргаар солино
            amount: depositRefundAmount,
            note: `Барьцаа буцаалт (${overdueDays} хоног хоцорсон, гэмтэл: ${damageFee}₮)`,
          },
        });
      }
    }

    return updated;
  }, { timeout: 15000 });
}
