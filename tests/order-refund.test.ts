// ============================================================================
// ТӨЛӨГДСӨН ЗАХИАЛГЫН БУЦААЛТ — хайчлагдах бараа буцаагдахгүй; бусад нь буцаж нөөц сэргэнэ; холимог = зөвхөн бусад мөр
// ⚠️ fake Prisma (санах ой) дээр — бодит PostgreSQL дээрх зэрэгцээ ажиллагааг ТУРШААГҮЙ.
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset, seedProduct } from "./support/harness";
import { planOrderRefund } from "../src/lib/refund-policy";

const refund = load<typeof import("../src/services/order-refund.service")>("services/order-refund.service");

beforeEach(() => reset());

interface It {
  id: string;
  kind: "plain" | "cut" | "rental";
  productId?: string;
  qty?: number;
  subtotal: number;
  issued?: boolean;
}

function seedPaid(orderId: string, items: It[], o: { paid?: number; status?: string; cancelledAt?: Date | null } = {}) {
  const rows = items.map((i) => {
    const productId = i.productId ?? `p-${i.id}`;
    if (!db.get("product", productId)) db.seed("product", { id: productId, name: `Бараа ${productId}`, sellStockQty: 0, usesMaterialPricing: i.kind === "cut" });
    return {
      id: i.id,
      orderId,
      productId,
      itemType: i.kind === "rental" ? "RENTAL" : "SALE",
      quantity: i.qty ?? 1,
      subtotal: i.subtotal,
      materialId: i.kind === "cut" ? "M1" : null,
      areaCm2: i.kind === "cut" ? 100 : null,
      isIssued: !!i.issued,
      refundedAt: null,
      product: { id: productId, name: `Бараа ${productId}`, usesMaterialPricing: i.kind === "cut" },
    };
  });
  for (const r of rows) db.seed("orderItem", r);
  return db.seed("order", {
    id: orderId,
    orderNumber: `N-${orderId}`,
    orderType: "ONLINE",
    storeId: "default",
    paymentStatus: o.status ?? "PAID",
    totalAmount: o.paid ?? items.reduce((s, i) => s + i.subtotal, 0),
    paidAmount: o.paid ?? items.reduce((s, i) => s + i.subtotal, 0),
    cancelledAt: o.cancelledAt ?? null,
    refundDueAmount: 0,
    refundedAt: null,
    items: rows,
  });
}

const orderOf = (id: string) => db.get("order", id)!;
const itemOf = (id: string) => db.get("orderItem", id)!;
const qtyOf = (pid: string) => db.get("product", pid)!.sellStockQty as number;
const moves = (pid: string) => db.all("stockMovement").filter((m) => m.productId === pid);

// ---------------------------------------------------------------- цэвэр дүрэм
test("PLAN: хайчлагдах бараагүй → full; олгогдсон мөрийн нөөц сэргээхгүй; ижил барааг нэгтгэнэ", () => {
  const p = planOrderRefund([
    { id: "a", itemType: "SALE", subtotal: 100, quantity: 2, productId: "P" },
    { id: "b", itemType: "SALE", subtotal: 50, quantity: 1, productId: "P" },
    { id: "c", itemType: "SALE", subtotal: 30, quantity: 4, productId: "Q", isIssued: true },
  ]);
  assert.equal(p.kind, "full");
  if (p.kind === "none") return;
  assert.deepEqual(p.restockLines, [{ productId: "P", quantity: 3 }]);
  assert.equal(p.itemsRefundAmount, 180);
  assert.equal(p.keptAmount, 0);
});

test("PLAN: materialId эсвэл usesMaterialPricing бол хайчлагдах — буцаахгүй; холимог → partial", () => {
  const p = planOrderRefund([
    { id: "a", itemType: "SALE", subtotal: 20000, quantity: 1, productId: "P" },
    { id: "cut", itemType: "SALE", subtotal: 30000, quantity: 1, productId: "C", materialId: "M" },
    { id: "legacy", itemType: "SALE", subtotal: 5000, quantity: 1, productId: "L", product: { usesMaterialPricing: true } },
  ]);
  assert.equal(p.kind, "partial");
  if (p.kind === "none") return;
  assert.deepEqual(p.refundItemIds, ["a"]);
  assert.equal(p.itemsRefundAmount, 20000);
  assert.equal(p.keptAmount, 35000);
});

