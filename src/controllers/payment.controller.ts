// ============================================================================
// PAYMENT CONTROLLER (TypeScript) — Schema v2-т тааруулсан
// ----------------------------------------------------------------------------
// ӨӨРЧЛӨГДСӨН ТАЛБАРУУД (v1 → v2):
//   Order.status         → Order.paymentStatus (PayStatus)
//   Order.channel         → Order.orderType (OrderType: POS/ONLINE)
//   Product.stockQuantity → Product.sellStockQty
//   PaymentMethod-д SOCIALPAY АЛЬ ХЭДИЙН орсон тул ternary заль хэрэггүй болсон
// ============================================================================

import { Router, Request, Response } from "express";
import {
  GatewayProvider,
  GatewayPurpose,
  GatewayTxStatus,
  PayStatus,
  OrderType,
  PaymentType,
  PaymentMethod,
  StockMovementType,
} from "@prisma/client";
import { prisma } from "../lib/prisma";

import { qpayService } from "../services/qpay.service";
import { socialpayService } from "../services/socialpay.service";
import { mockGatewayService } from "../services/mock-gateway.service";
import { createGatewayInvoice, InvalidProviderError } from "../services/invoice.service";
import { applyOrderPayment } from "../services/order-payment.service";
import * as depositService from "../services/deposit.service";
import { emitToStore } from "../realtime/socket";
import { requireAuth } from "../middleware/auth.middleware";
import type { PaymentGateway, NewOnlineOrderPayload } from "../types/payment.types";
import { applyPromotionPayment } from "../services/featured.service"; // ✅ ШИНЭ — онцлох байрлалын төлбөр

const router = Router();

// ---------------------------------------------------------------------------
// MOCK GATEWAY: .env дотор USE_MOCK_GATEWAY=true үед бодит QPay/SocialPay
// API-г ДУУДАХГҮЙ, үргэлж "PAID" гэж хариулдаг хуурамч gateway ашиглана.
// Постман/curl-аар webhook симуляц хийхэд ЗААВАЛ шаардлагатай. (Webhook
// боловсруулалтад доор ШУУД ашиглагдана — invoice үүсгэх хэсэг нь одоо
// invoice.service.ts руу шилжсэн тул энд зөвхөн checkPayment-д хэрэгтэй.)
// ---------------------------------------------------------------------------
const USE_MOCK = process.env.USE_MOCK_GATEWAY === "true" && process.env.NODE_ENV !== "production";

const PROVIDERS: Record<GatewayProvider, PaymentGateway> = {
  QPAY: USE_MOCK ? mockGatewayService : qpayService,
  SOCIALPAY: USE_MOCK ? mockGatewayService : socialpayService,
};

// ============================================================================
// 1. НЭХЭМЖЛЭЛ (Invoice/QR) ҮҮСГЭХ
//    POST /api/payments/invoice
// ----------------------------------------------------------------------------
// ✅ REFACTOR: Жинхэнэ логик одоо src/services/invoice.service.ts дотор
// нэгтгэгдсэн (Staff болон Public (нээлттэй) хоёр endpoint ЯГ ИЖИЛ энэ
// функцийг дуудна — MOCK_GATEWAY зэрэг чухал шалгалт 2 газар давхардахгүй).
// ============================================================================
interface CreateInvoiceBody {
  provider: GatewayProvider;
  purpose: GatewayPurpose;
  orderId?: string;
  rentalDetailId?: string;
  amount: number;
  description: string;
  combinedDepositRentalIds?: string[]; // ✅ ШИНЭ
}

