"use strict";
// ============================================================================
// SocialPay API Service (TypeScript)
// ----------------------------------------------------------------------------
// АНХААРУУЛГА: endpoint/талбарын нэр банкнаас (Хаан/Голомт) хамаарч
// ялгаатай байж болно — production-д орохын өмнө баталгаажуулаарай.
// ============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.socialpayService = void 0;
const axios_1 = __importDefault(require("axios"));
const SOCIALPAY_BASE_URL = process.env.SOCIALPAY_BASE_URL;
const SOCIALPAY_MERCHANT_ID = process.env.SOCIALPAY_MERCHANT_ID;
const SOCIALPAY_API_KEY = process.env.SOCIALPAY_API_KEY;
const SOCIALPAY_CALLBACK_URL = process.env.SOCIALPAY_CALLBACK_URL;
async function createInvoice({ senderInvoiceNo, amount, description }) {
    const { data } = await axios_1.default.post(`${SOCIALPAY_BASE_URL}/invoice/create`, {
        merchant_id: SOCIALPAY_MERCHANT_ID,
        amount,
        description,
        terminal_invoice_no: senderInvoiceNo,
        callback_url: `${SOCIALPAY_CALLBACK_URL}?senderInvoiceNo=${senderInvoiceNo}`,
    }, { headers: { "X-API-KEY": SOCIALPAY_API_KEY } });
    return {
        invoiceId: (data.invoice_id ?? data.qPayShortUrl ?? data.id),
        qrText: data.qr_code ?? data.qr_text ?? null,
        qrImageUrl: data.qr_image ?? null,
    };
}
async function checkPayment(invoiceId) {
    const { data } = await axios_1.default.get(`${SOCIALPAY_BASE_URL}/invoice/${invoiceId}/status`, { headers: { "X-API-KEY": SOCIALPAY_API_KEY } });
    const isPaid = data.status === "SUCCESS" || data.status === "PAID";
    return { isPaid, raw: data };
}
exports.socialpayService = { createInvoice, checkPayment };
//# sourceMappingURL=socialpay.service.js.map