import test from "node:test";
import assert from "node:assert/strict";
import { planStatusChange, assessOrderDeletion } from "../src/lib/order-guards";

test("төлөв шилжилт: зөвшөөрөгдсөн", () => {
  assert.equal(planStatusChange("PENDING", "PAID").kind, "pay");
  assert.equal(planStatusChange("PARTIALLY_PAID", "PAID").kind, "pay");
  assert.equal(planStatusChange("PENDING", "CANCELLED").kind, "cancel");
  assert.equal(planStatusChange("PARTIALLY_PAID", "CANCELLED").kind, "cancel");
  assert.equal(planStatusChange("PAID", "REFUNDED").kind, "refund");
  assert.equal(planStatusChange("PAID", "PAID").kind, "noop");
});

test("төлөв шилжилт: аюултай буцаалт/давхар шилжилтүүд татгалзана", () => {
  const bad: Array<[string, string]> = [
    ["PAID", "PENDING"], ["PAID", "CANCELLED"], ["PAID", "PARTIALLY_PAID"],
    ["CANCELLED", "PAID"], ["CANCELLED", "PENDING"], ["CANCELLED", "REFUNDED"],
    ["REFUNDED", "PAID"], ["REFUNDED", "PENDING"],
    ["PENDING", "REFUNDED"], ["PENDING", "PARTIALLY_PAID"], ["PARTIALLY_PAID", "PENDING"], ["PARTIALLY_PAID", "REFUNDED"],
  ];
  for (const [a, b] of bad) assert.equal(planStatusChange(a, b).kind, "reject", `${a}->${b}`);
});

test("REFUNDED шилжилт adminOnly гэж тэмдэглэгдсэн", () => {
  const p: any = planStatusChange("PAID", "REFUNDED");
  assert.equal(p.adminOnly, true);
});

const base = { paymentStatus: "PENDING", paidAmount: 0, courierPayoutId: null, sellerPayoutId: null, courierFeePaid: false };

test("устгал: хоосон PENDING захиалгыг касс ч устгаж болно", () => {
  assert.equal(assessOrderDeletion(base, { isAdmin: false, force: false }).ok, true);
});

test("устгал: CANCELLED (мөнгөгүй) чөлөөтэй", () => {
  assert.equal(assessOrderDeletion({ ...base, paymentStatus: "CANCELLED" }, { isAdmin: false, force: false }).ok, true);
});

test("устгал: төлбөртэй захиалгыг касс устгаж чадахгүй (403)", () => {
  const r: any = assessOrderDeletion({ ...base, paymentStatus: "PAID", paidAmount: 5000 }, { isAdmin: false, force: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("устгал: ADMIN ч force-гүйгээр төлбөртэйг устгахгүй (409)", () => {
  const r: any = assessOrderDeletion({ ...base, paymentStatus: "PAID", paidAmount: 5000 }, { isAdmin: true, force: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test("устгал: ADMIN + force → төлбөртэйг зөвшөөрнө", () => {
  assert.equal(assessOrderDeletion({ ...base, paymentStatus: "PAID", paidAmount: 5000 }, { isAdmin: true, force: true }).ok, true);
});

test("устгал: PARTIALLY_PAID, буцаалттай, buцаалт хүлээгдэж буй захиалга хамгаалагдана", () => {
  assert.equal(assessOrderDeletion({ ...base, paymentStatus: "PARTIALLY_PAID", paidAmount: 100 }, { isAdmin: false, force: false }).ok, false);
  assert.equal(assessOrderDeletion({ ...base, paymentStatus: "CANCELLED", refundDueAmount: 3000 }, { isAdmin: false, force: false }).ok, false);
  assert.equal(assessOrderDeletion({ ...base, paymentStatus: "REFUNDED", refundedAt: new Date() }, { isAdmin: false, force: false }).ok, false);
});

test("устгал: payout-той холбогдсон бол ADMIN+force ч хориглоно", () => {
  for (const patch of [{ courierPayoutId: "cp1" }, { sellerPayoutId: "sp1" }, { courierFeePaid: true }]) {
    const r: any = assessOrderDeletion({ ...base, paymentStatus: "PAID", paidAmount: 1, ...patch }, { isAdmin: true, force: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
  }
});
