// ============================================================================
// INVOICE SERVICE — Payment invoice үүсгэх НЭГ Л ЦЭГ
// ----------------------------------------------------------------------------
// АРХИТЕКТУРЫН ШАЛТГААН: Staff-ийн (/api/payments/invoice) болон нээлттэй
// худалдан авагчийн (/api/public/orders/:id/invoice) хоёр endpoint ЯГ ИЖИЛ
// "QPay/SocialPay/Mock сонгох → invoice үүсгэх → GatewayTransaction бичих"
// логикийг ашигладаг. Үүнийг 2 газар давхардуулбал MOCK_GATEWAY-ийн
// шалгалт мэт чухал логик хожим зөрчигдөх эрсдэлтэй — тиймээс НЭГ Л
// ФУНКЦ болгож, хоёр controller-т дуудна.
// ============================================================================

import { GatewayProvider, GatewayPurpose, GatewayTxStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { qpayService } from "./qpay.service";
import { socialpayService } from "./socialpay.service";
import { mockGatewayService } from "./mock-gateway.service";
import type { PaymentGateway } from "../types/payment.types";


const USE_MOCK = process.env.USE_MOCK_GATEWAY === "true" && process.env.NODE_ENV !== "production";

const PROVIDERS: Record<GatewayProvider, PaymentGateway> = {
  QPAY: USE_MOCK ? mockGatewayService : qpayService,
  SOCIALPAY: USE_MOCK ? mockGatewayService : socialpayService,
};

export interface CreateInvoiceInput {
  provider: GatewayProvider;
  purpose: GatewayPurpose;
  amount: number;
  description: string;
  orderId?: string;
  rentalDetailId?: string;
  promotionId?: string; // ✅ ШИНЭ — онцлох байрлалын төлбөр (purpose = FEATURED_PROMOTION)
  combinedDepositRentalIds?: string[]; // ✅ ШИНЭ — ORDER_PAYMENT-тэй хамт нэгтгэн төлсөн барьцаанууд
}

/** ✅ ШИНЭ: Төлөв шалгахад (polling, webhook давхар баталгаажуулалт) ашиглах төлбөрийн gateway. */
export function getPaymentGateway(provider: GatewayProvider): PaymentGateway {
  const gateway = PROVIDERS[provider];
  if (!gateway) throw new InvalidProviderError();
  return gateway;
}

export class InvalidProviderError extends Error {
  constructor() {
    super("Provider буруу байна");
    this.name = "InvalidProviderError";
  }
}

export async function createGatewayInvoice(input: CreateInvoiceInput) {
  const gateway = PROVIDERS[input.provider];
  if (!gateway) throw new InvalidProviderError();

  const senderInvoiceNo = `${input.purpose}-${input.orderId || input.rentalDetailId || input.promotionId}-${Date.now()}`;

  const invoice = await gateway.createInvoice({
    senderInvoiceNo,
    amount: input.amount,
    description: input.description,
  });

  const gatewayTx = await prisma.gatewayTransaction.create({
    data: {
      provider: input.provider,
      purpose: input.purpose,
      invoiceId: invoice.invoiceId,
      amount: input.amount,
      status: GatewayTxStatus.PENDING,
      qrText: invoice.qrText,
      qrImageUrl: invoice.qrImageUrl,
      orderId: input.orderId ?? null,
      rentalDetailId: input.rentalDetailId ?? null,
      promotionId: input.promotionId ?? null,
      combinedDepositRentalIds: input.combinedDepositRentalIds ?? [],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  return {
    gatewayTransactionId: gatewayTx.id,
    invoiceId: invoice.invoiceId,
    qrText: invoice.qrText,
    qrImageUrl: invoice.qrImageUrl,
  };
}
