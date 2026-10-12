// Төлбөрийн аюулгүй байдлын regression: provider зөрүү, дүн (байхгүй/буруу/бага/илүү), түлхүүр зөрчил, эрх, давхар/зэрэгцээ callback, сэргээлт
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { db, gateways, load, paymentCount, reset, seedGatewayTx, seedOrder } from "./support/harness";

const settlement = load<typeof import("../src/services/gateway-settlement.service")>("services/gateway-settlement.service");
const webhook = load<typeof import("../src/lib/gateway-webhook")>("lib/gateway-webhook");
const guards = load<typeof import("../src/lib/payment-guards")>("lib/payment-guards");

beforeEach(() => reset());

const gtxOf = (id: string) => db.get("gatewayTransaction", id)!;
const orderOf = (id: string) => db.get("order", id)!;
let checks = 0;
const payWith = (paidAmount: unknown) => {
  gateways.QPAY.checkPayment = async (invoiceId) => {
    checks++;
    return { isPaid: true, raw: { invoiceId }, paidAmount: paidAmount as any };
  };
};
beforeEach(() => { checks = 0; });

// ------------------------------- assessPaidAmount (цэвэр бодлого) -------------------------------
test("assessPaidAmount: байхгүй/буруу → UNVERIFIABLE; бага → UNDERPAID; тэнцүү → EXACT; илүү → OVERPAID (центээр)", () => {
  const a = guards.assessPaidAmount;
  for (const bad of [undefined, null]) assert.equal(a(100, bad).kind, "UNVERIFIABLE");
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, "100", {}, [], true, 2_000_000_000]) assert.equal(a(100, bad as any).kind, "UNVERIFIABLE", String(bad));
  assert.equal(a(0, 100).kind, "UNVERIFIABLE"); // нэхэмжилсэн дүн өөрөө хүчингүй
  assert.equal(a(NaN, 100).kind, "UNVERIFIABLE");
  assert.deepEqual(a(100, 99.99), { kind: "UNDERPAID", shortfall: 0.01 });
  assert.deepEqual(a(100, 100), { kind: "EXACT" });
  assert.deepEqual(a(0.3, 0.1 + 0.2), { kind: "EXACT" }); // хөвөгч таслалын алдаа
  assert.deepEqual(a(100, 150.5), { kind: "OVERPAID", excess: 50.5 });
});

// ------------------------------- Дүн: байхгүй / буруу -------------------------------
for (const [name, val] of [["байхгүй (undefined)", undefined], ["NaN", NaN], ["0", 0], ["сөрөг", -100], ["Infinity", Infinity], ["тэмдэгт мөр", "100"]] as const) {
  test(`Дүн ${name}: ХЭЗЭЭ Ч хэрэгжихгүй — UNVERIFIABLE_AMOUNT, гүйлгээ PENDING, захиалга PENDING`, async () => {
    seedOrder({ id: "o1", total: 100 });
    const g = seedGatewayTx({ orderId: "o1", amount: 100 });
    payWith(val);
    const r = await settlement.confirmAndSettle(gtxOf(g.id));
    assert.equal(r.kind, "UNVERIFIABLE_AMOUNT");
    assert.equal(gtxOf(g.id).status, "PENDING");
    assert.equal(orderOf("o1").paymentStatus, "PENDING");
    assert.equal(paymentCount("o1"), 0);
    assert.equal(db.get("product", "p-o1")!.sellStockQty, 10);
  });
}

test("UNVERIFIABLE дараа нь сэргэнэ: gateway дүнг мэдээлмэгц reconcile хэрэгжүүлнэ (түгжигдэхгүй)", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100, createdAt: new Date(Date.now() - 120_000) });
  payWith(undefined);
  const s1 = await settlement.reconcilePendingGatewayTransactions();
  assert.equal(s1.unverifiable, 1);
  assert.equal(gtxOf(g.id).status, "PENDING");
  payWith(100);
  const s2 = await settlement.reconcilePendingGatewayTransactions();
  assert.equal(s2.applied, 1);
  assert.equal(gtxOf(g.id).status, "PAID");
  assert.equal(orderOf("o1").paymentStatus, "PAID");
});

