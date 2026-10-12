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
import { assertOrdersStockAvailable } from "./stock.service";
import { InsufficientStockError } from "../lib/stock-guards";
import { assertOrdersMaterialsAvailable } from "./material.service";
import { qpayService } from "./qpay.service";
import { socialpayService } from "./socialpay.service";
import { mockGatewayService } from "./mock-gateway.service";
import type { PaymentGateway } from "../types/payment.types";
import { getGroupRemaining } from "./order-payment.service";
import { InvalidInvoiceError, PAYABLE_STATUSES, checkDepositInvoiceAmount, checkOrderInvoiceAmount, isValidMoneyAmount } from "../lib/payment-guards";

export { InvalidInvoiceError };


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

/**
 * ✅ ШИНЭ: Invoice-ийн дүн, зорилгыг СЕРВЕР талд баталгаажуулна (клиентийн илгээсэн amount-д итгэхгүй).
 *  - ORDER_PAYMENT: захиалга төлбөр хүлээн авах төлөвтэй (цуцлагдаагүй, төлөгдөөгүй) бөгөөд дүн ≤ үлдэгдэл (+ хамт төлөх барьцаа).
 *    Бүлгийн захиалгад үлдэгдэл = сагсны нийт үлдэгдэл.
 *  - DEPOSIT: барьцаа PENDING төлөвтэй, дүн нь барьцааны дүнтэй тэнцүү.
 *  - FEATURED_PROMOTION: дүнг онцлох байрлалын сервис өөрөө тооцдог — энд зөвхөн дүнгийн хэлбэрийг шалгана.
 */
async function assertInvoiceAllowed(input: CreateInvoiceInput): Promise<void> {
  if (!isValidMoneyAmount(input.amount)) throw new InvalidInvoiceError("Төлбөрийн дүн буруу байна");

  if (input.purpose === GatewayPurpose.ORDER_PAYMENT) {
    if (!input.orderId) throw new InvalidInvoiceError("orderId шаардлагатай");
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, paymentStatus: true, cancelledAt: true, totalAmount: true, paidAmount: true, orderGroupId: true },
    });
    if (!order) throw new InvalidInvoiceError("Захиалга олдсонгүй");
    if (order.cancelledAt || !(PAYABLE_STATUSES as readonly string[]).includes(order.paymentStatus)) {
      throw new InvalidInvoiceError(`Энэ захиалга "${order.paymentStatus}" төлөвт байгаа тул төлбөр хүлээн авах боломжгүй`);
    }
    const groupLeft = await getGroupRemaining(order.id);
    const remaining = groupLeft ?? Number(order.totalAmount) - Number(order.paidAmount);

    // Хамт төлөх барьцаа: ЗӨВХӨН энэ захиалга (эсвэл сагсны) түрээсийн барьцаа байх ёстой.
    let combinedDeposit = 0;
    const ids = Array.from(new Set(input.combinedDepositRentalIds ?? []));
    if (ids.length > 0) {
      const rentals = await prisma.rentalDetail.findMany({
        where: { id: { in: ids }, orderItem: order.orderGroupId ? { order: { orderGroupId: order.orderGroupId } } : { orderId: order.id } },
        select: { depositAmount: true },
      });
      if (rentals.length !== ids.length) throw new InvalidInvoiceError("Барьцааны мэдээлэл энэ захиалгатай таарахгүй байна");
      combinedDeposit = rentals.reduce((sum, r) => sum + Number(r.depositAmount), 0);
    }
    checkOrderInvoiceAmount(input.amount, remaining, combinedDeposit);

    // ✅ F7: нөөц дууссан захиалгад нэхэмжлэл үүсгэхгүй (хэрэглэгч төлчихөөд баталгаажихгүй байхаас сэргийлнэ)
    const memberIds = order.orderGroupId ? (await prisma.order.findMany({ where: { orderGroupId: order.orderGroupId }, select: { id: true } })).map((o) => o.id) : [order.id];
    try {
      await assertOrdersStockAvailable(prisma, memberIds);
      await assertOrdersMaterialsAvailable(prisma, memberIds);
    } catch (err) {
      if (err instanceof InsufficientStockError) throw new InvalidInvoiceError(err.message);
      throw err;
    }
  } else if (input.purpose === GatewayPurpose.DEPOSIT) {
    if (!input.rentalDetailId) throw new InvalidInvoiceError("rentalDetailId шаардлагатай");
    const rental = await prisma.rentalDetail.findUnique({ where: { id: input.rentalDetailId }, select: { depositAmount: true, depositStatus: true } });
    if (!rental) throw new InvalidInvoiceError("Түрээсийн мэдээлэл олдсонгүй");
    if (rental.depositStatus !== "PENDING") throw new InvalidInvoiceError(`Барьцаа "${rental.depositStatus}" төлөвт байгаа тул төлбөр шаардахгүй`);
    checkDepositInvoiceAmount(input.amount, Number(rental.depositAmount));
  }
}

export async function createGatewayInvoice(rawInput: CreateInvoiceInput) {
  const input: CreateInvoiceInput = { ...rawInput, amount: Number(rawInput.amount) }; // клиент "5000" (string) илгээсэн ч тоо болгоно
  const gateway = PROVIDERS[input.provider];
  if (!gateway) throw new InvalidProviderError();
  await assertInvoiceAllowed(input);

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
      senderInvoiceNo, // callback (GET ?senderInvoiceNo=...) ирэхэд гүйлгээг олох түлхүүр
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
