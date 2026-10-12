// ============================================================================
// SocialPay API Service (TypeScript)
// ----------------------------------------------------------------------------
// АНХААРУУЛГА: endpoint/талбарын нэр банкнаас (Хаан/Голомт) хамаарч
// ялгаатай байж болно — production-д орохын өмнө баталгаажуулаарай.
// ============================================================================

import axios from "axios";
import type { PaymentGateway, CreateInvoiceParams, CreateInvoiceResult, CheckPaymentResult } from "../types/payment.types";

const SOCIALPAY_BASE_URL = process.env.SOCIALPAY_BASE_URL as string;
const SOCIALPAY_MERCHANT_ID = process.env.SOCIALPAY_MERCHANT_ID as string;
const SOCIALPAY_API_KEY = process.env.SOCIALPAY_API_KEY as string;
const SOCIALPAY_CALLBACK_URL = process.env.SOCIALPAY_CALLBACK_URL as string;

interface SocialPayInvoiceResponse {
  invoice_id?: string;
  qPayShortUrl?: string;
  id?: string;
  qr_code?: string;
  qr_text?: string;
  qr_image?: string;
}

interface SocialPayStatusResponse {
  status: string;
  amount?: string | number; // ⚠️ банкны баримтаар баталгаажуулах: төлсөн дүн ирдэг эсэх. Ирэхгүй бол төлбөр UNVERIFIABLE_AMOUNT болж, Staff гараар баталгаажуулна.
}

async function createInvoice({ senderInvoiceNo, amount, description }: CreateInvoiceParams): Promise<CreateInvoiceResult> {
  const { data } = await axios.post<SocialPayInvoiceResponse>(
    `${SOCIALPAY_BASE_URL}/invoice/create`,
    {
      merchant_id: SOCIALPAY_MERCHANT_ID,
      amount,
      description,
      terminal_invoice_no: senderInvoiceNo,
      callback_url: `${SOCIALPAY_CALLBACK_URL}?senderInvoiceNo=${senderInvoiceNo}`,
    },
    { headers: { "X-API-KEY": SOCIALPAY_API_KEY } }
  );

  return {
    invoiceId: (data.invoice_id ?? data.qPayShortUrl ?? data.id) as string,
    qrText: data.qr_code ?? data.qr_text ?? null,
    qrImageUrl: data.qr_image ?? null,
  };
}

async function checkPayment(invoiceId: string): Promise<CheckPaymentResult> {
  const { data } = await axios.get<SocialPayStatusResponse>(
    `${SOCIALPAY_BASE_URL}/invoice/${invoiceId}/status`,
    { headers: { "X-API-KEY": SOCIALPAY_API_KEY } }
  );

  const isPaid = data.status === "SUCCESS" || data.status === "PAID";
  const n = typeof data.amount === "number" ? data.amount : typeof data.amount === "string" && data.amount.trim() !== "" ? Number(data.amount) : NaN;
  const paidAmount = Number.isFinite(n) && n > 0 ? n : undefined;
  return { isPaid, raw: data, paidAmount };
}

export const socialpayService: PaymentGateway = { createInvoice, checkPayment };