// ------------------------------- Бага / илүү төлөлт -------------------------------
test("Дутуу төлөлт: хэрэгжихгүй, PENDING; reconcile-д underpaid гэж тоологдоно", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100, createdAt: new Date(Date.now() - 120_000) });
  payWith(99.99);
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "UNDERPAID");
  const s = await settlement.reconcilePendingGatewayTransactions();
  assert.equal(s.underpaid, 1);
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(paymentCount("o1"), 0);
});

test("Илүү төлөлт (150 vs 100): захиалга ЯГ 100-аар PAID болно, илүү 50 refundDue-д, гүйлгээнд _overpaid тэмдэг", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(150);
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.deepEqual(r, { kind: "APPLIED", overpaid: 50 });
  assert.equal(orderOf("o1").paymentStatus, "PAID");
  assert.equal(orderOf("o1").paidAmount, 100); // хэтрүүлж бүртгэхгүй
  assert.equal(orderOf("o1").refundDueAmount, 50);
  assert.equal((gtxOf(g.id).rawCallback as any)._overpaid.excess, 50);
  assert.equal(paymentCount("o1"), 1);
});

test("Илүү төлөлт + цуцлагдсан захиалга: нэхэмжилсэн дүн + илүү нь хоёул refundDue-д (нийт 150)", async () => {
  seedOrder({ id: "o1", total: 100, status: "CANCELLED" });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(150);
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "UNAPPLIED");
  assert.equal(orderOf("o1").refundDueAmount, 150);
  assert.equal(orderOf("o1").paymentStatus, "CANCELLED");
});

test("Илүү төлөлт + нөөц дутсан: бүгд (150) refundDue-д, захиалга PENDING", async () => {
  seedOrder({ id: "o1", total: 100, qty: 99 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(150);
  const r: any = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "UNAPPLIED");
  assert.equal(r.reason, "INSUFFICIENT_STOCK");
  assert.equal(orderOf("o1").refundDueAmount, 150);
  assert.equal(orderOf("o1").paymentStatus, "PENDING");
});

// ------------------------------- Provider зөрүү -------------------------------
test("Provider зөрүү: QPAY webhook-д SOCIALPAY гүйлгээ → ШУУД зогсоно, gateway-д огт хандахгүй, юу ч өөрчлөгдөхгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100, provider: "SOCIALPAY" });
  payWith(100);
  const r = await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(g.id).invoiceId });
  assert.deepEqual(r, { kind: "IGNORED", reason: "PROVIDER_MISMATCH" });
  assert.equal(checks, 0);
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal(paymentCount("o1"), 0);
  // зөв provider-оор ирвэл хэрэгжинэ
  gateways.SOCIALPAY.checkPayment = async (invoiceId) => ({ isPaid: true, raw: { invoiceId }, paidAmount: 100 });
  assert.equal((await settlement.processGatewayWebhook("SOCIALPAY" as any, { invoiceId: gtxOf(g.id).invoiceId })).kind, "APPLIED");
});

// ------------------------------- Түлхүүр таарахгүй / тодорхойгүй -------------------------------
test("invoiceId болон senderInvoiceNo ӨӨР гүйлгээнүүд заавал → AMBIGUOUS_MATCH, хоёуланд нь хүрэхгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  seedOrder({ id: "o2", total: 100 });
  const a = seedGatewayTx({ orderId: "o1", amount: 100 });
  const b = seedGatewayTx({ orderId: "o2", amount: 100 });
  payWith(100);
  const r = await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(a.id).invoiceId, senderInvoiceNo: gtxOf(b.id).senderInvoiceNo });
  assert.deepEqual(r, { kind: "IGNORED", reason: "AMBIGUOUS_MATCH" });
  assert.equal(checks, 0);
  assert.equal(gtxOf(a.id).status, "PENDING");
  assert.equal(gtxOf(b.id).status, "PENDING");
});

test("Нэг түлхүүр танигдахгүй (нөгөө нь олдсон) → татгалзана; хоёул ижил гүйлгээг заавал → хэрэгжинэ", async () => {
  seedOrder({ id: "o1", total: 100 });
  const a = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(100);
  assert.deepEqual(await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(a.id).invoiceId, senderInvoiceNo: "UNKNOWN-123" }), { kind: "IGNORED", reason: "AMBIGUOUS_MATCH" });
  assert.deepEqual(await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: "NOPE-1" }), { kind: "IGNORED", reason: "NOT_FOUND" });
  assert.deepEqual(await settlement.processGatewayWebhook("QPAY" as any, {}), { kind: "IGNORED", reason: "NO_KEYS" });
  assert.equal(gtxOf(a.id).status, "PENDING");
  const ok = await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(a.id).invoiceId, senderInvoiceNo: gtxOf(a.id).senderInvoiceNo });
  assert.equal(ok.kind, "APPLIED");
});

