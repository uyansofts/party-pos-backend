// ============================================================================
// F7 — НӨӨЦИЙН АТОМИК ХАСАЛТ: зэрэгцээ захиалга, сөрөг үлдэгдэл, давхар хасалт, цуцлалт, багц, түрээс
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, gateways, load, paymentCount, reset, seedGatewayTx, seedOrder, seedProduct, stockMovements } from "./support/harness";
import { mergeStockLines, findShortages, bundleOrderToStockLines, InsufficientStockError } from "../src/lib/stock-guards";

const settlement = load<typeof import("../src/services/gateway-settlement.service")>("services/gateway-settlement.service");
const orderPayment = load<typeof import("../src/services/order-payment.service")>("services/order-payment.service");
const stock = load<typeof import("../src/services/stock.service")>("services/stock.service");
const invoice = load<typeof import("../src/services/invoice.service")>("services/invoice.service");
const orderSvc = load<typeof import("../src/services/order.service")>("services/order.service");
const sellerOrder = load<typeof import("../src/services/seller-order.service")>("services/seller-order.service");

beforeEach(() => reset());

const qtyOf = (pid: string) => db.get("product", pid)!.sellStockQty as number;
const orderOf = (id: string) => db.get("order", id)!;
const gtxOf = (id: string) => db.get("gatewayTransaction", id)!;
const CASH = "CASH" as any;

// ---------------------------------------------------------------- цэвэр дүрэм
test("mergeStockLines: ижил бараа нэгтгэгдэж, productId-аар эрэмбэлэгдэнэ", () => {
  assert.deepEqual(mergeStockLines([{ productId: "b", quantity: 2 }, { productId: "a", quantity: 1 }, { productId: "b", quantity: 3 }]), [
    { productId: "a", quantity: 1 },
    { productId: "b", quantity: 5 },
  ]);
});

test("mergeStockLines: 0, сөрөг, бутархай тоо татгалзана", () => {
  for (const q of [0, -1, 1.5, NaN]) assert.throws(() => mergeStockLines([{ productId: "a", quantity: q }]), /тоо бүхэл/);
});

test("findShortages: сөрөг/мэдээлэлгүй нөөц = 0; хүрэлцэхгүйг нэрээр тайлбарлана", () => {
  const s = findShortages([{ productId: "a", quantity: 2 }, { productId: "b", quantity: 1 }], { a: -3 }, { a: "Шаар" });
  assert.equal(s.length, 2);
  assert.match(new InsufficientStockError(s).message, /Шаар/);
});

test("БАГЦ: бүрэлдэхүүн давхцсан үед (2 багц × шаар 2 + дан шаар 1) нийт шаардлага НЭГТГЭГДЭНЭ", () => {
  const lines = bundleOrderToStockLines(
    [
      { bundleId: "B1", quantity: 2, components: [{ productId: "balloon", quantity: 2 }, { productId: "cap", quantity: 1 }] },
      { bundleId: "B2", quantity: 1, components: [{ productId: "balloon", quantity: 3 }] },
    ],
    [{ productId: "balloon", quantity: 1 }]
  );
  assert.deepEqual(lines, [{ productId: "balloon", quantity: 8 }, { productId: "cap", quantity: 2 }]);
});

// ---------------------------------------------------------------- зэрэгцээ POS/кассын төлбөр
test("ЗЭРЭГЦЭЭ: хоёр захиалга сүүлийн үлдэгдлийг (3 ш, тус бүр 2) нэг дор авахад ЗӨВХӨН НЭГ нь PAID, нөөц сөрөг болохгүй", async () => {
  seedProduct("P", 3);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  seedOrder({ id: "B", total: 100, productId: "P", qty: 2 });
  const rs = await Promise.allSettled([
    orderPayment.applyOrderPayment("A", 100, CASH),
    orderPayment.applyOrderPayment("B", 100, CASH),
  ]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof orderPayment.OrderPaymentError);
  assert.match(String(rejected.reason.message), /Нөөц хүрэлцэхгүй/);
  assert.equal(qtyOf("P"), 1);
  assert.equal(stockMovements("P").length, 1);
  const paid = ["A", "B"].filter((id) => orderOf(id).paymentStatus === "PAID");
  const loser = ["A", "B"].find((id) => !paid.includes(id))!;
  assert.equal(paid.length, 1);
  // ялагдсан захиалгад ЮУ Ч бичигдээгүй (order / payment / movement нийцтэй)
  assert.equal(orderOf(loser).paymentStatus, "PENDING");
  assert.equal(orderOf(loser).paidAmount, 0);
  assert.equal(paymentCount(loser), 0);
});

