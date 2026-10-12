// ============================================================================
// МАТЕРИАЛЫН НӨӨЦ (см²) — C: нэхэмжлэл/checkout-ээс өмнөх шалгалт, B: төлбөр орох үеийн АТОМИК хасалт
// ----------------------------------------------------------------------------
// Дүрэм: нөөц ХЭЗЭЭ Ч сөрөг болохгүй. Зэрэг захиалгаас төлбөр нь ТҮРҮҮЛЖ баталгаажсан нь авна;
// хожигдсон нь юу ч бичигдэхгүй (касс) эсвэл INSUFFICIENT_STOCK + refundDue (gateway).
// ⚠️ fake Prisma (санах ой) дээр — бодит PostgreSQL дээрх зэрэгцээ ажиллагааг ТУРШААГҮЙ.
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { behavior, db, load, reset, seedGatewayTx, seedOrder, seedProduct } from "./support/harness";

behavior.realMaterial = true; // ⚠️ load()-оос ӨМНӨ — бодит material.service

import { InsufficientStockError } from "../src/lib/stock-guards";

const mat = load<typeof import("../src/services/material.service")>("services/material.service");
const orderPayment = load<typeof import("../src/services/order-payment.service")>("services/order-payment.service");
const settlement = load<typeof import("../src/services/gateway-settlement.service")>("services/gateway-settlement.service");
const invoice = load<typeof import("../src/services/invoice.service")>("services/invoice.service");

beforeEach(() => reset());

const CASH = "CASH" as any;
const stockOf = (id: string) => db.get("material", id)!.stockCm2 as number;
const orderOf = (id: string) => db.get("order", id)!;
const gtxOf = (id: string) => db.get("gatewayTransaction", id)!;
const movements = (id: string) => db.all("materialMovement").filter((m) => m.materialId === id);
const payments = (orderId: string) => db.all("payment").filter((p) => p.orderId === orderId);

function seedMaterial(id: string, stockCm2: number, minStockCm2 = 0) {
  return db.seed("material", { id, name: `Материал ${id}`, stockCm2, minStockCm2 });
}

/** Материалаар үнэлэгдэх нэг SALE мөртэй захиалга: хэрэгцээ = areaCm2 × qty. */
function seedMatOrder(id: string, materialId: string, areaCm2: number, qty: number, total = 100) {
  const productId = `mp-${id}`;
  seedProduct(productId, 0);
  seedOrder({ id, total, productId, qty });
  const o = db.get("order", id)!;
  o.items[0].product = { ...o.items[0].product, usesMaterialPricing: true };
  Object.assign(o.items[0], { materialId, areaCm2 });
  db.seed("order", o);
  db.seed("orderItem", o.items[0]);
}

// ---------------------------------------------------------------- цэвэр дүрэм
test("totalsByMaterial: нэгтгэнэ, materialId-аар эрэмбэлнэ, хоосон/хүчингүй мөрийг алгасна", () => {
  const t = mat.totalsByMaterial([
    { materialId: "b", areaCm2: 100, quantity: 2 },
    { materialId: "a", areaCm2: 50, quantity: 1 },
    { materialId: "b", areaCm2: 10, quantity: 3 },
    { materialId: null, areaCm2: 99, quantity: 1 },
    { materialId: "c", areaCm2: null, quantity: 1 },
    { materialId: "d", areaCm2: 10, quantity: 0 },
  ]);
  assert.deepEqual(t, [["a", 50], ["b", 230]]);
});

// ---------------------------------------------------------------- C: урьдчилсан шалгалт
test("C: assertMaterialsAvailable — хүрэхгүй бол нэр, см²-ээр тайлбарласан InsufficientStockError", async () => {
  seedMaterial("M", 500);
  await assert.rejects(
    () => mat.assertMaterialsAvailable(db.client() as any, [{ materialId: "M", areaCm2: 300, quantity: 2 }]),
    (e: any) => e instanceof InsufficientStockError && /Материал M/.test(e.message) && /600 см²/.test(e.message) && /500 см²/.test(e.message)
  );
  await mat.assertMaterialsAvailable(db.client() as any, [{ materialId: "M", areaCm2: 250, quantity: 2 }]); // яг 500 = хүрнэ
  assert.equal(stockOf("M"), 500); // шалгалт нөөц хөдөлгөөгүй
  assert.equal(movements("M").length, 0);
});

test("C: байхгүй материал = нөөц 0 → хүрэхгүй", async () => {
  await assert.rejects(() => mat.assertMaterialsAvailable(db.client() as any, [{ materialId: "GONE", areaCm2: 1, quantity: 1 }]), InsufficientStockError);
});