test("resolveWebhookKeys: invoice_id ≠ object_id, давхар query утга → conflict; ижил утга/нэг эх сурвалж → хэвийн", () => {
  assert.equal(webhook.resolveWebhookKeys({ invoice_id: "AAA-111", object_id: "BBB-222" }, {}).conflict, true);
  assert.equal(webhook.resolveWebhookKeys({}, { senderInvoiceNo: ["S-111", "S-222"] }).conflict, true);
  assert.equal(webhook.resolveWebhookKeys({ invoice_id: "AAA-111" }, { invoice_id: "BBB-222" }).conflict, true);
  assert.deepEqual(webhook.resolveWebhookKeys({ invoice_id: "AAA-111", object_id: "AAA-111" }, { senderInvoiceNo: "S-111" }), { invoiceId: "AAA-111", senderInvoiceNo: "S-111" });
  assert.deepEqual(webhook.resolveWebhookKeys({ invoice_id: "bad value!" }, {}), {}); // хүчингүй тэмдэгт алгасагдана
  assert.equal(webhook.resolveWebhookKeys({ invoice_id: "AAA-111", object_id: "bad value!" }, {}).conflict, undefined);
});

test("conflict=true түлхүүр → CONFLICTING_KEYS, DB-д хандахгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  const a = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(100);
  const r = await settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(a.id).invoiceId, conflict: true });
  assert.deepEqual(r, { kind: "IGNORED", reason: "CONFLICTING_KEYS" });
  assert.equal(checks, 0);
});