test("PLAN: зөвхөн хайчлагдах эсвэл бүгд буцаагдсан → none", () => {
  assert.equal(planOrderRefund([{ id: "c", itemType: "SALE", subtotal: 1, quantity: 1, productId: "C", materialId: "M" }]).kind, "none");
  assert.equal(planOrderRefund([{ id: "a", itemType: "SALE", subtotal: 1, quantity: 1, productId: "P", refundedAt: new Date() }]).kind, "none");
});

test("PLAN: түрээсийн мөр мөнгө буцаагдана, борлуулалтын нөөц сэргэхгүй; бутархай ₮ cent-ээр нэмэгдэнэ", () => {
  const p = planOrderRefund([
    { id: "r", itemType: "RENTAL", subtotal: 10.1, quantity: 1, productId: "R" },
    { id: "s", itemType: "SALE", subtotal: 20.2, quantity: 1, productId: "S" },
  ]);
  if (p.kind === "none") throw new Error("none");
  assert.deepEqual(p.restockLines, [{ productId: "S", quantity: 1 }]);
  assert.equal(p.itemsRefundAmount, 30.3);
});

// ---------------------------------------------------------------- гүйцэтгэл
test("БҮРЭН: энгийн барааны захиалга → REFUNDED, төлсөн бүх дүн, нөөц сэргэнэ, мөр refundedAt, хөдөлгөөн бичигдэнэ", async () => {
  seedPaid("A", [{ id: "i1", productId: "P", qty: 2, subtotal: 100 }], { paid: 130 }); // 30 = хүргэлт (бүрэн буцаалтад багтана)
  const r = await refund.refundPaidOrder("A", "staff1");
  assert.equal(r.kind, "full");
  assert.equal(r.refundAmount, 130);
  assert.equal(orderOf("A").paymentStatus, "REFUNDED");
  assert.ok(orderOf("A").refundedAt);
  assert.ok(itemOf("i1").refundedAt);
  assert.equal(qtyOf("P"), 2);
  assert.equal(moves("P").length, 1);
  assert.equal(moves("P")[0].type, "ADJUSTMENT");
  assert.equal(moves("P")[0].quantity, 2);
});

test("ОЛГОГДСОН мөрийн нөөц сэргэхгүй (бараа хэрэглэгчид очсон), гэхдээ мөнгө буцаагдана", async () => {
  seedPaid("A", [{ id: "i1", productId: "P", qty: 2, subtotal: 100, issued: true }]);
  const r = await refund.refundPaidOrder("A");
  assert.equal(r.refundAmount, 100);
  assert.equal(qtyOf("P"), 0);
  assert.equal(moves("P").length, 0);
  assert.equal(orderOf("A").paymentStatus, "REFUNDED");
});

test("ЗӨВХӨН хайчлагдах бараатай захиалга: буцаалт татгалзана, юу ч өөрчлөгдөхгүй", async () => {
  seedPaid("A", [{ id: "c1", kind: "cut", subtotal: 30000 }]);
  await assert.rejects(() => refund.refundPaidOrder("A"), /хайчлагдах барааны мөнгийг буцаахгүй/);
  assert.equal(orderOf("A").paymentStatus, "PAID");
  assert.equal(orderOf("A").refundedAt, null);
  assert.equal(itemOf("c1").refundedAt, null);
  assert.equal(db.all("stockMovement").length, 0);
});

test("ХОЛИМОГ: зөвхөн энгийн барааны subtotal буцаана (хүргэлт буцаахгүй), захиалга PAID хэвээр, хайчлагдах мөр хөндөгдөхгүй", async () => {
  seedPaid("A", [
    { id: "cut", kind: "cut", subtotal: 30000 },
    { id: "plain", productId: "P", qty: 3, subtotal: 20000 },
  ], { paid: 55000 }); // 5000 = хүргэлт/яаралтай — буцаахгүй
  const r = await refund.refundPaidOrder("A", "admin1");
  assert.equal(r.kind, "partial");
  assert.equal(r.refundAmount, 20000);
  assert.equal(r.keptAmount, 30000);
  assert.deepEqual(r.refundedItemIds, ["plain"]);
  assert.equal(orderOf("A").paymentStatus, "PAID");
  assert.equal(orderOf("A").refundedAt, null);
  assert.equal(orderOf("A").paidAmount, 55000); // paidAmount хэзээ ч буурахгүй
  assert.ok(itemOf("plain").refundedAt);
  assert.equal(itemOf("cut").refundedAt, null);
  assert.equal(qtyOf("P"), 3);
  assert.equal(db.all("materialMovement").length, 0); // материалын нөөц хөдөлсөнгүй
});

