"use strict";
// ============================================================================
// QPay V2 API Service (TypeScript)
// ============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.qpayService = void 0;
const axios_1 = __importDefault(require("axios"));
const QPAY_BASE_URL = process.env.QPAY_BASE_URL || "https://merchant.qpay.mn";
const QPAY_USERNAME = process.env.QPAY_USERNAME;
const QPAY_PASSWORD = process.env.QPAY_PASSWORD;
const QPAY_INVOICE_CODE = process.env.QPAY_INVOICE_CODE;
const QPAY_CALLBACK_URL = process.env.QPAY_CALLBACK_URL;
// -------- Token кэш (санах ойд; олон instance ажиллуулбал Redis руу шилжүүлнэ) --------
let cachedToken = null;
let tokenExpiresAt = 0;
async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt - 30000) {
        return cachedToken;
    }
    const basicAuth = Buffer.from(`${QPAY_USERNAME}:${QPAY_PASSWORD}`).toString("base64");
    const { data } = await axios_1.default.post(`${QPAY_BASE_URL}/v2/auth/token`, {}, { headers: { Authorization: `Basic ${basicAuth}` } });
    cachedToken = data.access_token;
    tokenExpiresAt = now + data.expires_in * 1000;
    return cachedToken;
}
async function createInvoice({ senderInvoiceNo, amount, description }) {
    const token = await getAccessToken();
    const { data } = await axios_1.default.post(`${QPAY_BASE_URL}/v2/invoice`, {
        invoice_code: QPAY_INVOICE_CODE,
        sender_invoice_no: senderInvoiceNo,
        invoice_receiver_code: "terminal",
        invoice_description: description,
        amount,
        callback_url: `${QPAY_CALLBACK_URL}?senderInvoiceNo=${senderInvoiceNo}`,
    }, { headers: { Authorization: `Bearer ${token}` } });
    return {
        invoiceId: data.invoice_id,
        qrText: data.qr_text,
        qrImageUrl: data.qr_image,
    };
}
async function checkPayment(invoiceId) {
    const token = await getAccessToken();
    const { data } = await axios_1.default.post(`${QPAY_BASE_URL}/v2/payment/check`, {
        object_type: "INVOICE",
        object_id: invoiceId,
        offset: { page_number: 1, page_limit: 100 },
    }, { headers: { Authorization: `Bearer ${token}` } });
    const isPaid = data.count > 0 && data.rows?.some((r) => r.payment_status === "PAID");
    return { isPaid, raw: data };
}
exports.qpayService = { createInvoice, checkPayment };
//# sourceMappingURL=qpay.service.js.map