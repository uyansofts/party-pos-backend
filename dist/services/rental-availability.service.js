"use strict";
// ============================================================================
// RENTAL AVAILABILITY SERVICE (TypeScript)
// ----------------------------------------------------------------------------
// "check → act" TOCTOU (race condition) асуудлыг PostgreSQL Advisory Lock-оор
// шийдсэн болно — дэлгэрэнгүй тайлбарыг өмнөх хувилбараас үзнэ үү.
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.RentalUnavailableError = void 0;
exports.checkAvailability = checkAvailability;
exports.reserveRentalSafely = reserveRentalSafely;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
// Түрээсний захиалга "идэвхтэй" гэж тооцогдох (нөөц эзэлдэг) төлвүүд
const BLOCKING_STATUSES = [client_1.RentalStatus.BOOKED, client_1.RentalStatus.ACTIVE, client_1.RentalStatus.OVERDUE];
/**
 * Тухайн Product-ыг [startDate, endDate) хугацаанд requestedQty ширхэгээр
 * захиалж болох эсэхийг шалгана. ЗӨВХӨН УНШИХ — сагсанд нэмэхэд ашиглана.
 */
async function checkAvailability({ productId, startDate, endDate, requestedQty = 1, excludeOrderItemId, }) {
    if (startDate >= endDate) {
        throw new Error("Эхлэх огноо дуусах огнооноос өмнө байх ёстой");
    }
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
class RentalUnavailableError extends Error {
    constructor(availableQty) {
        super("RENTAL_UNAVAILABLE");
        this.name = "RentalUnavailableError";
        this.availableQty = availableQty;
    }
}
exports.RentalUnavailableError = RentalUnavailableError;
/**
 * Захиалга бүртгэх ҮЕД дуудагдах АЮУЛГҮЙ функц. Advisory lock ашиглан
 * давхар захиалгаас (race condition) хамгаална.
 */
async function reserveRentalSafely({ orderItemId, productId, startDate, endDate, dailyRate, depositAmount, }) {
    return prisma.$transaction(async (tx) => {
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
                rentalStatus: client_1.RentalStatus.BOOKED,
                // depositStatus нь schema-д @default(PENDING) тул энд заавал өгөхгүй ч болно
            },
        });
    });
}
//# sourceMappingURL=rental-availability.service.js.map