test("ХОЛИМОГ: хоёр дахь буцаалт татгалзана — давхар мөнгө/нөөц байхгүй", async () => {
  seedPaid("A", [{ id: "cut", kind: "cut", subtotal: 30000 }, { id: "plain", productId: "P", qty: 3, subtotal: 20000 }]);
  await refund.refundPaidOrder("A");
  await assert.rejects(() => refund.refundPaidOrder("A"), /Буцаах боломжтой мөр алга/);
  assert.equal(qtyOf("P"), 3);
  assert.equal(moves("P").length, 1);
});

test("ЗЭРЭГЦЭЭ: нэг захиалгыг 5 удаа зэрэг буцаахад НЭГ л удаа амжилттай, нөөц НЭГ л удаа сэргэнэ", async () => {
  seedPaid("A", [{ id: "cut", kind: "cut", subtotal: 30000 }, { id: "plain", productId: "P", qty: 3, subtotal: 20000 }]);
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => refund.refundPaidOrder("A")));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of rs) if (r.status === "rejected") assert.ok(r.reason instanceof refund.OrderRefundError);
  assert.equal(qtyOf("P"), 3);
  assert.equal(moves("P").length, 1);
});

test("ЗЭРЭГЦЭЭ (бүрэн): 5 удаа зэрэг → нэг л удаа REFUNDED, нөөц нэг л удаа сэргэнэ", async () => {
  seedPaid("A", [{ id: "i1", productId: "P", qty: 2, subtotal: 100 }]);
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => refund.refundPaidOrder("A")));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(qtyOf("P"), 2);
  assert.equal(moves("P").length, 1);
});

test("ТӨЛӨВ: PAID биш / цуцлагдсан / олдохгүй захиалгыг буцаахгүй", async () => {
  seedPaid("P1", [{ id: "x1", productId: "P", subtotal: 10 }], { status: "PENDING" });
  seedPaid("P2", [{ id: "x2", productId: "P", subtotal: 10 }], { status: "REFUNDED" });
  seedPaid("P3", [{ id: "x3", productId: "P", subtotal: 10 }], { cancelledAt: new Date() });
  for (const id of ["P1", "P2", "P3"]) await assert.rejects(() => refund.refundPaidOrder(id), refund.OrderRefundError);
  await assert.rejects(() => refund.refundPaidOrder("NOPE"), (e: any) => e instanceof refund.OrderRefundError && e.status === 404);
  assert.equal(qtyOf("P"), 0);
  assert.equal(db.all("stockMovement").length, 0);
});

test("ROLLBACK: нөөц сэргээх үед бараа олдохгүй бол мөрийн claim ч буцна", async () => {
  seedPaid("A", [{ id: "i1", productId: "P", qty: 2, subtotal: 100 }]);
  db.committed["product"].delete("P"); // бараа устсан гэж дуурайна
  await assert.rejects(() => refund.refundPaidOrder("A"), /Бараа олдсонгүй/);
  assert.equal(itemOf("i1").refundedAt, null);
  assert.equal(orderOf("A").paymentStatus, "PAID");
});

test("ХУДАЛДАГЧИЙН захиалга: хэсэгчилсэн буцаалт татгалзана (худалдагчид давхар олгохоос сэргийлнэ); бүрэн буцаалт зөвшөөрнө", async () => {
  seedPaid("S1", [{ id: "sc", kind: "cut", subtotal: 30000 }, { id: "sp", productId: "P", qty: 1, subtotal: 20000 }]);
  const o = db.get("order", "S1")!;
  db.seed("order", { ...o, sellerId: "SELLER1" });
  await assert.rejects(() => refund.refundPaidOrder("S1"), /Худалдагчийн захиалгад хэсэгчилсэн буцаалт/);
  assert.equal(itemOf("sp").refundedAt, null);
  assert.equal(orderOf("S1").paymentStatus, "PAID");
  assert.equal(db.all("stockMovement").length, 0);

  seedPaid("S2", [{ id: "sp2", productId: "P", qty: 1, subtotal: 20000 }]);
  db.seed("order", { ...db.get("order", "S2")!, sellerId: "SELLER1" });
  const r = await refund.refundPaidOrder("S2");
  assert.equal(r.kind, "full");
  assert.equal(orderOf("S2").paymentStatus, "REFUNDED"); // seller-settlement refundedAt/PAID шалгалтаар тооцооноос хасагдана
});