// ------------------------------- Давхар / зэрэгцээ callback -------------------------------
test("Давхар callback (дараалан): 1-р APPLIED, 2-р DUPLICATE; төлбөр, нөөц нэг удаа", async () => {
  seedOrder({ id: "o1", total: 100, qty: 2 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(100);
  const keys = { invoiceId: gtxOf(g.id).invoiceId };
  assert.equal((await settlement.processGatewayWebhook("QPAY" as any, keys)).kind, "APPLIED");
  assert.equal((await settlement.processGatewayWebhook("QPAY" as any, keys)).kind, "DUPLICATE");
  assert.equal(paymentCount("o1"), 1);
  assert.equal(db.get("product", "p-o1")!.sellStockQty, 8);
});

test("Зэрэгцээ 6 callback (invoiceId ба senderInvoiceNo холимог): яг 1 APPLIED, нэг л төлбөр; илүү төлөлт ч нэг л удаа refundDue-д", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  payWith(130);
  const row = gtxOf(g.id);
  const calls = [1, 2, 3].flatMap(() => [{ invoiceId: row.invoiceId }, { senderInvoiceNo: row.senderInvoiceNo }]);
  const rs = await Promise.all(calls.map((k) => settlement.processGatewayWebhook("QPAY" as any, k)));
  assert.equal(rs.filter((r) => r.kind === "APPLIED").length, 1);
  assert.equal(rs.filter((r) => r.kind === "DUPLICATE").length, 5);
  assert.equal(paymentCount("o1"), 1);
  assert.equal(orderOf("o1").refundDueAmount, 30);
});

// ------------------------------- Сэргээлт: apply унавал -------------------------------
test("Захиалгад хэрэгжүүлэх үед унавал claim ч буцна (гүйлгээ PENDING), дараагийн webhook/reconcile сэргээнэ", async () => {
  seedOrder({ id: "o1", total: 100 });
  const g = seedGatewayTx({ orderId: "o1", amount: 100, createdAt: new Date(Date.now() - 120_000) });
  payWith(100);
  db.failOnce("payment", "create");
  await assert.rejects(() => settlement.processGatewayWebhook("QPAY" as any, { invoiceId: gtxOf(g.id).invoiceId }));
  assert.equal(gtxOf(g.id).status, "PENDING"); // PAID хэвээр гацаагүй
  assert.equal(paymentCount("o1"), 0);
  assert.equal(orderOf("o1").paymentStatus, "PENDING");
  const s = await settlement.reconcilePendingGatewayTransactions();
  assert.equal(s.applied, 1);
  assert.equal(gtxOf(g.id).status, "PAID");
  assert.equal(paymentCount("o1"), 1);
});

test("Онцлох байрлалын төлбөр унавал гүйлгээ PENDING болж буцаж, дахин оролдоход хэрэгжинэ", async () => {
  const g = seedGatewayTx({ amount: 100, purpose: "FEATURED_PROMOTION", promotionId: "promo1" });
  payWith(100);
  const { behavior } = await import("./support/harness");
  behavior.promotionFails = 1;
  await assert.rejects(() => settlement.confirmAndSettle(gtxOf(g.id)));
  assert.equal(gtxOf(g.id).status, "PENDING");
  assert.equal((await settlement.confirmAndSettle(gtxOf(g.id))).kind, "APPLIED");
});

// ------------------------------- Эрх: эзэмшил ба role -------------------------------
test("authorizeStaffForGatewayTx: өөр салбарын захиалгын гүйлгээ → 403; өөрийн салбар → ok; олдохгүй → 404; storeId-гүй токен → 403", async () => {
  seedOrder({ id: "o1", total: 100 });
  db.seed("order", { ...orderOf("o1"), storeId: "branchA" });
  const g = seedGatewayTx({ orderId: "o1", amount: 100 });
  assert.deepEqual(await settlement.authorizeStaffForGatewayTx({ staffId: "s", storeId: "branchB" }, g.id), { ok: false, status: 403, error: "Энэ гүйлгээнд хандах эрхгүй байна" });
  assert.equal((await settlement.authorizeStaffForGatewayTx({ staffId: "s" }, g.id)).ok, false);
  assert.deepEqual(await settlement.authorizeStaffForGatewayTx({ staffId: "s", storeId: "branchA" }, g.id), { ok: true });
  const r: any = await settlement.authorizeStaffForGatewayTx({ staffId: "s", storeId: "branchA" }, "nope");
  assert.equal(r.status, 404);
});

test("Эх кодын бодлого: /status нь requireRole(ADMIN,CASHIER)+эзэмшил, /reconcile нь ЗӨВХӨН ADMIN, /unapplied нь requireRole; webhook нээлттэй", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/controllers/payment.controller.ts"), "utf8");
  assert.match(src, /router\.get\("\/status\/:gatewayTransactionId",\s*requireRole\("ADMIN",\s*"CASHIER"\)/);
  assert.match(src, /authorizeStaffForGatewayTx\(req\.staff!/);
  assert.match(src, /router\.post\("\/reconcile",\s*requireRole\("ADMIN"\)/);
  assert.match(src, /router\.get\("\/unapplied",\s*requireRole\("ADMIN",\s*"CASHIER"\)/);
  assert.doesNotMatch(src, /router\.(get|post)\("\/webhook[^"]*",\s*require/);
  assert.doesNotMatch(src, /gatewayTx\.provider !== provider[\s\S]{0,80}баталгаажуулна/); // хуучин "үргэлжлүүлнэ" логик байхгүй
});

test("Эрхгүй хандалт: нэвтрээгүй → 401, идэвхгүй ажилтан → 401, CASHIER → /reconcile (ADMIN) 403", async () => {
  const mw = load<typeof import("../src/middleware/auth.middleware")>("middleware/auth.middleware");
  const call = (handler: any, token?: string) =>
    new Promise<{ status: number; next: boolean }>((resolve) => {
      const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
      const out = { status: 200, next: false };
      const res: any = { status(c: number) { out.status = c; return res; }, json() { resolve(out); return res; } };
      handler(req, res, () => { out.next = true; resolve(out); });
    });
  db.seed("staff", { id: "csh", role: "CASHIER", isActive: true });
  db.seed("staff", { id: "off", role: "CASHIER", isActive: false });
  db.seed("staff", { id: "adm", role: "ADMIN", isActive: true });
  assert.equal((await call(mw.requireRole("ADMIN"))).status, 401);
  assert.equal((await call(mw.requireRole("ADMIN", "CASHIER"), "staff:off")).status, 401);
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:csh")).status, 403);
  assert.equal((await call(mw.requireRole("ADMIN", "CASHIER"), "staff:csh")).next, true);
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:adm")).next, true);
});