router.post("/invoice", requireAuth, async (req: Request<{}, {}, CreateInvoiceBody>, res: Response) => {
  try {
    const result = await createGatewayInvoice(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidProviderError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Invoice үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Invoice үүсгэж чадсангүй" });
  }
});

// ============================================================================
// 2 & 3. WEBHOOK — QPay / SocialPay
// ----------------------------------------------------------------------------
// ⚠️ ЭНЭ 2 ROUTE-Д requireAuth ХЭЗЭЭ Ч БҮҮ НЭМ — QPay/SocialPay манай
// JWT-г мэдэхгүй тул callback-аа энгийн (public) байдлаар илгээдэг.
// ============================================================================
router.post("/webhook/qpay", async (req: Request, res: Response) => {
  try {
    await handleGatewayWebhook(GatewayProvider.QPAY, req);
  } catch (err) {
    console.error("QPay webhook алдаа:", err);
  }
  res.status(200).send("OK"); // Provider-т ЯМАРЧ тохиолдолд 200 буцаана (retry storm-оос сэргийлнэ)
});

router.post("/webhook/socialpay", async (req: Request, res: Response) => {
  try {
    await handleGatewayWebhook(GatewayProvider.SOCIALPAY, req);
  } catch (err) {
    console.error("SocialPay webhook алдаа:", err);
  }
  res.status(200).send("OK");
});

async function handleGatewayWebhook(provider: GatewayProvider, req: Request): Promise<void> {
  const invoiceId: string | undefined =
    req.body.invoice_id || req.body.object_id || (req.query.invoiceId as string | undefined);

  if (!invoiceId) {
    console.warn(`${provider} webhook: invoice_id олдсонгүй`, req.body);
    return;
  }

  const gatewayTx = await prisma.gatewayTransaction.findUnique({ where: { invoiceId } });
  if (!gatewayTx) {
    console.warn(`${provider} webhook: GatewayTransaction олдсонгүй`, invoiceId);
    return;
  }

  // Idempotency: аль хэдийн PAID бол дахин боловсруулахгүй
  if (gatewayTx.status === GatewayTxStatus.PAID) return;

  // Давхар баталгаажуулалт — webhook-д ганцаараа найдахгүй
  const gateway = PROVIDERS[provider];
  const { isPaid, raw } = await gateway.checkPayment(invoiceId);
  if (!isPaid) {
    console.warn(`${provider} webhook ирсэн ч checkPayment баталгаажуулж чадсангүй`, invoiceId);
    return;
  }

  const updated = await prisma.gatewayTransaction.update({
    where: { id: gatewayTx.id },
    data: { status: GatewayTxStatus.PAID, paidAt: new Date(), rawCallback: raw as object },
  });

  if (updated.purpose === GatewayPurpose.ORDER_PAYMENT && updated.orderId) {
    const paymentMethod = provider === GatewayProvider.QPAY ? PaymentMethod.QPAY : PaymentMethod.SOCIALPAY;
    await applyOrderPayment(
      updated.orderId,
      Number(updated.amount),
      paymentMethod,
      undefined,
      updated.combinedDepositRentalIds
    );
  } else if (updated.purpose === GatewayPurpose.DEPOSIT && updated.rentalDetailId) {
    await depositService.markDepositPaid(updated.rentalDetailId, updated.id);
  } else if (updated.purpose === GatewayPurpose.FEATURED_PROMOTION && updated.promotionId) {
    // ✅ ШИНЭ: Онцлох байрлалын төлбөр → байрлалыг баталгаажуулж, идэвхжүүлнэ (давхар/хоцорсон төлбөрийг сервис өөрөө зохицуулна)
    await applyPromotionPayment(updated.promotionId, Number(updated.amount), provider === GatewayProvider.QPAY ? "QPAY" : "SOCIALPAY");
  }
}

/**
 * Захиалгын үндсэн төлбөр орж ирэхэд Order.paymentStatus шинэчилж,
 * ONLINE суваг байвал ПОС апп руу realtime мэдэгдэл илгээнэ.
 */
// ✅ REFACTOR: applyOrderPayment одоо src/services/order-payment.service.ts
// дотор нэгтгэгдсэн (webhook болон гараар баталгаажуулах хоёулаа ашиглана).

// ============================================================================
// 4. ТӨЛБӨРИЙН ТӨЛӨВ ШАЛГАХ (Flutter polling)
//    GET /api/payments/status/:gatewayTransactionId
// ============================================================================
router.get("/status/:gatewayTransactionId", requireAuth, async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  const tx = await prisma.gatewayTransaction.findUnique({
    where: { id: req.params.gatewayTransactionId },
  });
  if (!tx) return res.status(404).json({ error: "Олдсонгүй" });

  res.json({ status: tx.status, paidAt: tx.paidAt });
});

export default router;
