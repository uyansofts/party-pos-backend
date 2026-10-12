// ============================================================================
// ТӨЛБӨРИЙН НАЙДВАРТАЙ БАЙДЛЫН ТЕСТ — давхар webhook, зэрэгцээ хүсэлт, дутуу боловсруулалт, хожуу төлбөр
// Ажиллуулах: npm test   (tsx --test tests/*.test.ts)
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, gateways, load, paymentCount, promotionCalls, behavior, reset, seedGatewayTx, seedOrder, seedProduct, stockMovements, sumPayments } from "./support/harness";

const settlement = load<typeof import("../src/services/gateway-settlement.service")>("services/gateway-settlement.service");
const orderPayment = load<typeof import("../src/services/order-payment.service")>("services/order-payment.service");

beforeEach(() => reset());

const gtxOf = (id: string) => db.get("gatewayTransaction", id)!;
const orderOf = (id: string) => db.get("order", id)!;

test("1. Нэг webhook: захиалга PAID, 1 Payment, нөөц НЭГ удаа хасагдана", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "APPLIED");
  assert.equal(orderOf("o1").paymentStatus, "PAID");
  assert.equal(orderOf("o1").paidAmount, 100);
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
  assert.equal(stockMovements("p-o1").length, 1);
  assert.equal(gtxOf(g.id).status, "PAID");
});

test("2. Дараалан давхар webhook: хоёр дахь нь DUPLICATE, юу ч давхардахгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const a = await settlement.confirmAndSettle(gtxOf(g.id));
  const b = await settlement.confirmAndSettle(db.get("gatewayTransaction", g.id)!); // шинэ уншилт — аль хэдийн PAID
  const c = await settlement.settleGatewayPayment(g.id, {}); // PAID-ыг гараар дахин claim хийх оролдлого
  assert.equal(a.kind, "APPLIED");
  assert.equal(b.kind, "DUPLICATE");
  assert.equal(c.kind, "DUPLICATE");
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
});

test("3. ЗЭРЭГЦЭЭ 5 webhook (бүгд PENDING-г уншсан): яг 1 нь хэрэгжинэ", async () => {
  seedOrder({ id: "o1", total: 100, qty: 3 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const snapshot = gtxOf(g.id); // бүгд "PENDING" гэж уншсан мөчийг дуурайна (check-then-act уралдаан)
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => settlement.confirmAndSettle(snapshot)));
  assert.equal(results.filter((r) => r.kind === "APPLIED").length, 1);
  assert.equal(results.filter((r) => r.kind === "DUPLICATE").length, 4);
  assert.equal(paymentCount("o1"), 1);
  assert.equal(orderOf("o1").paidAmount, 100);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 7);
  assert.equal(stockMovements("p-o1").length, 1);
});

test("4. Webhook + polling (reconcile) зэрэг: давхар бүртгэл байхгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const snapshot = gtxOf(g.id);
  const [a, b] = await Promise.all([settlement.confirmAndSettle(snapshot), settlement.reconcileGatewayTransaction(g.id, Date.now() + 60_000)]);
  assert.equal(paymentCount("o1"), 1);
  assert.equal(orderOf("o1").paymentStatus, "PAID");
  assert.ok(a.kind === "APPLIED" || a.kind === "DUPLICATE");
  assert.equal(b?.id, g.id);
});

test("5. ДУТУУ БОЛОВСРУУЛАЛТ: apply дундаа унавал бүх зүйл буцна, гүйлгээ PENDING, дахин оролдоход нэг л удаа хэрэгжинэ", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  db.failOnce("stockMovement", "create"); // нөөцийн хасалтын үеэр унана
  await assert.rejects(() => settlement.confirmAndSettle(gtxOf(g.id)), /INJECTED_FAILURE/);
  // Rollback: ямар ч хагас бүртгэл үлдэхгүй
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(orderOf("o1").paymentStatus, "PENDING");
  assert.equal(orderOf("o1").paidAmount, 0);
  assert.equal(paymentCount("o1"), 0);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 10);
  // Дахин оролдлого (QPay retry / polling / reconcile)
  const r = await settlement.reconcileGatewayTransaction(g.id, Date.now() + 60_000);
  assert.equal(r?.status, "PAID");
  assert.equal(orderOf("o1").paymentStatus, "PAID");
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
});

