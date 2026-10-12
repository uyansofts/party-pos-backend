// ============================================================================
// Нэхэмжлэлийн сервер талын дүн шалгалт + cancelOrder-ийн атомик claim + төлбөртэй уралдах тест
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset, seedGatewayTx, seedOrder, paymentCount } from "./support/harness";

const invoice = load<typeof import("../src/services/invoice.service")>("services/invoice.service");
const settlement = load<typeof import("../src/services/gateway-settlement.service")>("services/gateway-settlement.service");
const orderSvc = load<typeof import("../src/services/order.service")>("services/order.service");

beforeEach(() => reset());

const make = (over: Record<string, unknown>) => ({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", ...over }) as any;
const orderOf = (id: string) => db.get("order", id)!;

test("INVOICE: үлдэгдэлтэй тэнцүү дүн зөвшөөрөгдөж, GatewayTransaction үүснэ", async () => {
  seedOrder({ id: "o1", total: 100, paid: 40 });
  const r = await invoice.createGatewayInvoice(make({ orderId: "o1", amount: 60 }));
  assert.ok(r.gatewayTransactionId);
  assert.equal(db.all("gatewayTransaction").length, 1);
});

test("INVOICE: үлдэгдлээс ИХ, сөрөг, 0, NaN, 3 орны дүн татгалзана; gateway дуудагдахгүй", async () => {
  seedOrder({ id: "o1", total: 100, paid: 40 });
  for (const amount of [60.01, 100, -5, 0, NaN, 12.345, "abc"]) {
    await assert.rejects(() => invoice.createGatewayInvoice(make({ orderId: "o1", amount })), invoice.InvalidInvoiceError, String(amount));
  }
  assert.equal(db.all("gatewayTransaction").length, 0);
});

test("INVOICE: string тоо ('60') тоо болгож шалгана (клиент нийцтэй)", async () => {
  seedOrder({ id: "o1", total: 100 });
  const r = await invoice.createGatewayInvoice(make({ orderId: "o1", amount: "60" }));
  assert.ok(r.gatewayTransactionId);
});

test("INVOICE: цуцлагдсан / төлөгдсөн / cancelledAt-тай / олдохгүй захиалгад invoice үүсгэхгүй", async () => {
  seedOrder({ id: "c", total: 100, status: "CANCELLED" });
  seedOrder({ id: "p", total: 100, paid: 100, status: "PAID" });
  seedOrder({ id: "x", total: 100, cancelledAt: new Date() });
  for (const orderId of ["c", "p", "x", "ghost"]) {
    await assert.rejects(() => invoice.createGatewayInvoice(make({ orderId, amount: 10 })), invoice.InvalidInvoiceError, orderId);
  }
  await assert.rejects(() => invoice.createGatewayInvoice(make({ amount: 10 })), /orderId шаардлагатай/);
});

test("INVOICE: БҮЛГИЙН захиалгад дээд хязгаар = сагсны нийт үлдэгдэл", async () => {
  seedOrder({ id: "A", total: 50, groupId: "G" });
  seedOrder({ id: "B", total: 70, groupId: "G" });
  await assert.doesNotReject(() => invoice.createGatewayInvoice(make({ orderId: "A", amount: 120 })));
  await assert.rejects(() => invoice.createGatewayInvoice(make({ orderId: "A", amount: 120.01 })), invoice.InvalidInvoiceError);
});

test("INVOICE: хамт төлөх барьцаа — энэ захиалгынх л байх ёстой, дүн нь үлдэгдэл + барьцаанаас хэтрэхгүй", async () => {
  seedOrder({ id: "o1", total: 100 });
  db.seed("rentalDetail", { id: "r1", depositStatus: "PENDING", depositAmount: 30, orderItem: { orderId: "o1", order: { orderGroupId: null } } });
  db.seed("rentalDetail", { id: "rX", depositStatus: "PENDING", depositAmount: 30, orderItem: { orderId: "other", order: { orderGroupId: null } } });
  await assert.doesNotReject(() => invoice.createGatewayInvoice(make({ orderId: "o1", amount: 130, combinedDepositRentalIds: ["r1"] })));
  await assert.rejects(() => invoice.createGatewayInvoice(make({ orderId: "o1", amount: 131, combinedDepositRentalIds: ["r1"] })), invoice.InvalidInvoiceError);
  await assert.rejects(() => invoice.createGatewayInvoice(make({ orderId: "o1", amount: 100, combinedDepositRentalIds: ["rX"] })), /таарахгүй/);
});

test("INVOICE: DEPOSIT — барьцааны дүнтэй тэнцүү, PENDING төлөвтэй байх ёстой", async () => {
  db.seed("rentalDetail", { id: "r1", depositStatus: "PENDING", depositAmount: 30 });
  db.seed("rentalDetail", { id: "r2", depositStatus: "HELD", depositAmount: 30 });
  await assert.doesNotReject(() => invoice.createGatewayInvoice(make({ purpose: "DEPOSIT", rentalDetailId: "r1", amount: 30 })));
  await assert.rejects(() => invoice.createGatewayInvoice(make({ purpose: "DEPOSIT", rentalDetailId: "r1", amount: 5 })), invoice.InvalidInvoiceError);
  await assert.rejects(() => invoice.createGatewayInvoice(make({ purpose: "DEPOSIT", rentalDetailId: "r2", amount: 30 })), invoice.InvalidInvoiceError);
  await assert.rejects(() => invoice.createGatewayInvoice(make({ purpose: "DEPOSIT", amount: 30 })), /rentalDetailId/);
});

test("INVOICE: FEATURED_PROMOTION — дүнгийн хэлбэрийг л шалгана (онцлох сервис өөрөө дүнг тооцдог)", async () => {
  await assert.doesNotReject(() => invoice.createGatewayInvoice(make({ purpose: "FEATURED_PROMOTION", promotionId: "p1", amount: 20000 })));
  await assert.rejects(() => invoice.createGatewayInvoice(make({ purpose: "FEATURED_PROMOTION", promotionId: "p1", amount: -1 })), invoice.InvalidInvoiceError);
});

test("CANCEL: PENDING / PARTIALLY_PAID захиалгыг цуцална", async () => {
  seedOrder({ id: "a", total: 100 });
  seedOrder({ id: "b", total: 100, paid: 30, status: "PARTIALLY_PAID" });
  await orderSvc.cancelOrder("a");
  await orderSvc.cancelOrder("b");
  assert.equal(orderOf("a").paymentStatus, "CANCELLED");
  assert.equal(orderOf("b").paymentStatus, "CANCELLED");
});

test("CANCEL: PAID / CANCELLED / REFUNDED захиалгыг цуцлахгүй (өмнөх шалгалт хэвээр)", async () => {
  seedOrder({ id: "p", total: 100, paid: 100, status: "PAID" });
  seedOrder({ id: "c", total: 100, status: "CANCELLED" });
  seedOrder({ id: "r", total: 100, status: "REFUNDED" });
  for (const id of ["p", "c", "r"]) await assert.rejects(() => orderSvc.cancelOrder(id), orderSvc.OrderCancellationError, id);
  assert.equal(orderOf("p").paymentStatus, "PAID");
});

test("CANCEL: уншсаны ДАРАА төлбөр орж PAID болсон бол цуцлал PAID-ыг CANCELLED-ээр ДАРЖ БИЧИХГҮЙ", async () => {
  seedOrder({ id: "o1", total: 100 });
  // cancelOrder захиалгыг PENDING гэж уншсаны дараа, транзакц эхлэхийн өмнө өөр хүсэлт төлбөрийг commit хийсэн гэж дуурайна
  db.beforeOnce("order", "updateMany", (_a, d) => {
    const row = d.table("order").get("o1")!;
    row.paymentStatus = "PAID";
    row.paidAmount = 100;
  });
  await assert.rejects(() => orderSvc.cancelOrder("o1"), orderSvc.OrderCancellationError);
  assert.equal(orderOf("o1").paymentStatus, "PAID");
});

test("УРАЛДАА: төлбөр ба цуцлал зэрэг — үр дүн үргэлж тууштай (PAID эсвэл CANCELLED+refundDue), мөнгө алдагдахгүй", async () => {
  const orders: Array<() => Promise<unknown>>[] = [];
  void orders;
  for (let i = 0; i < 12; i++) {
    const id = `race${i}`;
    seedOrder({ id, total: 100, qty: 1 });
    const g = seedGatewayTx({ orderId: id, amount: 100 });
    const pay = () => settlement.confirmAndSettle(db.get("gatewayTransaction", g.id)!);
    const cancel = () => orderSvc.cancelOrder(id).catch((e) => e);
    // Дарааллыг ээлжлүүлнэ
    await (i % 2 === 0 ? Promise.all([pay(), cancel()]) : Promise.all([cancel(), pay()]));
    const o = orderOf(id);
    if (o.paymentStatus === "PAID") {
      assert.equal(paymentCount(id), 1, `${id}: PAID бол 1 Payment`);
      assert.equal(o.refundDueAmount, 0);
    } else {
      assert.equal(o.paymentStatus, "CANCELLED", `${id}: зөвхөн PAID эсвэл CANCELLED`);
      assert.equal(paymentCount(id), 0, `${id}: цуцлагдсан бол Payment байхгүй`);
      assert.equal(o.refundDueAmount, 100, `${id}: орсон мөнгө буцаах жагсаалтад`);
    }
    assert.equal(db.get("gatewayTransaction", g.id)!.status, "PAID"); // gateway мөнгө авсан — алдагдаагүй
  }
});
