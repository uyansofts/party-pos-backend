import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidInvoiceError, checkDepositInvoiceAmount, checkOrderInvoiceAmount, classifyUnapplied, isValidMoneyAmount, toCents, unappliedMessage } from "../src/lib/payment-guards";

test("toCents: хөвөгч таслалын алдаагүй", () => {
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(1234.56), 123456);
});

test("isValidMoneyAmount", () => {
  for (const ok of [1, 5000, 99.99, 0.01]) assert.equal(isValidMoneyAmount(ok), true, String(ok));
  for (const bad of [0, -1, NaN, Infinity, "5000", null, undefined, 12.345, 2e9]) assert.equal(isValidMoneyAmount(bad as any), false, String(bad));
});

test("checkOrderInvoiceAmount: үлдэгдэл + барьцаанаас ихийг татгалзана", () => {
  assert.doesNotThrow(() => checkOrderInvoiceAmount(100, 100, 0));
  assert.doesNotThrow(() => checkOrderInvoiceAmount(30, 100, 0)); // хэсэгчилсэн төлбөр хэвээр зөвшөөрөгдөнө (одоогийн бизнес логик)
  assert.doesNotThrow(() => checkOrderInvoiceAmount(130, 100, 30));
  assert.throws(() => checkOrderInvoiceAmount(100.01, 100, 0), InvalidInvoiceError);
  assert.throws(() => checkOrderInvoiceAmount(131, 100, 30), InvalidInvoiceError);
  assert.throws(() => checkOrderInvoiceAmount(10, 0, 0), InvalidInvoiceError);
  assert.throws(() => checkOrderInvoiceAmount(-5, 100, 0), InvalidInvoiceError);
});

test("checkDepositInvoiceAmount: барьцааны дүнтэй яг тэнцүү", () => {
  assert.doesNotThrow(() => checkDepositInvoiceAmount(30, 30));
  assert.throws(() => checkDepositInvoiceAmount(29.99, 30), InvalidInvoiceError);
  assert.throws(() => checkDepositInvoiceAmount(31, 30), InvalidInvoiceError);
});

test("classifyUnapplied", () => {
  assert.equal(classifyUnapplied(null), "ORDER_NOT_FOUND");
  assert.equal(classifyUnapplied({ paymentStatus: "CANCELLED" }), "CANCELLED");
  assert.equal(classifyUnapplied({ paymentStatus: "PENDING", cancelledAt: new Date() }), "CANCELLED");
  assert.equal(classifyUnapplied({ paymentStatus: "REFUNDED" }), "REFUNDED");
  assert.equal(classifyUnapplied({ paymentStatus: "PAID" }), "ALREADY_PAID");
  assert.equal(classifyUnapplied({ paymentStatus: "PENDING" }), "NOTHING_DUE");
  assert.ok(unappliedMessage("CANCELLED").includes("Цуцлагдсан"));
});