test("ЗЭРЭГЦЭЭ: 10 захиалга, нөөц 4 (тус бүр 1) → яг 4 нь амжилттай, үлдэгдэл 0, ХЭЗЭЭ Ч сөрөг биш", async () => {
  seedProduct("P", 4);
  for (let i = 0; i < 10; i++) seedOrder({ id: `o${i}`, total: 10, productId: "P", qty: 1 });
  const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => orderPayment.applyOrderPayment(`o${i}`, 10, CASH)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 4);
  assert.equal(qtyOf("P"), 0);
  assert.equal(stockMovements("P").length, 4);
  assert.equal(db.all("order").filter((o) => o.paymentStatus === "PAID").length, 4);
  assert.equal(db.all("payment").length, 4);
});

test("СӨРӨГ ҮЛДЭГДЭЛ: нөөц 1, захиалга 2 → татгалзана, нөөц 1 хэвээр", async () => {
  seedProduct("P", 1);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  await assert.rejects(() => orderPayment.applyOrderPayment("A", 100, CASH), /Нөөц хүрэлцэхгүй/);
  assert.equal(qtyOf("P"), 1);
  assert.equal(orderOf("A").paymentStatus, "PENDING");
  assert.equal(paymentCount("A"), 0);
  assert.equal(stockMovements("P").length, 0);
});

test("ДАВХАР ХАСАЛТ: нэг захиалгыг 5 удаа зэрэг төлөхөд нөөц НЭГ л удаа хасагдана", async () => {
  seedProduct("P", 10);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 3 });
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => orderPayment.applyOrderPayment("A", 100, CASH)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(qtyOf("P"), 7);
  assert.equal(stockMovements("P").length, 1);
  assert.equal(paymentCount("A"), 1);
});

test("НЭГТГЭЛ: нэг захиалгын ижил барааны 2 мөр (2+2) нөөц 3 → татгалзана; нөөц 4 → нэг нэгтгэсэн хөдөлгөөнөөр 4 хасна", async () => {
  seedProduct("P", 3);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  const o = db.get("order", "A")!;
  const second = { ...o.items[0], id: "item-A2", quantity: 2 };
  o.items.push(second);
  db.seed("order", o);
  db.seed("orderItem", second);
  await assert.rejects(() => orderPayment.applyOrderPayment("A", 100, CASH), /Нөөц хүрэлцэхгүй/);
  assert.equal(qtyOf("P"), 3);

  db.seed("product", { id: "P", name: "P", sellStockQty: 4, usesMaterialPricing: false });
  await orderPayment.applyOrderPayment("A", 100, CASH);
  assert.equal(qtyOf("P"), 0);
  assert.equal(stockMovements("P").length, 1);
  assert.equal(stockMovements("P")[0].quantity, 4);
});

test("БҮЛЭГ ТӨЛБӨР: гишүүдийн нийт шаардлага нөөцөөс их бол БҮЛЭГ бүхэлдээ буцна (хэсэгчлэн PAID болохгүй)", async () => {
  seedProduct("P", 3);
  seedOrder({ id: "A", total: 50, groupId: "G", productId: "P", qty: 2 });
  seedOrder({ id: "B", total: 50, groupId: "G", productId: "P", qty: 2 });
  await assert.rejects(() => orderPayment.applyOrderPayment("A", 100, CASH), /Нөөц хүрэлцэхгүй/);
  assert.equal(qtyOf("P"), 3);
  for (const id of ["A", "B"]) {
    assert.equal(orderOf(id).paymentStatus, "PENDING");
    assert.equal(orderOf(id).paidAmount, 0);
    assert.equal(paymentCount(id), 0);
  }
  assert.equal(stockMovements("P").length, 0);
});

