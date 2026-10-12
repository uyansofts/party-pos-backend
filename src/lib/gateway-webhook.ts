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
  /** Нэг төрлийн түлхүүр олон өөр утгатай ирсэн (жишээ нь invoice_id ≠ object_id, давхар query параметр) — ТОДОРХОЙГҮЙ, татгалзана. */
  conflict?: boolean;
}

const SAFE = /^[A-Za-z0-9_.:\-]{3,120}$/; // invoice_id (QPay UUID), senderInvoiceNo (PURPOSE-uuid-ms), MOCK-... — бусад тэмдэгтийг татгалзана

/** Нэг утга эсвэл массив → хүчинтэй мөрүүд. Хүчингүй (буруу тэмдэгт/объект) утгыг алгасна. */
function pickAll(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is string => typeof x === "string" && SAFE.test(x.trim())).map((x) => x.trim());
}

/** Олон эх сурвалжаас нэг түлхүүр: бүх утга ижил бол тэр, өөр утга байвал conflict. */
function unify(...vals: unknown[]): { value?: string; conflict: boolean } {
  const all = new Set(vals.flatMap(pickAll));
  if (all.size === 0) return { conflict: false };
  if (all.size > 1) return { conflict: true };
  return { value: [...all][0], conflict: false };
}

/** body, query-ээс invoiceId / senderInvoiceNo-г аюулгүйгээр авна (буруу тэмдэгт, объект → алгасна; өөр утгууд зөрчилдвөл conflict). */
export function resolveWebhookKeys(body: unknown, query: unknown): WebhookKeys {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const out: WebhookKeys = {};
  const inv = unify(b.invoice_id, b.object_id, q.invoice_id, q.object_id, q.invoiceId);
  const snd = unify(q.senderInvoiceNo, b.senderInvoiceNo, b.sender_invoice_no);
  if (inv.value) out.invoiceId = inv.value;
  if (snd.value) out.senderInvoiceNo = snd.value;
  if (inv.conflict || snd.conflict) out.conflict = true;
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
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("QPAY_CALLBACK_URL буруу хаяг байна — https:// -ээр эхлэх ёстой");
  }
  u.searchParams.set("senderInvoiceNo", senderInvoiceNo);
  return u.toString();
}
