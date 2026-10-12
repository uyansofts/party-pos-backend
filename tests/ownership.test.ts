// F5 — Seller өөр seller-ийн, Courier өөр курьерийн өгөгдөлд хандаж чадахгүй (service давхарга, fake DB)
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset } from "./support/harness";

const so = load("services/seller-order.service");
const sp = load("services/seller-product.service");
const da = load("services/delivery-assignment.service");
const lr = load("services/listing-request.service");

beforeEach(() => reset());

const order = (over: any = {}) =>
  db.seed("order", { id: "o1", sellerId: "sellerA", sellerStatus: "AWAITING_SELLER", paymentStatus: "PAID", paidAmount: 1000, orderNumber: "N1", items: [], ...over });

test("өөр seller захиалгыг accept хийж чадахгүй (404, төлөв хэвээр)", async () => {
  order();
  await assert.rejects(() => so.acceptSellerOrder("o1", "sellerB"), (e: any) => e.status === 404);
  assert.equal(db.get("order", "o1")!.sellerStatus, "AWAITING_SELLER");
});

test("өөрийн захиалгыг accept хийнэ", async () => {
  order();
  await so.acceptSellerOrder("o1", "sellerA");
  assert.equal(db.get("order", "o1")!.sellerStatus, "ACCEPTED");
});

test("өөр seller ready / reject хийж чадахгүй", async () => {
  order();
  await assert.rejects(() => so.markSellerOrderReady("o1", "sellerB"), (e: any) => e.status === 404);
  await assert.rejects(() => so.rejectSellerOrder("o1", "шалтгаан бичив", "sellerB"), (e: any) => e.status === 404);
  const o = db.get("order", "o1")!;
  assert.equal(o.sellerStatus, "AWAITING_SELLER");
  assert.ok(!o.cancelledAt);
});

test("худалдагчгүй (өөрийн дэлгүүрийн) захиалгад seller хандаж чадахгүй", async () => {
  order({ id: "o2", sellerId: null, sellerStatus: null });
  await assert.rejects(() => so.acceptSellerOrder("o2", "sellerA"), (e: any) => e.status === 404);
});

test("өөр seller-ийн барааг засаж чадахгүй", async () => {
  db.seed("product", { id: "p1", sellerId: "sellerA", sellStockQty: 5, sellPrice: 1000, isActive: true });
  await assert.rejects(() => sp.updateSellerProduct("sellerB", "p1", { isActive: false }), (e: any) => e.status === 404);
  assert.equal(db.get("product", "p1")!.isActive, true);
});

test("өөр seller-ийн listing хүсэлтийг withdraw хийж чадахгүй", async () => {
  db.seed("productListingRequest", { id: "l1", sellerId: "sellerA", status: "PENDING" });
  await assert.rejects(() => lr.withdrawListingRequest("sellerB", "l1"));
  assert.equal(db.get("productListingRequest", "l1")!.status, "PENDING");
});

test("курьер өөрт оноогдоогүй хүргэлтийг баталгаажуулж чадахгүй", async () => {
  db.seed("order", { id: "d1", courierId: "cA", deliveryAssignStatus: "PICKED_UP", orderType: "ONLINE", items: [] });
  await assert.rejects(() => da.confirmDeliveryStep("d1", "cB", "1234"), /танд оноогдоогүй/);
  assert.equal(db.get("order", "d1")!.deliveryAssignStatus, "PICKED_UP");
});
