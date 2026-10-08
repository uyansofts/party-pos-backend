"use strict";
// ============================================================================
// RENTAL CONTROLLER (TypeScript)
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rental_availability_service_1 = require("../services/rental-availability.service");
const router = (0, express_1.Router)();
// POST /api/rentals/check-availability
// body: { productId, startDate, endDate, quantity }
router.post("/check-availability", async (req, res) => {
    try {
        const { productId, startDate, endDate, quantity } = req.body;
        if (!productId || !startDate || !endDate) {
            return res.status(400).json({ error: "productId, startDate, endDate заавал байх ёстой" });
        }
        const result = await (0, rental_availability_service_1.checkAvailability)({
            productId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            requestedQty: quantity || 1,
        });
        res.json(result);
    }
    catch (err) {
        console.error("Боломж шалгахад алдаа гарлаа:", err);
        res.status(400).json({ error: err.message });
    }
});
// POST /api/rentals/reserve
// body: { orderItemId, productId, startDate, endDate, dailyRate, depositAmount }
// ---------------------------------------------------------------------------
// Энэ endpoint нь ЯГ ЗАХИАЛГА баталгаажих мөчид дуудагдана (сагсанд нэмэх
// биш) — advisory lock ашигладаг тул давхар захиалгаас хамгаалагдсан.
// ---------------------------------------------------------------------------
router.post("/reserve", async (req, res) => {
    try {
        const { orderItemId, productId, startDate, endDate, dailyRate, depositAmount } = req.body;
        if (!orderItemId || !productId || !startDate || !endDate) {
            return res.status(400).json({ error: "Шаардлагатай талбарууд дутуу байна" });
        }
        const rentalDetail = await (0, rental_availability_service_1.reserveRentalSafely)({
            orderItemId,
            productId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            dailyRate,
            depositAmount,
        });
        res.status(201).json(rentalDetail);
    }
    catch (err) {
        if (err instanceof rental_availability_service_1.RentalUnavailableError) {
            return res.status(409).json({
                error: "Уучлаарай, энэ хугацаанд бараа дутуу байна",
                availableQty: err.availableQty,
            });
        }
        console.error("Түрээс захиалахад алдаа гарлаа:", err);
        res.status(500).json({ error: "Түрээс захиалж чадсангүй" });
    }
});
exports.default = router;
//# sourceMappingURL=rental.controller.js.map