// ============================================================================
// SHARED TYPES — Payment Gateway Strategy Pattern
// ----------------------------------------------------------------------------
// QPay болон SocialPay ХОЁУЛАА ЭНЭ interface-ийг хэрэгжүүлдэг тул
// payment.controller.ts аль ч provider-ийг TYPE-SAFE байдлаар,
// ялгаагүй дуудаж чадна.
// ============================================================================

export interface CreateInvoiceParams {
  senderInvoiceNo: string;
  amount: number;
  description: string;
}

export interface CreateInvoiceResult {
  invoiceId: string;
  qrText: string | null;
  qrImageUrl: string | null;
}

export interface CheckPaymentResult {
  isPaid: boolean;
  raw: unknown;
}

/** QPay болон SocialPay service-үүдийн БАРИМТЛАХ ёстой гэрээ (contract). */
export interface PaymentGateway {
  createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResult>;
  checkPayment(invoiceId: string): Promise<CheckPaymentResult>;
}

/** POS Flutter апп-ыг холбоход ашиглах JWT payload бүтэц. */
export interface PosSocketAuthPayload {
  staffId: string;
  storeId?: string;
}

/** Socket.io-оор ПОС апп руу илгээгдэх "шинэ онлайн захиалга" мэдээллийн бүтэц. */
export interface NewOnlineOrderPayload {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  totalAmount: number;
  items: Array<{
    productName: string;
    quantity: number;
    itemType: "SALE" | "RENTAL";
  }>;
  paidAt: string;
  // ✅ ШИНЭ: Хүргэлтийн мэдээлэл — кассчин ЯГ Захиалга ирмэгц харах ёстой
  deliveryMethod: "PICKUP" | "DELIVERY" | "POST" | "LOCAL_TRANSPORT" | "UB_CAB";
  deliveryAddress: string | null;
  deliveryFee: number;
  cancelledOrderCount: number; // ✅ ШИНЭ — хуурамч захиалгыг шигших
}
