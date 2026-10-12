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
import { GatewayProvider, GatewayPurpose } from "@prisma/client";
import { prisma } from "../lib/prisma";

import { createGatewayInvoice, InvalidProviderError, InvalidInvoiceError } from "../services/invoice.service";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import { resolveWebhookKeys } from "../lib/gateway-webhook";
import {
  processGatewayWebhook,
  listUnappliedPayments,
  reconcileGatewayTransaction,
  reconcilePendingGatewayTransactions,
  authorizeStaffForGatewayTx,
  toStatusView,
} from "../services/gateway-settlement.service";

const router = Router();

// MOCK GATEWAY (USE_MOCK_GATEWAY=true, production-д хэзээ ч асахгүй) нь одоо invoice.service.ts-ийн getPaymentGateway()-д НЭГ газар төвлөрсөн —
// webhook/polling/reconcile бүгд ижил gateway-г ашиглана.

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
    if (err instanceof InvalidProviderError || err instanceof InvalidInvoiceError) {
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
// QPay callback-ийг БОДИТ нь GET-ээр (callback_url-д манай нэмсэн ?senderInvoiceNo=... + QPay-ийн qpay_payment_id-тай) илгээдэг; зарим тохиргоо POST ч ашигладаг — хоёуланг хүлээнэ.
// QPay "SUCCESS" (200) хариу хүлээдэг. Ямар ч тохиолдолд 200 буцаана (retry storm-оос сэргийлнэ).
const qpayCallback = async (req: Request, res: Response) => {
  try {
    await handleGatewayWebhook(GatewayProvider.QPAY, req);
  } catch (err) {
    console.error("QPay webhook алдаа:", err);
  }
  res.status(200).send("SUCCESS");
};
router.get("/webhook/qpay", qpayCallback);
router.post("/webhook/qpay", qpayCallback);

router.post("/webhook/socialpay", async (req: Request, res: Response) => {
  try {
    await handleGatewayWebhook(GatewayProvider.SOCIALPAY, req);
  } catch (err) {
    console.error("SocialPay webhook алдаа:", err);
  }
  res.status(200).send("OK");
});

async function handleGatewayWebhook(provider: GatewayProvider, req: Request): Promise<void> {
  // Түлхүүр: invoice_id (body/query) эсвэл манай senderInvoiceNo (callback URL-ийн query). Буруу тэмдэгт/объект → алгасна;
  // нэг түлхүүр олон өөр утгатай (invoice_id ≠ object_id г.м) бол conflict.
  const keys = resolveWebhookKeys(req.body, req.query);

  // processGatewayWebhook: (1) invoiceId/senderInvoiceNo хоёр өөр гүйлгээ заавал / нэг нь танигдахгүй бол ТАТГАЛЗАНА,
  // (2) gatewayTx.provider !== provider бол ШУУД ЗОГСООНО (checkPayment хийхгүй, юу ч бичихгүй),
  // (3) үгүй бол gateway-ээс ДАХИН баталгаажуулж (дүн шалгаж) НЭГ transaction-д claim+apply (idempotent; apply унавал PENDING хэвээр → reconcile).
  const r = await processGatewayWebhook(provider, keys);
  if (r.kind === "NOT_PAID") console.warn(`${provider} webhook ирсэн ч checkPayment баталгаажуулж чадсангүй`);
  else if (r.kind === "UNDERPAID" || r.kind === "UNVERIFIABLE_AMOUNT") console.warn(`${provider} webhook: ${r.kind} — автоматаар хэрэгжүүлсэнгүй (PENDING), Staff шалгана`);
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
router.get("/status/:gatewayTransactionId", requireRole("ADMIN", "CASHIER"), async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    // Эрх: идэвхтэй ажилтан (ADMIN/CASHIER) БА захиалгын гүйлгээ бол ЗӨВХӨН өөрийн салбарын (storeId) захиалгынх.
    const access = await authorizeStaffForGatewayTx(req.staff!, req.params.gatewayTransactionId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // PENDING байвал gateway-ээс шалгаж (5 сек-д нэгээс олонгүй) төлөгдсөн бол хэрэгжүүлнэ — webhook ирээгүй/унасан үед Flutter polling төлбөрийг сэргээнэ.
    const tx = await reconcileGatewayTransaction(req.params.gatewayTransactionId);
    if (!tx) return res.status(404).json({ error: "Олдсонгүй" });
    res.json(toStatusView(tx));
  } catch (err) {
    console.error("Төлбөрийн төлөв алдаа:", err);
    res.status(500).json({ error: "Төлөв шалгаж чадсангүй" });
  }
});

// ============================================================================
// 5. RECONCILE — webhook ирээгүй / боловсруулалт унасан PENDING гүйлгээг сэргээх (Staff гараар дуудна)
//    POST /api/payments/reconcile
// ============================================================================
// ADMIN: олон гүйлгээг gateway-ээс асууж мөнгөн бүртгэл өөрчилдөг, өндөр эрсдэлтэй ажиллагаа (кассчинд хаалттай).
router.post("/reconcile", requireRole("ADMIN"), async (_req: Request, res: Response) => {
  try {
    res.json(await reconcilePendingGatewayTransactions());
  } catch (err) {
    console.error("Reconcile алдаа:", err);
    res.status(500).json({ error: "Reconcile хийж чадсангүй" });
  }
});

// ============================================================================
// 6. ХЭРЭГЖҮҮЛЖ БОЛООГҮЙ ТӨЛБӨРҮҮД — мөнгө орсон, гэхдээ захиалга цуцлагдсан/аль хэдийн төлөгдсөн (Staff шалгаж буцаана)
//    GET /api/payments/unapplied
// ============================================================================
router.get("/unapplied", requireRole("ADMIN", "CASHIER"), async (_req: Request, res: Response) => {
  try {
    res.json(await listUnappliedPayments());
  } catch (err) {
    console.error("Unapplied жагсаалт алдаа:", err);
    res.status(500).json({ error: "Жагсаалт авч чадсангүй" });
  }
});

export default router;
