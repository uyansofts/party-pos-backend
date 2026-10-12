// ============================================================================
// MARKETPLACE CHECKOUT — нэг сагсыг худалдагчаар хуваах, нэг хэсэг унавал өмнөхийг цуцлах, шалгалтууд
// ⚠️ ЗӨВХӨН checkoutCart-ийн зохион байгуулалтыг (orchestration) шалгана. Доторх `checkout`/`cancelOrder` (order.service)-ийг
//    тестийн дотор ОРЛУУЛСАН (stub) — үнэ, нөөц, түрээсийн бодит тооцоог энд ТУРШААГҮЙ. fake Prisma (санах ой) дээр.
// ============================================================================
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import Module from "module";
import { db, install, reset } from "./support/harness";

// ---- order.service-ийн орлуулагч: зөвхөн marketplace-checkout.service-ээс "./order.service" гэж дуудахад ----
class CheckoutValidationError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "CheckoutValidationError";
  }
}
const checkoutCalls: Array<{ input: any; options: any; extras: any }> = [];
const cancelCalls: Array<{ id: string; confirmed: boolean }> = [];
const control = { failOnCall: 0, cancelFailsFor: new Set<string>() };
let seq = 0;

async function fakeCheckout(input: any, options: any = {}) {
  const n = ++seq;
  checkoutCalls.push({ input, options, extras: undefined });
  if (control.failOnCall && checkoutCalls.length === control.failOnCall) throw new CheckoutValidationError("нөөц хүрэлцэхгүй");
  const itemsTotal = input.items.reduce((s: number, i: any) => s + i.quantity * 1000, 0);
  const extras = options.orderExtras ? options.orderExtras({ itemsTotal, generateOtp: () => "4821", lines: undefined }) : {};
  checkoutCalls[checkoutCalls.length - 1].extras = options.orderExtras ? extras : undefined;
  const delivery = 3000;
  const row = db.seed("order", {
    id: `ord-${n}`,
    orderNumber: `N${n}`,
    paymentStatus: "PENDING",
    totalAmount: itemsTotal + delivery,
    deliveryFee: delivery,
    deliveryOtp: `OTP${n}`,
    orderGroupId: null,
    cancelledAt: null,
    ...extras,
    items: input.items.map((i: any, k: number) => ({ id: `it-${n}-${k}`, productId: i.productId, quantity: i.quantity })),
  });
  return row;
}
async function fakeCancel(id: string, confirmed = false) {
  cancelCalls.push({ id, confirmed });
  if (control.cancelFailsFor.has(id)) throw new Error("cancel failed");
  const o = db.get("order", id)!;
  db.seed("order", { ...o, paymentStatus: "CANCELLED", cancelledAt: new Date() });
}