test("6. ЦУЦЛАГДСАН захиалгад хожуу төлбөр: захиалга CANCELLED хэвээр, мөнгө refundDue-д, гүйлгээ тэмдэглэгдэнэ", async () => {
  seedOrder({ id: "o1", total: 100, status: "CANCELLED" });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.deepEqual(r, { kind: "UNAPPLIED", reason: "CANCELLED" });
  const o = orderOf("o1");
  assert.equal(o.paymentStatus, "CANCELLED");
  assert.equal(o.paidAmount, 0);
  assert.equal(o.refundDueAmount, 100);
  assert.equal(o.refundedAt, null);
  assert.equal(paymentCount("o1"), 0);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 10); // нөөц хасагдаагүй
  const gt = gtxOf(g.id);
  assert.equal(gt.status, "PAID"); // мөнгө бодитоор орсон
  assert.equal(gt.rawCallback._unapplied.reason, "CANCELLED");
  assert.deepEqual(settlement.toStatusView(gt), { status: "PAID", paidAt: gt.paidAt, applied: false, unappliedReason: "CANCELLED" });
  const listed = await settlement.listUnappliedPayments();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].amount, 100);
  // Дахин ирсэн webhook refundDue-г давхарлахгүй
  await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(orderOf("o1").refundDueAmount, 100);
});

test("7. cancelledAt-тай (төлөв PENDING) захиалга ч төлбөр хүлээн авахгүй", async () => {
  seedOrder({ id: "o1", total: 100, status: "PENDING", cancelledAt: new Date() });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "UNAPPLIED");
  assert.equal(orderOf("o1").paymentStatus, "PENDING");
  assert.equal(paymentCount("o1"), 0);
});

test("8. АЛЬ ХЭДИЙН PAID захиалгад хоёр дахь invoice төлөгдвөл: захиалга ӨӨРЧЛӨГДӨХГҮЙ, UNAPPLIED(ALREADY_PAID)", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g1 = seedGatewayTx({ orderId: "o1", amount: 100 });
  const g2 = seedGatewayTx({ orderId: "o1", amount: 100 });
  await settlement.confirmAndSettle(gtxOf(g1.id));
  const r = await settlement.confirmAndSettle(gtxOf(g2.id));
  assert.deepEqual(r, { kind: "UNAPPLIED", reason: "ALREADY_PAID" });
  assert.equal(orderOf("o1").paidAmount, 100);
  assert.equal(orderOf("o1").refundDueAmount, 0); // PAID захиалгыг REFUNDED болгож болох refundDue-г хөндөхгүй
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8); // нөөц ганц удаа
  assert.equal(gtxOf(g2.id).rawCallback._unapplied.reason, "ALREADY_PAID");
});

test("9. Хэсэгчилсэн төлбөр дараалан: 40 → PARTIALLY_PAID, 60 → PAID, нөөц PAID болох үед л НЭГ удаа", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const g1 = seedGatewayTx({ orderId: "o1", amount: 40 });
  const g2 = seedGatewayTx({ orderId: "o1", amount: 60 });
  await settlement.confirmAndSettle(gtxOf(g1.id));
  assert.equal(orderOf("o1").paymentStatus, "PARTIALLY_PAID");
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 10);
  await settlement.confirmAndSettle(gtxOf(g2.id));
  assert.equal(orderOf("o1").paymentStatus, "PAID");
  assert.equal(orderOf("o1").paidAmount, 100);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
  assert.equal(stockMovements("p-o1").length, 1);
});