test("C: INVOICE — материал хүрэхгүй захиалгад нэхэмжлэл үүсгэхгүй", async () => {
  seedMaterial("M", 100);
  seedMatOrder("A", "M", 100, 2); // 200 хэрэгтэй, 100 байна
  await assert.rejects(
    () => invoice.createGatewayInvoice({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", orderId: "A", amount: 100 } as any),
    invoice.InvalidInvoiceError
  );
  assert.equal(db.all("gatewayTransaction").length, 0);
});

test("C: INVOICE — материал хүрэлцэхүйц бол нэхэмжлэл үүснэ", async () => {
  seedMaterial("M", 200);
  seedMatOrder("A", "M", 100, 2);
  const r = await invoice.createGatewayInvoice({ provider: "QPAY" as any, purpose: "ORDER_PAYMENT" as any, description: "t", orderId: "A", amount: 100 } as any);
  assert.ok(r);
});

test("C: аль хэдийн БҮРЭН төлөгдсөн (нөөц хасагдсан) бүлгийн гишүүнийг давхар тоолохгүй", async () => {
  seedMaterial("M", 100);
  seedMatOrder("PAIDM", "M", 100, 1); // 100 — төлөгдсөн гэж үзнэ (нөөц хэдийнэ хасагдсан)
  seedMatOrder("OPEN", "M", 100, 1); //  100 — нээлттэй
  const paid = db.get("order", "PAIDM")!; // db.get клон буцаадаг тул өөрчлөөд буцааж seed хийнэ
  Object.assign(paid, { paymentStatus: "PAID" });
  db.seed("order", paid);
  // нөөц 100: нээлттэй 100 → хүрнэ. PAID-ыг тоовол 200 > 100 гэж буруу татгалзах байсан.
  await mat.assertOrdersMaterialsAvailable(db.client() as any, ["PAIDM", "OPEN"]);
});

// ---------------------------------------------------------------- B: атомик хасалт
test("B: consume — хүрэлцэхүйц бол хасна, хөдөлгөөн (balanceAfter) бичнэ, доод хэмжээнээс доош орвол буцаана", async () => {
  seedMaterial("M", 1000, 500);
  const low = await mat.consumeMaterialsForOrder(db.client() as any, { id: "A", orderNumber: "N-A" }, [{ materialId: "M", areaCm2: 100, quantity: 6 }]);
  assert.equal(stockOf("M"), 400);
  assert.equal(movements("M").length, 1);
  assert.equal(movements("M")[0].quantityCm2, -600);
  assert.equal(movements("M")[0].balanceAfterCm2, 400);
  assert.equal(low.length, 1);
  assert.equal(low[0].id, "M");
});

test("B: consume — хүрэхгүй бол InsufficientStockError, нөөц ХЭВЭЭР, хөдөлгөөн бичигдэхгүй (сөрөг болохгүй)", async () => {
  seedMaterial("M", 500);
  await assert.rejects(
    () => mat.consumeMaterialsForOrder(db.client() as any, { id: "A", orderNumber: "N-A" }, [{ materialId: "M", areaCm2: 100, quantity: 6 }]),
    InsufficientStockError
  );
  assert.equal(stockOf("M"), 500);
  assert.equal(movements("M").length, 0);
});

test("B: касс — нөөц 1000, 5 захиалга тус бүр 300 → яг 3 нь амжилттай, үлдэгдэл 100, ХЭЗЭЭ Ч сөрөг биш", async () => {
  seedMaterial("M", 1000);
  for (let i = 0; i < 5; i++) seedMatOrder(`o${i}`, "M", 100, 3);
  const rs = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => orderPayment.applyOrderPayment(`o${i}`, 100, CASH)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 3);
  for (const r of rs) if (r.status === "rejected") assert.match(String(r.reason.message), /Нөөц хүрэлцэхгүй/);
  assert.equal(stockOf("M"), 100);
  assert.equal(movements("M").length, 3);
  assert.equal(db.all("order").filter((o) => o.paymentStatus === "PAID").length, 3);
  for (const o of db.all("order").filter((o) => o.paymentStatus !== "PAID")) {
    assert.equal(o.paidAmount, 0);
    assert.equal(payments(o.id).length, 0); // ялагдсан захиалгад юу ч бичигдээгүй
  }
});

test("B: ROLLBACK — материал дутвал ӨМНӨ нь хасагдсан барааны нөөц/төлбөр ч буцна (бүх зүйл нэг transaction)", async () => {
  seedMaterial("M", 50);
  seedProduct("P", 10);
  seedMatOrder("A", "M", 100, 1);
  // ижил захиалгад энгийн бараа нэмнэ (энэ нь материалаас ӨМНӨ хасагддаг)
  const o = db.get("order", "A")!;
  const plain = { id: "item-A-P", orderId: "A", productId: "P", itemType: "SALE", quantity: 3, materialId: null, areaCm2: null, product: { id: "P", name: "Бараа P", usesMaterialPricing: false } };
  o.items.push(plain);
  db.seed("order", o);
  db.seed("orderItem", plain);
  await assert.rejects(() => orderPayment.applyOrderPayment("A", 100, CASH), /Нөөц хүрэлцэхгүй/);
  assert.equal(db.get("product", "P")!.sellStockQty, 10);
  assert.equal(stockOf("M"), 50);
  assert.equal(orderOf("A").paymentStatus, "PENDING");
  assert.equal(payments("A").length, 0);
  assert.equal(db.all("stockMovement").length, 0);
  assert.equal(movements("M").length, 0);
});

test("B: ДАВХАР ХАСАЛТ — нэг захиалгыг 5 удаа зэрэг төлөхөд материал НЭГ л удаа хасагдана", async () => {
  seedMaterial("M", 1000);
  seedMatOrder("A", "M", 100, 3);
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => orderPayment.applyOrderPayment("A", 100, CASH)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(stockOf("M"), 700);
  assert.equal(movements("M").length, 1);
});

test("B: GATEWAY — сүүлийн нөөцөнд зэрэг хоёр төлбөр: түрүүлж баталгаажсан нь авна, нөгөө нь INSUFFICIENT_STOCK + refundDue", async () => {
  seedMaterial("M", 300);
  seedMatOrder("A", "M", 100, 3);
  seedMatOrder("B", "M", 100, 3);
  const ga = seedGatewayTx({ orderId: "A", amount: 100 });
  const gb = seedGatewayTx({ orderId: "B", amount: 100 });
  const rs = await Promise.all([settlement.confirmAndSettle(gtxOf(ga.id)), settlement.confirmAndSettle(gtxOf(gb.id))]);
  assert.equal(rs.filter((r) => r.kind === "APPLIED").length, 1);
  const un = rs.find((r) => r.kind === "UNAPPLIED") as any;
  assert.equal(un.reason, "INSUFFICIENT_STOCK");
  assert.equal(stockOf("M"), 0);
  const loser = orderOf(["A", "B"].find((id) => orderOf(id).paymentStatus !== "PAID")!);
  assert.equal(loser.paymentStatus, "PENDING");
  assert.equal(loser.paidAmount, 0);
  assert.equal(loser.refundDueAmount, 100); // Staff мөнгийг буцаана
  assert.equal(payments(loser.id).length, 0);
  const tx = [ga, gb].map((g) => gtxOf(g.id)).find((g) => g.orderId === loser.id)!;
  assert.equal(tx.rawCallback._unapplied.reason, "INSUFFICIENT_STOCK");
  assert.match(String(tx.rawCallback._unapplied.detail), /см²/);
});

// ---------------------------------------------------------------- SET (тооллого) — compare-and-set
/** Эхний material.findUnique-ийн ДАРАА (бичилтийн өмнө) нөөцийг зэрэг үйлдлээр өөрчилнө. */
function dbWithConcurrentChange(materialId: string, newStock: number) {
  const c: any = db.client();
  let fired = false;
  const material = new Proxy(c.material, {
    get: (t, k: string) =>
      k === "findUnique"
        ? async (a: any) => {
            const r = await t.findUnique(a);
            if (!fired) {
              fired = true;
              db.seed("material", { ...db.get("material", materialId)!, stockCm2: newStock });
            }
            return r;
          }
        : (...a: any[]) => t[k](...a),
  });
  return new Proxy(c, { get: (t, k: string) => (k === "material" ? material : t[k]) });
}

test("SET: нөөцийг яг тооллогын утга болгоно, ADJUSTMENT хөдөлгөөн (зөрүү, үлдэгдэл) бичнэ", async () => {
  seedMaterial("M", 1000);
  const u = await mat.setMaterialStock(db.client() as any, "M", 400, { note: "тооллого" });
  assert.equal(u!.stockCm2, 400);
  assert.equal(stockOf("M"), 400);
  assert.equal(movements("M").length, 1);
  assert.equal(movements("M")[0].quantityCm2, -600);
  assert.equal(movements("M")[0].balanceAfterCm2, 400);
  assert.equal(movements("M")[0].type, "ADJUSTMENT");
});

test("SET: утга ижил бол хөдөлгөөн бичихгүй; материал байхгүй бол null; сөрөг/бутархай татгалзана", async () => {
  seedMaterial("M", 500);
  await mat.setMaterialStock(db.client() as any, "M", 500);
  assert.equal(movements("M").length, 0);
  assert.equal(await mat.setMaterialStock(db.client() as any, "GONE", 10), null);
  for (const bad of [-1, 1.5, NaN]) await assert.rejects(() => mat.setMaterialStock(db.client() as any, "M", bad), /бүхэл тоо/);
  assert.equal(stockOf("M"), 500);
});

test("SET: уншилт ба бичилтийн хооронд зэрэг захиалга нөөц хасвал CONFLICT — буруу үлдэгдэл бичигдэхгүй, хөдөлгөөн үлдэхгүй", async () => {
  seedMaterial("M", 1000);
  // тоолуур 400 гэж тоолсон; уншсаны дараа зэрэг захиалга 1000 → 700 болгосон
  await assert.rejects(
    () => mat.setMaterialStock(dbWithConcurrentChange("M", 700) as any, "M", 400),
    (e: any) => e instanceof mat.MaterialStockConflictError && e.status === 409
  );
  assert.equal(stockOf("M"), 700); // тооллогоор дарагдаагүй, зэрэг үйлдлийн үр дүн хэвээр
  assert.equal(movements("M").length, 0);
  // дахин оролдвол (шинэ уншилтаар) амжилттай
  const u = await mat.setMaterialStock(db.client() as any, "M", 400);
  assert.equal(u!.stockCm2, 400);
  assert.equal(movements("M").length, 1);
  assert.equal(movements("M")[0].quantityCm2, -300);
});