install();
const M: any = Module;
const prev = M._load;
M._load = function (request: string, parent: any, ...rest: any[]) {
  if (request === "./order.service" && String(parent?.filename).replace(/\\/g, "/").endsWith("services/marketplace-checkout.service.ts")) {
    return { checkout: fakeCheckout, cancelOrder: fakeCancel, CheckoutValidationError, __esModule: true };
  }
  return prev.call(this, request, parent, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mc = require("../src/services/marketplace-checkout.service") as typeof import("../src/services/marketplace-checkout.service");
M._load = prev;

beforeEach(() => {
  mock.restoreAll();
  reset();
  checkoutCalls.length = 0;
  cancelCalls.length = 0;
  control.failOnCall = 0;
  control.cancelFailsFor.clear();
  seq = 0;
  mock.method(console, "error", () => undefined);
});

// ---------------------------------------------------------------- seed
function seedShop(over: Record<string, unknown> = {}) {
  db.seed("shopSettings", { id: "default", marketplaceEnabled: true, featuredCommissionExtraPercent: 2, saleCommissionExtraPercent: 2, ...over });
}
function seedSeller(id: string, over: Record<string, unknown> = {}) {
  return db.seed("seller", { id, name: `Худалдагч ${id}`, status: "ACTIVE", commissionPercent: 10, pickupAddress: `${id} хаяг`, pickupLatitude: 47.9, pickupLongitude: 106.9, ...over });
}
function seedProduct(id: string, sellerId: string | null) {
  return db.seed("product", { id, sellerId, sellPrice: 1000, salePrice: null, salePercent: null, saleStartsAt: null, saleEndsAt: null, isFeatured: false, featuredUntil: null });
}
const cart = (productIds: Array<[string, number]>, over: Record<string, unknown> = {}) => ({
  orderType: "ONLINE" as const,
  deliveryMethod: "DELIVERY" as const,
  items: productIds.map(([productId, quantity]) => ({ productId, itemType: "SALE" as const, quantity })),
  ...over,
});

// ---------------------------------------------------------------- хуваалт
test("СААГ: худалдагчийн бараагүй сагс — хуучин урсгал огт өөрчлөгдөхгүй (нэг checkout, бүлэггүй)", async () => {
  seedShop();
  seedProduct("own1", null);
  const r: any = await mc.checkoutCart(cart([["own1", 2]]) as any);
  assert.equal(checkoutCalls.length, 1);
  assert.deepEqual(checkoutCalls[0].options, {}); // marketplace тохиргоо дамжаагүй
  assert.equal(r.groupOrders, undefined);
  assert.equal(db.get("order", "ord-1")!.orderGroupId, null);
});

test("СААГ: хоосон сагс — хуучин алдаа шиг нэг checkout руу дамжина", async () => {
  await mc.checkoutCart({ items: [] } as any);
  assert.equal(checkoutCalls.length, 1);
});

test("СААГ: өөрийн бараа + 2 худалдагч → 3 тусдаа захиалга (өөрийнх эхэнд), бүгд нэг бүлэгт, нийт дүн нийлбэр", async () => {
  seedShop();
  seedSeller("sA", { commissionPercent: 10 });
  seedSeller("sB", { commissionPercent: 20, pickupLatitude: null, pickupLongitude: null });
  seedProduct("own", null);
  seedProduct("a1", "sA");
  seedProduct("a2", "sA");
  seedProduct("b1", "sB");
  const r: any = await mc.checkoutCart(cart([["a1", 1], ["b1", 2], ["own", 1], ["a2", 3]]) as any);

  assert.equal(checkoutCalls.length, 3);
  // 1) өөрийн дэлгүүр: худалдагчийн тохиргоогүй
  assert.deepEqual(checkoutCalls[0].input.items.map((i: any) => i.productId), ["own"]);
  assert.equal(checkoutCalls[0].options.allowSellerItems, false);
  // 2) sA: a1 + a2 НЭГ захиалгад (мөрийн дараалал хадгалагдана)
  assert.deepEqual(checkoutCalls[1].input.items.map((i: any) => i.productId), ["a1", "a2"]);
  assert.equal(checkoutCalls[1].options.allowSellerItems, true);
  assert.deepEqual(checkoutCalls[1].options.originOverride, { latitude: 47.9, longitude: 106.9 });
  // 3) sB: координатгүй → originOverride null (дэлгүүрийн байршлаар)
  assert.deepEqual(checkoutCalls[2].input.items.map((i: any) => i.productId), ["b1"]);
  assert.equal(checkoutCalls[2].options.originOverride, null);

  // худалдагчийн захиалгын нэмэлт талбарууд
  const a = checkoutCalls[1].extras;
  assert.equal(a.sellerId, "sA");
  assert.equal(a.sellerStatus, "PENDING_PAYMENT"); // төлбөр орсны дараа л худалдагчид мэдэгдэнэ
  assert.equal(a.commissionAmount, 400); // (1+3) × 1000 = 4000 × 10%
  assert.equal(a.pickupAddress, "sA хаяг");
  assert.equal(a.pickupOtp, "4821");
  assert.equal(checkoutCalls[2].extras.commissionAmount, 400); // 2 × 1000 × 20%
  assert.equal(checkoutCalls[0].extras, undefined); // өөрийн хэсэгт худалдагчийн талбар огт байхгүй

  // бүлэг: бүгд ҮНДСЭН (эхний) захиалгын id-г заана
  const ids = ["ord-1", "ord-2", "ord-3"];
  for (const id of ids) assert.equal(db.get("order", id)!.orderGroupId, "ord-1");
  assert.equal(r.orderGroupId, "ord-1");
  assert.equal(r.id, "ord-1");
  const sumTotal = ids.reduce((s, id) => s + Number(db.get("order", id)!.totalAmount), 0);
  assert.equal(r.totalAmount, sumTotal);
  assert.equal(r.groupTotalAmount, sumTotal);
  assert.equal(r.deliveryFee, 9000); // 3 × 3000
  assert.equal(r.groupOrders.length, 3);
  assert.deepEqual(r.groupOrders.map((g: any) => g.sellerName), [null, "Худалдагч sA", "Худалдагч sB"]);
  assert.equal(r.items.length, 4); // бүх мөр нэгтгэгдсэн
  assert.equal(cancelCalls.length, 0);
});

test("СААГ: зөвхөн нэг худалдагчийн бараа — 1 захиалга, өөрийн хэсэггүй, бүлгийн id нь өөрөө", async () => {
  seedShop();
  seedSeller("sA");
  seedProduct("a1", "sA");
  const r: any = await mc.checkoutCart(cart([["a1", 1]]) as any);
  assert.equal(checkoutCalls.length, 1);
  assert.equal(r.groupOrders.length, 1);
  assert.equal(r.orderGroupId, r.id);
});

// ---------------------------------------------------------------- ХАГАС САГС ҮЛДЭХГҮЙ
test("УНАЛТ: 3 дахь хэсэг унавал өмнөх 2 захиалга цуцлагдана (confirmed=true), алдаа дахин шидэгдэнэ, бүлэг үүсэхгүй", async () => {
  seedShop();
  seedSeller("sA");
  seedSeller("sB");
  seedProduct("own", null);
  seedProduct("a1", "sA");
  seedProduct("b1", "sB");
  control.failOnCall = 3;
  await assert.rejects(() => mc.checkoutCart(cart([["own", 1], ["a1", 1], ["b1", 1]]) as any), (e: any) => e instanceof CheckoutValidationError && /нөөц/.test(e.message));
  assert.deepEqual(cancelCalls, [{ id: "ord-1", confirmed: true }, { id: "ord-2", confirmed: true }]);
  for (const id of ["ord-1", "ord-2"]) {
    assert.equal(db.get("order", id)!.paymentStatus, "CANCELLED");
    assert.equal(db.get("order", id)!.orderGroupId, null); // бүлэг үүсээгүй
  }
  assert.equal(db.all("order").length, 2); // 3 дахь нь огт үүсээгүй
});

test("УНАЛТ: эхний хэсэг унавал цуцлах зүйл байхгүй", async () => {
  seedShop();
  seedSeller("sA");
  seedProduct("a1", "sA");
  control.failOnCall = 1;
  await assert.rejects(() => mc.checkoutCart(cart([["a1", 1]]) as any), CheckoutValidationError);
  assert.equal(cancelCalls.length, 0);
  assert.equal(db.all("order").length, 0);
});

test("УНАЛТ: нэг цуцлалт унасан ч бусдыг цуцлахаа үргэлжлүүлж, ЭХНИЙ алдааг далдлахгүй", async () => {
  seedShop();
  seedSeller("sA");
  seedSeller("sB");
  seedProduct("own", null);
  seedProduct("a1", "sA");
  seedProduct("b1", "sB");
  control.failOnCall = 3;
  control.cancelFailsFor.add("ord-1");
  await assert.rejects(() => mc.checkoutCart(cart([["own", 1], ["a1", 1], ["b1", 1]]) as any), /нөөц хүрэлцэхгүй/);
  assert.deepEqual(cancelCalls.map((c) => c.id), ["ord-1", "ord-2"]); // ord-1 унасан ч ord-2 хүртэл явсан
  assert.equal(db.get("order", "ord-2")!.paymentStatus, "CANCELLED");
  assert.equal(db.get("order", "ord-1")!.paymentStatus, "PENDING"); // Staff гараар цуцлах (console.error-д бичигдсэн)
});

// ---------------------------------------------------------------- ШАЛГАЛТ (ямар ч захиалга үүсэхээс ӨМНӨ)
test("ШАЛГАЛТ: зөвхөн ONLINE захиалгад — POS-оор худалдагчийн бараа зарахгүй, юу ч үүсэхгүй", async () => {
  seedShop();
  seedSeller("sA");
  seedProduct("a1", "sA");
  await assert.rejects(() => mc.checkoutCart(cart([["a1", 1]], { orderType: "POS" }) as any), /зөвхөн онлайн/);
  await assert.rejects(() => mc.checkoutCart({ items: [{ productId: "a1", itemType: "SALE", quantity: 1 }], deliveryMethod: "DELIVERY" } as any), /зөвхөн онлайн/); // orderType өгөөгүй = POS
  assert.equal(checkoutCalls.length, 0);
});

test("ШАЛГАЛТ: marketplace унтраалттай бол татгалзана", async () => {
  seedShop({ marketplaceEnabled: false });
  seedSeller("sA");
  seedProduct("a1", "sA");
  await assert.rejects(() => mc.checkoutCart(cart([["a1", 1]]) as any), /нээгдээгүй/);
  assert.equal(checkoutCalls.length, 0);
});

test("ШАЛГАЛТ: хүргэлтийн арга DELIVERY биш бол (PICKUP, POST, UB_CAB …) татгалзана", async () => {
  seedShop();
  seedSeller("sA");
  seedProduct("a1", "sA");
  for (const m of ["PICKUP", "POST", "LOCAL_TRANSPORT", "UB_CAB", undefined]) {
    await assert.rejects(() => mc.checkoutCart(cart([["a1", 1]], { deliveryMethod: m }) as any), /манай курьерээр/);
  }
  assert.equal(checkoutCalls.length, 0);
});

test("ШАЛГАЛТ: идэвхгүй / түр хаасан / олдохгүй худалдагч — ХЭДИЙН ОДОО ЧАДСАН ХЭСЭГ ч үүсгэхгүй (өөрийн бараатай сагсанд ч)", async () => {
  seedShop();
  seedSeller("sGood");
  seedSeller("sBad", { status: "SUSPENDED" });
  seedProduct("own", null);
  seedProduct("g1", "sGood");
  seedProduct("bad1", "sBad");
  await assert.rejects(() => mc.checkoutCart(cart([["own", 1], ["g1", 1], ["bad1", 1]]) as any), /захиалга авахгүй/);
  // sellerId заасан боловч худалдагчийн мөр байхгүй
  seedProduct("ghost1", "sGhost");
  await assert.rejects(() => mc.checkoutCart(cart([["own", 1], ["ghost1", 1]]) as any), /захиалга авахгүй/);
  assert.equal(checkoutCalls.length, 0);
  assert.equal(db.all("order").length, 0);
});

test("КОМИСС: худалдагч бүр ӨӨРИЙН хувиар; хувь 0..100-д хязгаарлагдана; өөрийн хэсэгт комисс байхгүй", async () => {
  seedShop();
  seedSeller("s0", { commissionPercent: 0 });
  seedSeller("s100", { commissionPercent: 150 }); // буруу өгөгдөл → 100%-д хязгаарлагдана
  seedProduct("z", "s0");
  seedProduct("h", "s100");
  await mc.checkoutCart(cart([["z", 2], ["h", 2]]) as any);
  assert.equal(checkoutCalls[0].extras.commissionAmount, 0);
  assert.equal(checkoutCalls[1].extras.commissionAmount, 2000); // 2000 × 100%
});