test("10. ЗЭРЭГЦЭЭ хоёр өөр гүйлгээ (60 + 60): paidAmount = Payment-ийн нийлбэр (алдагдал байхгүй), нөөц НЭГ удаа", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const g1 = seedGatewayTx({ orderId: "o1", amount: 60 });
  const g2 = seedGatewayTx({ orderId: "o1", amount: 60 });
  const rs = await Promise.all([settlement.confirmAndSettle(gtxOf(g1.id)), settlement.confirmAndSettle(gtxOf(g2.id))]);
  assert.ok(rs.every((r) => r.kind === "APPLIED"));
  const o = orderOf("o1");
  assert.equal(o.paymentStatus, "PAID");
  assert.equal(o.paidAmount, sumPayments("o1"));
  assert.equal(o.paidAmount, 120);
  assert.equal(stockMovements("p-o1").length, 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
});

test("11. Gateway төлсөн дүн нэхэмжлэлээс БАГА: автоматаар хэрэгжүүлэхгүй (UNDERPAID)", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  gateways.QPAY.checkPayment = async (invoiceId) => ({ isPaid: true, raw: { invoiceId }, paidAmount: 50 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "UNDERPAID");
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(paymentCount("o1"), 0);
  // дүн тохирвол хэрэгжинэ
  gateways.QPAY.checkPayment = async (invoiceId) => ({ isPaid: true, raw: { invoiceId }, paidAmount: 100 });
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "APPLIED");
});

test("12. Gateway 'төлөгдөөгүй' гэвэл юу ч өөрчлөгдөхгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  gateways.QPAY.checkPayment = async () => ({ isPaid: false, raw: {} });
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "NOT_PAID");
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(orderOf("o1").paymentStatus, "PENDING");
});

test("13. БҮЛГИЙН төлбөр: 2 захиалга нэг transaction-д хуваарилагдана, нөөц тус бүр НЭГ удаа, давхар webhook-д давхардахгүй", async () => {
  seedOrder({ id: "A", total: 50, groupId: "G" });
  seedOrder({ id: "B", total: 50, groupId: "G" });
  const g = seedGatewayTx({ orderId: "A", amount: 100 });
  const snapshot = gtxOf(g.id);
  const rs = await Promise.all([settlement.confirmAndSettle(snapshot), settlement.confirmAndSettle(snapshot), settlement.confirmAndSettle(snapshot)]);
  assert.equal(rs.filter((r) => r.kind === "APPLIED").length, 1);
  for (const id of ["A", "B"]) {
    assert.equal(orderOf(id).paymentStatus, "PAID");
    assert.equal(orderOf(id).paidAmount, 50);
    assert.equal(paymentCount(id), 1);
    assert.equal(db.get("product", `p-${id}`)!.sellStockQty, 8);
  }
});

test("14. БҮЛГИЙН гишүүн цуцлагдсан бол түүнд төлбөр хуваарилагдахгүй (одоогийн логик хадгалагдана)", async () => {
  seedOrder({ id: "A", total: 50, groupId: "G" });
  seedOrder({ id: "B", total: 50, groupId: "G", status: "CANCELLED" });
  const g = seedGatewayTx({ orderId: "A", amount: 50 });
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "APPLIED");
  assert.equal(orderOf("A").paymentStatus, "PAID");
  assert.equal(orderOf("B").paidAmount, 0);
  assert.equal(paymentCount("B"), 0);
});