// ---------------------------------------------------------------- gateway (мөнгө орсон ч нөөц дутсан)
test("GATEWAY: нөөц дууссан үед мөнгө орвол захиалга батлагдахгүй, буцаалтад бүртгэгдэнэ, дахин оролдлого гогцоонд орохгүй", async () => {
  seedProduct("P", 2);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  seedOrder({ id: "B", total: 100, productId: "P", qty: 2 });
  const ga = seedGatewayTx({ orderId: "A", amount: 100 });
  const gb = seedGatewayTx({ orderId: "B", amount: 100 });
  const rs = await Promise.all([settlement.confirmAndSettle(gtxOf(ga.id)), settlement.confirmAndSettle(gtxOf(gb.id))]);
  assert.equal(rs.filter((r) => r.kind === "APPLIED").length, 1);
  const un = rs.find((r) => r.kind === "UNAPPLIED") as any;
  assert.equal(un.reason, "INSUFFICIENT_STOCK");
  assert.equal(qtyOf("P"), 0);
  const loserOrder = orderOf(["A", "B"].find((id) => orderOf(id).paymentStatus !== "PAID")!);
  assert.equal(loserOrder.paymentStatus, "PENDING");
  assert.equal(loserOrder.paidAmount, 0);
  assert.equal(loserOrder.refundDueAmount, 100); // Staff мөнгийг буцаана
  assert.equal(paymentCount(loserOrder.id), 0);
  const loserTx = [ga, gb].map((g) => gtxOf(g.id)).find((g) => g.orderId === loserOrder.id)!;
  assert.equal(loserTx.status, "PAID");
  assert.equal(loserTx.rawCallback._unapplied.reason, "INSUFFICIENT_STOCK");
  // Дахин webhook/reconcile → DUPLICATE (давхар буцаалт/давхар оролдлого байхгүй)
  const again = await settlement.confirmAndSettle({ ...loserTx, status: "PENDING" } as any);
  assert.equal(again.kind, "DUPLICATE");
  assert.equal(orderOf(loserOrder.id).refundDueAmount, 100);
  const listed = await settlement.listUnappliedPayments();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].reason, "INSUFFICIENT_STOCK");
});

// ---------------------------------------------------------------- түрээс / материал ≠ борлуулалтын нөөц
test("ТҮРЭЭС: RENTAL мөр борлуулалтын нөөцийг хасахгүй (нөөц 0 байсан ч төлбөр батлагдана)", async () => {
  seedProduct("R", 0);
  seedOrder({ id: "A", total: 100, productId: "R", qty: 1 });
  const o = db.get("order", "A")!;
  o.items[0].itemType = "RENTAL";
  db.seed("order", o);
  await orderPayment.applyOrderPayment("A", 100, CASH);
  assert.equal(orderOf("A").paymentStatus, "PAID");
  assert.equal(qtyOf("R"), 0);
  assert.equal(stockMovements("R").length, 0);
});

test("МАТЕРИАЛААР ҮНЭЛЭГДЭХ бараа барааны нөөцөөс хасагдахгүй (материалын см² нөөцөөр тусдаа)", async () => {
  seedProduct("M", 0);
  seedOrder({ id: "A", total: 100, productId: "M", qty: 3 });
  const o = db.get("order", "A")!;
  o.items[0].product.usesMaterialPricing = true;
  db.seed("order", o);
  await orderPayment.applyOrderPayment("A", 100, CASH);
  assert.equal(orderOf("A").paymentStatus, "PAID");
  assert.equal(qtyOf("M"), 0);
});

// ---------------------------------------------------------------- цуцлалт
test("ЦУЦЛАЛТ: PENDING захиалгыг цуцлахад нөөц хөдлөхгүй (хасагдаагүй байсан); дараа нь орж ирсэн төлбөр нөөц хасахгүй", async () => {
  seedProduct("P", 5);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  await orderSvc.cancelOrder("A", true);
  assert.equal(qtyOf("P"), 5);
  const g = seedGatewayTx({ orderId: "A", amount: 100 });
  const r = await settlement.confirmAndSettle(gtxOf(g.id));
  assert.equal(r.kind, "UNAPPLIED");
  assert.equal(qtyOf("P"), 5);
  assert.equal(stockMovements("P").length, 0);
});

test("ЦУЦЛАЛТ: PAID захиалгыг цуцлах боломжгүй — нөөц хасагдсан хэвээр, буцаж нэмэгдэхгүй", async () => {
  seedProduct("P", 5);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  await orderPayment.applyOrderPayment("A", 100, CASH);
  await assert.rejects(() => orderSvc.cancelOrder("A", true), /цуцлах боломжгүй/);
  assert.equal(qtyOf("P"), 3);
});

