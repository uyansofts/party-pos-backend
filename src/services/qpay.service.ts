// ============================================================================
// QPay V2 API Service (TypeScript)
// ============================================================================

import axios from "axios";
import type { PaymentGateway, CreateInvoiceParams, CreateInvoiceResult, CheckPaymentResult } from "../types/payment.types";
import { buildCallbackUrl } from "../lib/gateway-webhook";
import { toQrImageSrc } from "../lib/qr";

const QPAY_BASE_URL = process.env.QPAY_BASE_URL || "https://merchant.qpay.mn";
const QPAY_USERNAME = process.env.QPAY_USERNAME as string;
const QPAY_PASSWORD = process.env.QPAY_PASSWORD as string;
const QPAY_INVOICE_CODE = process.env.QPAY_INVOICE_CODE as string;
const QPAY_CALLBACK_URL = process.env.QPAY_CALLBACK_URL as string;

interface QPayTokenResponse {
  access_token: string;
  expires_in: number;
}

interface QPayInvoiceResponse {
  invoice_id: string;
  qr_text: string;
  qr_image: string;
}

interface QPayPaymentCheckResponse {
  count: number;
  rows: Array<{ payment_status: string }>;
}

// -------- Token кэш (санах ойд; олон instance ажиллуулбал Redis руу шилжүүлнэ) --------
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/** Тохиргоо дутуу бол ойлгомжтой алдаа (өмнө нь "Basic undefined:undefined" гэж QPay-ээс 401 ирдэг байсан). */
function assertConfigured() {
  const miss = [["QPAY_USERNAME", QPAY_USERNAME], ["QPAY_PASSWORD", QPAY_PASSWORD], ["QPAY_INVOICE_CODE", QPAY_INVOICE_CODE], ["QPAY_CALLBACK_URL", QPAY_CALLBACK_URL]].filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
  if (miss.length) throw new Error(`QPay тохиргоо дутуу (.env): ${miss.join(", ")}`);
}

async function getAccessToken(): Promise<string> {
  assertConfigured();
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${QPAY_USERNAME}:${QPAY_PASSWORD}`).toString("base64");
  const { data } = await axios.post<QPayTokenResponse>(
    `${QPAY_BASE_URL}/v2/auth/token`,
    {},
    { headers: { Authorization: `Basic ${basicAuth}` } }
  );

  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

async function createInvoice({ senderInvoiceNo, amount, description }: CreateInvoiceParams): Promise<CreateInvoiceResult> {
  const token = await getAccessToken();

  const { data } = await axios.post<QPayInvoiceResponse>(
    `${QPAY_BASE_URL}/v2/invoice`,
    {
      invoice_code: QPAY_INVOICE_CODE,
      sender_invoice_no: senderInvoiceNo,
      invoice_receiver_code: "terminal",
      invoice_description: description,
      amount,
      callback_url: buildCallbackUrl(QPAY_CALLBACK_URL, senderInvoiceNo), // QPay энэ хаяг руу GET хүсэлт илгээнэ (төлбөр орсны дараа)
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    invoiceId: data.invoice_id,
    qrText: data.qr_text,
    qrImageUrl: toQrImageSrc(data.qr_image), // QPay цэвэр base64 өгдөг → data: URL болгоно (хөтөч <img>-д харуулахын тулд)
  };
}

async function checkPayment(invoiceId: string): Promise<CheckPaymentResult> {
  const token = await getAccessToken();

  const { data } = await axios.post<QPayPaymentCheckResponse>(
    `${QPAY_BASE_URL}/v2/payment/check`,
    {
      object_type: "INVOICE",
      object_id: invoiceId,
      offset: { page_number: 1, page_limit: 100 },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const isPaid = data.count > 0 && data.rows?.some((r) => r.payment_status === "PAID");
  return { isPaid, raw: data };
}

export const qpayService: PaymentGateway = { createInvoice, checkPayment };