test("15. БҮЛГИЙН бүх захиалга аль хэдийн төлөгдсөн: UNAPPLIED, өөрчлөлтгүй", async () => {
  seedOrder({ id: "A", total: 50, paid: 50, status: "PAID", groupId: "G" });
  seedOrder({ id: "B", total: 50, paid: 50, status: "PAID", groupId: "G" });
  const g = seedGatewayTx({ orderId: "A", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.deepEqual(r, { kind: "UNAPPLIED", reason: "ALREADY_PAID" });
  assert.equal(paymentCount("A") + paymentCount("B"), 0);
});

test("16. БҮЛГИЙН transaction дундаа (гишүүн зэрэгцээ цуцлагдвал): БҮХЭЛД нь буцна, гүйлгээ PENDING", async () => {
  seedOrder({ id: "A", total: 50, groupId: "G" });
  seedOrder({ id: "B", total: 50, groupId: "G" });
  const g = seedGatewayTx({ orderId: "A", amount: 100 });
  // A-д төлбөр бичигдэх үед өөр хүсэлт B-г цуцалж commit хийсэн гэж дуурайна
  db.beforeOnce("payment", "create", (_a, d) => {
    d.table("order").get("B")!.paymentStatus = "CANCELLED";
  });
  await assert.rejects(() => settlement.confirmAndSettle(gtxOf(g.id)), /PaymentConflictError|дахин оролдоно уу/);
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(orderOf("A").paidAmount, 0);
  assert.equal(orderOf("A").paymentStatus, "PENDING");
  assert.equal(paymentCount("A"), 0);
});

test("17. БАРЬЦАА: нэг гүйлгээгээр хамт төлсөн барьцаа HELD болно (давхар webhook-д нэг л удаа), хэтэрсэн дүн үндсэн захиалгад", async () => {
  seedOrder({ id: "o1", total: 100 });
  db.seed("rentalDetail", { id: "r1", depositStatus: "PENDING", depositType: "MONEY", depositAmount: 30 });
  const g = seedGatewayTx({ orderId: "o1", amount: 130, combinedDepositRentalIds: ["r1"] });
  const snap = gtxOf(g.id);
  await Promise.all([settlement.confirmAndSettle(snap), settlement.confirmAndSettle(snap)]);
  assert.equal(db.get("rentalDetail", "r1")!.depositStatus, "HELD");
  assert.equal(paymentCount("o1"), 1);
  assert.equal(orderOf("o1").paidAmount, 130);
});

test("18. DEPOSIT: PENDING → HELD, харин буцсан/хураагдсан барьцааг HELD болгож ДАРЖ БИЧИХГҮЙ", async () => {
  db.seed("rentalDetail", { id: "r1", depositStatus: "PENDING", depositAmount: 30 });
  db.seed("rentalDetail", { id: "r2", depositStatus: "FULLY_REFUNDED", depositAmount: 30 });
  const g1 = seedGatewayTx({ purpose: "DEPOSIT", rentalDetailId: "r1", amount: 30 });
  const g2 = seedGatewayTx({ purpose: "DEPOSIT", rentalDetailId: "r2", amount: 30 });
  await Promise.all([settlement.confirmAndSettle(gtxOf(g1.id)), settlement.confirmAndSettle(gtxOf(g2.id))]);
  assert.equal(db.get("rentalDetail", "r1")!.depositStatus, "HELD");
  assert.equal(db.get("rentalDetail", "r2")!.depositStatus, "FULLY_REFUNDED");
});

test("19. ОНЦЛОХ БАЙРЛАЛ: давхар webhook-д нэг л удаа дуудна; унавал гүйлгээг PENDING болгож дахин оролдох боломж олгоно", async () => {
  const g = seedGatewayTx({ purpose: "FEATURED_PROMOTION", promotionId: "promo1", amount: 20000 });
  const snap = gtxOf(g.id);
  await Promise.all([settlement.confirmAndSettle(snap), settlement.confirmAndSettle(snap)]);
  assert.equal(promotionCalls.length, 1);

  const g2 = seedGatewayTx({ purpose: "FEATURED_PROMOTION", promotionId: "promo2", amount: 20000 });
  behavior.promotionFails = 1;
  await assert.rejects(() => settlement.confirmAndSettle(gtxOf(g2.id)), /PROMO_FAIL/);
  assert.equal(gtxOf(g2.id).status, "PENDING"); // claim буцсан
  assert.equal((await settlement.confirmAndSettle(gtxOf(g2.id))).kind, "APPLIED");
  assert.equal(promotionCalls.filter((c) => c.promotionId === "promo2").length, 2);
});

test("20. RECONCILE: webhook ирээгүй PENDING (30 сек+) гүйлгээг сэргээнэ, шинэ гүйлгээг хөндөхгүй", async () => {
  seedOrder({ id: "old", total: 100 });
  seedOrder({ id: "fresh", total: 100 });
  const oldTx = seedGatewayTx({ orderId: "old", amount: 100, createdAt: new Date(Date.now() - 10 * 60_000) });
  const freshTx = seedGatewayTx({ orderId: "fresh", amount: 100, createdAt: new Date() });
  const s = await settlement.reconcilePendingGatewayTransactions();
  assert.equal(s.checked, 1);
  assert.equal(s.applied, 1);
  assert.equal(orderOf("old").paymentStatus, "PAID");
  assert.equal(orderOf("fresh").paymentStatus, "PENDING");
  assert.equal(gtxOf(freshTx.id).status, "PENDING");
  assert.equal(gtxOf(oldTx.id).status, "PAID");
});

test("21. RECONCILE throttle: нэг гүйлгээг 5 секундэд нэгээс олон gateway-ээс асуухгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  let calls = 0;
  gateways.QPAY.checkPayment = async () => (calls++, { isPaid: false, raw: {} });
  const t = Date.now() + 120_000;
  await settlement.reconcileGatewayTransaction(g.id, t);
  await settlement.reconcileGatewayTransaction(g.id, t + 1000);
  await settlement.reconcileGatewayTransaction(g.id, t + 6000);
  assert.equal(calls, 2);
});

test("22. ГАРААР төлөлт: давхар дарвал нэг нь амжилттай, нөгөө нь алдаа; PAID/CANCELLED-д татгалзана", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const results = await Promise.allSettled([
    orderPayment.markOrderPaidManually("o1", { method: "CASH" as any }),
    orderPayment.markOrderPaidManually("o1", { method: "CASH" as any }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rej = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(rej.reason instanceof orderPayment.OrderPaymentError);
  assert.equal(orderOf("o1").paidAmount, 100);
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);

  seedOrder({ id: "c1", total: 100, status: "CANCELLED" });
  await assert.rejects(() => orderPayment.markOrderPaidManually("c1", { method: "CASH" as any }), orderPayment.OrderPaymentError);
  assert.equal(paymentCount("c1"), 0);
});

test("23. applyOrderPayment (шууд): цуцлагдсан захиалгад OrderPaymentError, юу ч бичигдэхгүй", async () => {
  seedOrder({ id: "c1", total: 100, status: "CANCELLED" });
  await assert.rejects(() => orderPayment.applyOrderPayment("c1", 100, "CASH" as any), orderPayment.OrderPaymentError);
  assert.equal(orderOf("c1").refundDueAmount, 0);
  await assert.rejects(() => orderPayment.applyOrderPayment("c1", 0, "CASH" as any), /дүн буруу/);
});

test("24. Олдохгүй захиалгад ирсэн төлбөр: UNAPPLIED(ORDER_NOT_FOUND), гүйлгээ PAID тэмдэгтэй", async () => {
  const g = seedGatewayTx({ orderId: "ghost", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.deepEqual(r, { kind: "UNAPPLIED", reason: "ORDER_NOT_FOUND" });
  assert.equal(gtxOf(g.id).rawCallback._unapplied.reason, "ORDER_NOT_FOUND");
});

test("25. FAILED/EXPIRED төлөвтэй гүйлгээнд мөнгө ирсэн нь баталгаажвал хэрэгжинэ (мөнгө алдахгүй)", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100, status: "EXPIRED" });
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "APPLIED");
  assert.equal(orderOf("o1").paymentStatus, "PAID");
});

void seedProduct;
