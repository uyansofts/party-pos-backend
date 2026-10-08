// ============================================================================
// GATEWAY WEBHOOK — QPay/SocialPay callback-ийн түлхүүр задлах, callback URL бүтээх (цэвэр логик).
//   QPay callback нь GET (өөрийн QPAY_CALLBACK_URL-д манай нэмсэн ?senderInvoiceNo=... + өөрийн qpay_payment_id-тэй) ирдэг,
//   зарим integration POST body-тэй (invoice_id/object_id) ирдэг. Хоёуланг нь хүлээж авна.
//   ⚠️ Callback-д ИТГЭХГҮЙ — хүлээн авсан түлхүүрээр гүйлгээг олоод, QPay-ээс checkPayment-аар ДАХИН баталгаажуулдаг (payment.controller).
// ============================================================================

import { URL } from "url"; // Node-ийн суурь модуль (глобал URL төрөл бүх tsconfig-д байх албагүй)

export interface WebhookKeys {
  invoiceId?: string;
  senderInvoiceNo?: string;
}

const SAFE = /^[A-Za-z0-9_.:\-]{3,120}$/; // invoice_id (QPay UUID), senderInvoiceNo (PURPOSE-uuid-ms), MOCK-... — бусад тэмдэгтийг татгалзана

function pick(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && SAFE.test(x.trim()) ? x.trim() : undefined;
}

/** body, query-ээс invoiceId / senderInvoiceNo-г аюулгүйгээр авна (буруу тэмдэгт, массив, объект → алгасна). */
export function resolveWebhookKeys(body: unknown, query: unknown): WebhookKeys {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const out: WebhookKeys = {};
  const invoiceId = pick(b.invoice_id) ?? pick(b.object_id) ?? pick(q.invoice_id) ?? pick(q.object_id) ?? pick(q.invoiceId);
  const sender = pick(q.senderInvoiceNo) ?? pick(b.senderInvoiceNo) ?? pick(b.sender_invoice_no);
  if (invoiceId) out.invoiceId = invoiceId;
  if (sender) out.senderInvoiceNo = sender;
  return out;
}

/** QPAY_CALLBACK_URL-д ?senderInvoiceNo=... нэмнэ (URL аль хэдийн query-тэй байсан ч эвдэхгүй). Буруу/хоосон URL → алдаа. */
export function buildCallbackUrl(base: string | undefined, senderInvoiceNo: string): string {
  if (!base || !base.trim()) throw new Error("QPAY_CALLBACK_URL тохируулаагүй байна (.env)");
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    throw new Error("QPAY_CALLBACK_URL буруу хаяг байна — https://таны-домэйн/api/payments/webhook/qpay хэлбэртэй байх ёстой");
  }
  u.searchParams.set("senderInvoiceNo", senderInvoiceNo);
  return u.toString();
}
