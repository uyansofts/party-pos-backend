"use strict";
// ============================================================================
// PAYMENT CONTROLLER (TypeScript) — Schema v2-т тааруулсан
// ----------------------------------------------------------------------------
// ӨӨРЧЛӨГДСӨН ТАЛБАРУУД (v1 → v2):
//   Order.status         → Order.paymentStatus (PayStatus)
//   Order.channel         → Order.orderType (OrderType: POS/ONLINE)
//   Product.stockQuantity → Product.sellStockQty
//   PaymentMethod-д SOCIALPAY АЛЬ ХЭДИЙН орсон тул ternary заль хэрэггүй болсон
// ============================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const qpay_service_1 = require("../services/qpay.service");
const socialpay_service_1 = require("../services/socialpay.service");
const depositService = __importStar(require("../services/deposit.service"));
const socket_1 = require("../realtime/socket");
const prisma = new client_1.PrismaClient();
const router = (0, express_1.Router)();
const PROVIDERS = {
    QPAY: qpay_service_1.qpayService,
    SOCIALPAY: socialpay_service_1.socialpayService,
};
router.post("/invoice", async (req, res) => {
    try {
        const { provider, purpose, orderId, rentalDetailId, amount, description } = req.body;
        const gateway = PROVIDERS[provider];
        if (!gateway)
            return res.status(400).json({ error: "Provider буруу байна" });
        const senderInvoiceNo = `${purpose}-${orderId || rentalDetailId}-${Date.now()}`;
        const invoice = await gateway.createInvoice({ senderInvoiceNo, amount, description });
        const gatewayTx = await prisma.gatewayTransaction.create({
            data: {
                provider,
                purpose,
                invoiceId: invoice.invoiceId,
                amount,
                status: client_1.GatewayTxStatus.PENDING,
                qrText: invoice.qrText,
                qrImageUrl: invoice.qrImageUrl,
                orderId: orderId ?? null,
                rentalDetailId: rentalDetailId ?? null,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
        });
        res.json({
            gatewayTransactionId: gatewayTx.id,
            invoiceId: invoice.invoiceId,
            qrText: invoice.qrText,
            qrImageUrl: invoice.qrImageUrl,
        });
    }
    catch (err) {
        console.error("Invoice үүсгэхэд алдаа гарлаа:", err);
        res.status(500).json({ error: "Invoice үүсгэж чадсангүй" });
    }
});
// ============================================================================
// 2 & 3. WEBHOOK — QPay / SocialPay
// ============================================================================
router.post("/webhook/qpay", async (req, res) => {
    try {
        await handleGatewayWebhook(client_1.GatewayProvider.QPAY, req);
    }
    catch (err) {
        console.error("QPay webhook алдаа:", err);
    }
    res.status(200).send("OK"); // Provider-т ЯМАРЧ тохиолдолд 200 буцаана (retry storm-оос сэргийлнэ)
});
router.post("/webhook/socialpay", async (req, res) => {
    try {
        await handleGatewayWebhook(client_1.GatewayProvider.SOCIALPAY, req);
    }
    catch (err) {
        console.error("SocialPay webhook алдаа:", err);
    }
    res.status(200).send("OK");
});
async function handleGatewayWebhook(provider, req) {
    const invoiceId = req.body.invoice_id || req.body.object_id || req.query.invoiceId;
    if (!invoiceId) {
        console.warn(`${provider} webhook: invoice_id олдсонгүй`, req.body);
        return;
    }
    const gatewayTx = await prisma.gatewayTransaction.findUnique({ where: { invoiceId } });
    if (!gatewayTx) {
        console.warn(`${provider} webhook: GatewayTransaction олдсонгүй`, invoiceId);
        return;
    }
    // Idempotency: аль хэдийн PAID бол дахин боловсруулахгүй
    if (gatewayTx.status === client_1.GatewayTxStatus.PAID)
        return;
    // Давхар баталгаажуулалт — webhook-д ганцаараа найдахгүй
    const gateway = PROVIDERS[provider];
    const { isPaid, raw } = await gateway.checkPayment(invoiceId);
    if (!isPaid) {
        console.warn(`${provider} webhook ирсэн ч checkPayment баталгаажуулж чадсангүй`, invoiceId);
        return;
    }
    const updated = await prisma.gatewayTransaction.update({
        where: { id: gatewayTx.id },
        data: { status: client_1.GatewayTxStatus.PAID, paidAt: new Date(), rawCallback: raw },
    });
    if (updated.purpose === client_1.GatewayPurpose.ORDER_PAYMENT && updated.orderId) {
        await applyOrderPayment(updated.orderId, Number(updated.amount), provider);
    }
    else if (updated.purpose === client_1.GatewayPurpose.DEPOSIT && updated.rentalDetailId) {
        await depositService.markDepositPaid(updated.rentalDetailId, updated.id);
    }
}
/**
 * Захиалгын үндсэн төлбөр орж ирэхэд Order.paymentStatus шинэчилж,
 * ONLINE суваг байвал ПОС апп руу realtime мэдэгдэл илгээнэ.
 */
async function applyOrderPayment(orderId, amount, provider) {
    const updatedOrder = await prisma.$transaction(async (tx) => {
        await tx.payment.create({
            data: {
                orderId,
                type: client_1.PaymentType.SALE_PAYMENT,
                method: provider === client_1.GatewayProvider.QPAY ? client_1.PaymentMethod.QPAY : client_1.PaymentMethod.SOCIALPAY,
                amount,
            },
        });
        const order = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            include: { items: { include: { product: true } }, customer: true },
        });
        const newPaidAmount = Number(order.paidAmount) + amount;
        const isFullyPaid = newPaidAmount >= Number(order.totalAmount);
        const saved = await tx.order.update({
            where: { id: orderId },
            data: {
                paidAmount: newPaidAmount,
                paymentStatus: isFullyPaid ? client_1.PayStatus.PAID : client_1.PayStatus.PARTIALLY_PAID,
            },
            include: { items: { include: { product: true } }, customer: true },
        });
        // ---- Агуулахын үлдэгдлийг ШУУД буулгах (SALE_OUT) — зөвхөн бүрэн төлөгдсөн үед ----
        if (isFullyPaid) {
            for (const item of saved.items) {
                if (item.itemType === "SALE") {
                    await tx.product.update({
                        where: { id: item.productId },
                        data: { sellStockQty: { decrement: item.quantity } },
                    });
                    await tx.stockMovement.create({
                        data: {
                            productId: item.productId,
                            type: client_1.StockMovementType.SALE_OUT,
                            quantity: item.quantity,
                            referenceOrderId: orderId,
                            note: `${saved.orderType === client_1.OrderType.ONLINE ? "Онлайн" : "Кассын"} захиалга #${saved.orderNumber}`,
                        },
                    });
                }
            }
        }
        return saved;
    });
    // ---- REALTIME: Транзакц АМЖИЛТТАЙ дуусаад ГАДНА нь илгээнэ ----
    try {
        if (updatedOrder.orderType === client_1.OrderType.ONLINE) {
            const payload = {
                orderId: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber,
                customerName: updatedOrder.customer?.name ?? "Танихгүй",
                customerPhone: updatedOrder.customer?.phone ?? null,
                totalAmount: Number(updatedOrder.totalAmount),
                items: updatedOrder.items.map((i) => ({
                    productName: i.product.name,
                    quantity: i.quantity,
                    itemType: i.itemType,
                })),
                paidAt: new Date().toISOString(),
            };
            (0, socket_1.emitToStore)(updatedOrder.storeId, "new_online_order", payload);
            (0, socket_1.emitToStore)(updatedOrder.storeId, "inventory_updated", {
                orderId: updatedOrder.id,
                affectedProductIds: updatedOrder.items.map((i) => i.productId),
            });
        }
    }
    catch (socketErr) {
        console.error("Realtime мэдэгдэл илгээхэд алдаа гарлаа (захиалга бүртгэгдсэн):", socketErr);
    }
}
// ============================================================================
// 4. ТӨЛБӨРИЙН ТӨЛӨВ ШАЛГАХ (Flutter polling)
//    GET /api/payments/status/:gatewayTransactionId
// ============================================================================
router.get("/status/:gatewayTransactionId", async (req, res) => {
    const tx = await prisma.gatewayTransaction.findUnique({
        where: { id: req.params.gatewayTransactionId },
    });
    if (!tx)
        return res.status(404).json({ error: "Олдсонгүй" });
    res.json({ status: tx.status, paidAt: tx.paidAt });
});
exports.default = router;
//# sourceMappingURL=payment.controller.js.map