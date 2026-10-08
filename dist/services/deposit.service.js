"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.markDepositPaid = markDepositPaid;
exports.processReturn = processReturn;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
/**
 * Webhook-оор барьцааны төлбөр баталгаажсаны дараа дуудагдана.
 */
async function markDepositPaid(rentalDetailId, _gatewayTransactionId) {
    return prisma.rentalDetail.update({
        where: { id: rentalDetailId },
        data: { depositStatus: client_1.DepositStatus.HELD }, // мөнгө орж ирсэн тул HELD болно
    });
}
/**
 * БАРАА БУЦАЖ ИРЭХЭД дуудагдах гол функц.
 * Хожимдол, гэмтлийг тооцоод depositRefundAmount-ыг тооцно.
 */
async function processReturn(rentalDetailId, params) {
    const { actualReturn, damageFee = 0, damageNote } = params;
    const rental = await prisma.rentalDetail.findUniqueOrThrow({
        where: { id: rentalDetailId },
    });
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
    let depositStatus;
    if (totalDeduction <= 0) {
        depositStatus = client_1.DepositStatus.FULLY_REFUNDED;
    }
    else if (depositRefundAmount > 0) {
        depositStatus = client_1.DepositStatus.PARTIALLY_REFUNDED;
    }
    else {
        depositStatus = client_1.DepositStatus.FORFEITED;
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
                rentalStatus: client_1.RentalStatus.RETURNED,
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
                        type: client_1.PaymentType.DEPOSIT_REFUND,
                        method: client_1.PaymentMethod.CASH, // эсвэл бодит буцаасан аргаар солино
                        amount: depositRefundAmount,
                        note: `Барьцаа буцаалт (${overdueDays} хоног хоцорсон, гэмтэл: ${damageFee}₮)`,
                    },
                });
            }
        }
        return updated;
    });
}
//# sourceMappingURL=deposit.service.js.map