test("ЦУЦЛАЛТ: худалдагч PAID захиалгаас татгалзахад нөөц НЭГ л удаа сэргэнэ (давхар татгалзах нөөцийг дахин нэмэхгүй)", async () => {
  seedProduct("P", 5);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  const o = db.get("order", "A")!;
  Object.assign(o, { sellerId: "S1", sellerStatus: "AWAITING_SELLER" });
  o.items[0].product = { ...o.items[0].product, usesMaterialPricing: false };
  db.seed("order", o);
  db.seed("orderItem", { id: "item-A", orderId: "A", productId: "P", itemType: "SALE", quantity: 2 });
  await orderPayment.applyOrderPayment("A", 100, CASH);
  assert.equal(qtyOf("P"), 3);
  const rs = await Promise.allSettled([
    sellerOrder.rejectSellerOrder("A", "бараа дууссан", "S1"),
    sellerOrder.rejectSellerOrder("A", "бараа дууссан", "S1"),
  ]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(qtyOf("P"), 5);
});

// ---------------------------------------------------------------- гараар тохируулга
test("adjustSaleStock: үлдэгдлээс их хасалт татгалзана, нөөц/хөдөлгөөн өөрчлөгдөхгүй", async () => {
  seedProduct("P", 3);
  await assert.rejects(() => stock.adjustSaleStock("P", -5, "ADJUSTMENT" as any), InsufficientStockError);
  assert.equal(qtyOf("P"), 3);
  assert.equal(stockMovements("P").length, 0);
  await stock.adjustSaleStock("P", -3, "ADJUSTMENT" as any, { staffId: "s1" });
  assert.equal(qtyOf("P"), 0);
  assert.equal(stockMovements("P").length, 1);
});

test("adjustSaleStock: зэрэгцээ хоёр -2 хасалт (нөөц 3) → нэг нь л амжилттай, сөрөг болохгүй", async () => {
  seedProduct("P", 3);
  const rs = await Promise.allSettled([stock.adjustSaleStock("P", -2, "ADJUSTMENT" as any), stock.adjustSaleStock("P", -2, "ADJUSTMENT" as any)]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(qtyOf("P"), 1);
  assert.equal(stockMovements("P").length, 1);
});

test("adjustSaleStock: 0 / бутархай тоо татгалзана", async () => {
  seedProduct("P", 3);
  for (const q of [0, 1.5]) await assert.rejects(() => stock.adjustSaleStock("P", q, "PURCHASE_IN" as any));
});

// ---------------------------------------------------------------- нэхэмжлэл ба шалгалт
test("INVOICE: нөөц дууссан захиалгад нэхэмжлэл үүсгэхгүй (хэрэглэгч төлчихөөд баталгаажихгүй байхаас сэргийлнэ)", async () => {
  seedProduct("P", 1);
  seedOrder({ id: "A", total: 100, productId: "P", qty: 2 });
  await assert.rejects(
    () => invoice.createGatewayInvoice({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", orderId: "A", amount: 100 } as any),
    invoice.InvalidInvoiceError
  );
  assert.equal(db.all("gatewayTransaction").length, 0);
});

test("INVOICE: нөөц хүрэлцээтэй бол үүснэ (бүлгийн гишүүдийн нийт шаардлагыг нэгтгэж шалгана)", async () => {
  seedProduct("P", 4);
  seedOrder({ id: "A", total: 50, groupId: "G", productId: "P", qty: 2 });
  seedOrder({ id: "B", total: 50, groupId: "G", productId: "P", qty: 2 });
  const ok = await invoice.createGatewayInvoice({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", orderId: "A", amount: 100 } as any);
  assert.ok(ok.gatewayTransactionId);
  db.seed("product", { id: "P", name: "P", sellStockQty: 3, usesMaterialPricing: false });
  await assert.rejects(
    () => invoice.createGatewayInvoice({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", orderId: "A", amount: 100 } as any),
    invoice.InvalidInvoiceError
  );
});

test("assertStockAvailable: ижил барааг олон мөрөөр нэмж захиалсан ч нийлбэрээр шалгана", async () => {
  seedProduct("P", 3);
  await assert.rejects(
    () => stock.assertStockAvailable(db.client(), [{ productId: "P", quantity: 2 }, { productId: "P", quantity: 2 }]),
    InsufficientStockError
  );
  await stock.assertStockAvailable(db.client(), [{ productId: "P", quantity: 1 }, { productId: "P", quantity: 2 }]);
});

void gateways;
