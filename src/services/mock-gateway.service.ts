// ============================================================================
// MOCK PAYMENT GATEWAY — Зөвхөн ЛОКАЛ ТЕСТЭД зориулсан
// ----------------------------------------------------------------------------
// ЯАГААД ХЭРЭГТЭЙ ВЭ?
// payment.controller.ts-ийн handleGatewayWebhook() нь webhook-д ганцаараа
// ИТГЭХГҮЙ — заавал gateway.checkPayment(invoiceId)-ээр QPay/SocialPay-ийн
// БОДИТ серверээс дахин баталгаажуулдаг (аюулгүй байдлын зарчим). Энэ нь
// маш зөв production практик БОЛОВЧ Postman-аар зүгээр webhook симуляц
// хийхэд саад болно — учир нь бодит QPay сервер танай тест invoice_id-г
// "PAID" гэж хэзээ ч хэлэхгүй (учир нь тийм invoice бодитоор үүсээгүй).
//
// ШИЙДЭЛ: PaymentGateway interface-ийг хэрэгжүүлсэн "хуурамч" service
// үүсгэж, ЗӨВХӨН .env дотор USE_MOCK_GATEWAY=true үед л ашиглана.
// Strategy Pattern-ийн ачаар payment.controller.ts-ийн бусад КОД НЭГ Ч
// МӨР ӨӨРЧЛӨГДӨХГҮЙ — зөвхөн PROVIDERS object доторх 2 мөрийг сольж өгнө
// (доор харна уу).
//
// ⚠️ АНХААР: process.env.NODE_ENV === "production" үед ЭНЭ service-ийг
// АСААХГҮЙ БАЙХ ёстой! Доорх server.ts-ийн жишээнд аюулгүй байдлын
// шалгалт нэмсэн болно.
// ============================================================================

import type { PaymentGateway, CreateInvoiceParams, CreateInvoiceResult, CheckPaymentResult } from "../types/payment.types";

async function createInvoice({ senderInvoiceNo, amount }: CreateInvoiceParams): Promise<CreateInvoiceResult> {
  // Бодит QPay рүү ЯМАРЧ хүсэлт явуулахгүй — шууд "хуурамч" invoice буцаана.
  const fakeInvoiceId = `MOCK-${senderInvoiceNo}`;
  return {
    invoiceId: fakeInvoiceId,
    qrText: `mock-qr-data-for-${fakeInvoiceId}-amount-${amount}`,
    qrImageUrl: null,
  };
}

async function checkPayment(invoiceId: string): Promise<CheckPaymentResult> {
  // ЯМАГТ "төлөгдсөн" гэж хариулна — webhook симуляцийг шууд баталгаажуулна.
  console.warn(`[MOCK GATEWAY] checkPayment("${invoiceId}") → үргэлж isPaid=true буцаана`);
  return { isPaid: true, raw: { mock: true, invoiceId } };
}

export const mockGatewayService: PaymentGateway = { createInvoice, checkPayment };
