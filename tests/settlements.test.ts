// ============================================================================
// COURIER / SELLER ТООЦОО (payout) — давхар олголт, зэрэгцээ дарах, хэсэгчилсэн алдаа, хүлээлтийн хугацаа, буцаалт
// ⚠️ Зөвхөн БҮРТГЭЛ (бодит мөнгө шилжүүлэхгүй). fake Prisma (санах ой) дээр — бодит PostgreSQL дээрх зэрэгцээ ажиллагааг ТУРШААГҮЙ.
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset } from "./support/harness";
import { computeCourierPayout } from "../src/lib/courier-payout";

const courierSvc = load<typeof import("../src/services/courier-settlement.service")>("services/courier-settlement.service");
const sellerSvc = load<typeof import("../src/services/seller-settlement.service")>("services/seller-settlement.service");

beforeEach(() => reset());

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const orderOf = (id: string) => db.get("order", id)!;

// ---------------------------------------------------------------- COURIER
function seedCourier(id = "C1") {
  return db.seed("courier", { id, name: "Бат", lastName: "Дорж", nickname: null, phone: "99112233", bankAccountNumber: "123", bankIban: null, bankName: "Хаан" });
}
function seedDelivered(id: string, o: { courierId?: string; fee?: number; payment?: string; status?: string; cancellationFee?: number; paid?: boolean } = {}) {
  return db.seed("order", {
    id,
    orderNumber: `N-${id}`,
    orderType: "ONLINE",
    courierId: o.courierId ?? "C1",
    deliveryAssignStatus: o.status ?? "DELIVERED",
    paymentStatus: o.payment ?? "PAID",
    deliveryFee: o.fee ?? 5000,
    serviceAmount: 0,
    cancellationFee: o.cancellationFee ?? 0,
    courierFeePaid: o.paid ?? false,
    deliveryAddress: "СБД",
    deliveredAt: new Date(NOW - DAY),
    cancelledAt: null,
    createdAt: new Date(NOW - 2 * DAY),
  });
}
const payoutsOf = (table: "courierPayout" | "sellerPayout") => db.all(table);
const net = (fee: number) => computeCourierPayout({ deliveryFee: fee, serviceAmount: 0 }, 15, null).totalPayout; // ShopSettings байхгүй → 15%

test("COURIER: нэг багцаар төлнө — хөлс (комисс хассан) зөв, захиалга бүр тэмдэглэгдэнэ, нэг payout мөр", async () => {
  seedCourier();
  seedDelivered("a", { fee: 5000 });
  seedDelivered("b", { fee: 8000 });
  const r = await courierSvc.payCourierBatch("C1", ["a", "b"], "CASH", " оройн тооцоо ");
  assert.equal(r.totalAmount, net(5000) + net(8000));
  assert.equal(r.orderCount, 2);
  assert.equal(r.note, "оройн тооцоо");
  assert.equal(payoutsOf("courierPayout").length, 1);
  for (const id of ["a", "b"]) {
    assert.equal(orderOf(id).courierFeePaid, true);
    assert.equal(orderOf(id).courierPayoutId, r.id);
  }
  assert.equal(orderOf("a").courierPayoutAmount, net(5000));
});

test("COURIER: дахин дарвал давхар олгохгүй (жагсаалтад үлдээгүй) — payout нэмэгдэхгүй", async () => {
  seedCourier();
  seedDelivered("a");
  await courierSvc.payCourierBatch("C1", ["a"], "CASH");
  await assert.rejects(() => courierSvc.payCourierBatch("C1", ["a"], "CASH"), /жагсаалтад байхгүй|аль хэдийн/);
  assert.equal(payoutsOf("courierPayout").length, 1);
});

test("COURIER ЗЭРЭГЦЭЭ: хоёр Staff нэгэн зэрэг дарахад НЭГ л payout, нөгөө нь бүхэлдээ буцна", async () => {
  seedCourier();
  seedDelivered("a");
  seedDelivered("b");
  const rs = await Promise.allSettled([courierSvc.payCourierBatch("C1", ["a", "b"], "CASH"), courierSvc.payCourierBatch("C1", ["a", "b"], "CASH")]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(payoutsOf("courierPayout").length, 1); // ялагдсан transaction-ий batch мөр үлдээгүй
  assert.equal(orderOf("a").courierFeePaid, true);
});

test("COURIER: харилцагч төлөөгүй (PAID биш) захиалгыг нэг мөсөн төлөхөөс хориглоно, юу ч өөрчлөгдөхгүй", async () => {
  seedCourier();
  seedDelivered("ok");
  seedDelivered("unpaid", { payment: "PENDING" });
  await assert.rejects(() => courierSvc.payCourierBatch("C1", ["ok", "unpaid"], "CASH"), /харилцагч төлөөгүй/);
  assert.equal(orderOf("ok").courierFeePaid, false);
  assert.equal(payoutsOf("courierPayout").length, 0);
});

test("COURIER: өөр курьерийн / байхгүй захиалга, давхардсан id, буруу арга татгалзана", async () => {
  seedCourier("C1");
  seedCourier("C2");
  seedDelivered("mine", { courierId: "C1" });
  seedDelivered("theirs", { courierId: "C2" });
  await assert.rejects(() => courierSvc.payCourierBatch("C1", ["theirs"], "CASH"), /жагсаалтад байхгүй/);
  await assert.rejects(() => courierSvc.payCourierBatch("C1", ["mine", "mine"], "CASH"), /давхардсан/);
  await assert.rejects(() => courierSvc.payCourierBatch("C1", [], "CASH"), /сонгоно уу/);
  await assert.rejects(() => courierSvc.payCourierBatch("C1", ["mine"], "CRYPTO"), /бэлнээр эсвэл дансаар/);
  assert.equal(payoutsOf("courierPayout").length, 0);
  assert.equal(orderOf("theirs").courierFeePaid, false);
});

test("COURIER: авсны дараа цуцлагдсан нөхөн олговортой захиалга төлөгдөнө; олговоргүй цуцлалт жагсаалтад ордоггүй", async () => {
  seedCourier();
  seedDelivered("fee", { status: "CANCELLED", cancellationFee: 3000, fee: 3000 });
  seedDelivered("nofee", { status: "CANCELLED", cancellationFee: 0 });
  const s = await courierSvc.getUnpaidSettlement("C1");
  assert.deepEqual(s.items.map((i) => i.orderId), ["fee"]);
  assert.equal(s.items[0].kind, "CANCELLED_FEE");
});

// ---------------------------------------------------------------- SELLER
function seedSeller(id = "S1", bank = true) {
  return db.seed("seller", { id, name: `Дэлгүүр ${id}`, phone: "88001122", commissionPercent: 10, bankName: bank ? "Хаан" : null, bankAccountNumber: bank ? "555" : null, bankAccountHolder: bank ? "Б" : null });
}
function seedSellerOrder(id: string, o: { sellerId?: string; total?: number; commission?: number; deliveredDaysAgo?: number; status?: string; payment?: string; refundedAt?: Date | null; cancelledAt?: Date | null; payoutId?: string | null; fee?: number } = {}) {
  return db.seed("order", {
    id,
    orderNumber: `N-${id}`,
    sellerId: o.sellerId ?? "S1",
    sellerStatus: o.status ?? "READY",
    deliveryAssignStatus: "DELIVERED",
    paymentStatus: o.payment ?? "PAID",
    totalAmount: o.total ?? 50000,
    deliveryFee: o.fee ?? 5000,
    urgentFee: 0,
    commissionAmount: o.commission ?? 4500,
    deliveredAt: new Date(NOW - (o.deliveredDaysAgo ?? 5) * DAY),
    cancelledAt: o.cancelledAt ?? null,
    refundedAt: o.refundedAt ?? null,
    sellerPayoutId: o.payoutId ?? null,
    createdAt: new Date(NOW - 10 * DAY),
  });
}

test("SELLER: олгох дүн = (нийт − хүргэлт − яаралтай) − комисс; хүлээлтийн хугацаа (3 хоног) дууссан л олгогдоно", async () => {
  seedSeller();
  seedSellerOrder("ready", { total: 50000, fee: 5000, commission: 4500, deliveredDaysAgo: 5 });
  seedSellerOrder("held", { deliveredDaysAgo: 1 });
  const u = await sellerSvc.getSellerUnpaid("S1", NOW);
  assert.equal(u.payableCount, 1);
  assert.equal(u.payableTotal, 40500); // 45000 − 4500
  assert.equal(u.heldCount, 1);
  await assert.rejects(() => sellerSvc.paySellerBatch("S1", ["held"], "CASH", undefined, NOW), /хүлээлтийн хугацаа/);
  const r = await sellerSvc.paySellerBatch("S1", ["ready"], "CASH", undefined, NOW);
  assert.equal(r.totalAmount, 40500);
  assert.equal(orderOf("ready").sellerPayoutId, r.id);
  assert.equal(orderOf("ready").sellerPayoutAmount, 40500);
  assert.equal(orderOf("held").sellerPayoutId, null);
});

test("SELLER: буцаагдсан / цуцлагдсан / төлөөгүй / бэлэн болоогүй / аль хэдийн олгосон захиалга олгох жагсаалтад ОРОХГҮЙ", async () => {
  seedSeller();
  seedSellerOrder("refunded", { refundedAt: new Date(NOW - DAY), payment: "REFUNDED" });
  seedSellerOrder("cancelled", { cancelledAt: new Date(NOW - DAY) });
  seedSellerOrder("unpaid", { payment: "PENDING" });
  seedSellerOrder("notready", { status: "ACCEPTED" });
  seedSellerOrder("done", { payoutId: "old" });
  seedSellerOrder("ok");
  const u = await sellerSvc.getSellerUnpaid("S1", NOW);
  assert.deepEqual(u.items.map((i) => i.orderId), ["ok"]);
});

test("SELLER ЗЭРЭГЦЭЭ: хоёр Staff нэгэн зэрэг дарахад НЭГ л payout, давхар олголт байхгүй", async () => {
  seedSeller();
  seedSellerOrder("a");
  seedSellerOrder("b");
  const rs = await Promise.allSettled([sellerSvc.paySellerBatch("S1", ["a", "b"], "CASH", undefined, NOW), sellerSvc.paySellerBatch("S1", ["a", "b"], "CASH", undefined, NOW)]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(payoutsOf("sellerPayout").length, 1);
});

test("SELLER: нэг захиалга аль хэдийн олгогдсон бол бүх багц буцна (хэсэгчлэн олгохгүй)", async () => {
  seedSeller();
  seedSellerOrder("a");
  seedSellerOrder("b");
  // snapshot авсны дараа b өөр замаар олгогдсон гэж дуурайна
  const settlement = await sellerSvc.getSellerUnpaid("S1", NOW);
  assert.equal(settlement.items.length, 2);
  db.seed("order", { ...orderOf("b"), sellerPayoutId: "other" });
  await assert.rejects(() => sellerSvc.paySellerBatch("S1", ["a", "b"], "CASH", undefined, NOW), /жагсаалтад байхгүй|аль хэдийн олгогдсон/);
  assert.equal(orderOf("a").sellerPayoutId, null);
  assert.equal(payoutsOf("sellerPayout").length, 0);
});

test("SELLER payAll: дахин дарахад давхар олгохгүй; банкны мэдээлэлгүй худалдагчийг дансаар олгохдоо алгасна", async () => {
  seedSeller("S1", true);
  seedSeller("S2", false);
  seedSellerOrder("a", { sellerId: "S1" });
  seedSellerOrder("b", { sellerId: "S2" });
  const first = await sellerSvc.payAllSellers("BANK_TRANSFER", undefined, NOW);
  assert.equal(first.paid.length, 1);
  assert.equal(first.paid[0].sellerId, "S1");
  assert.equal(first.skipped.length, 1);
  assert.equal(first.skipped[0].sellerId, "S2");
  assert.equal(orderOf("b").sellerPayoutId, null);
  const second = await sellerSvc.payAllSellers("BANK_TRANSFER", undefined, NOW);
  assert.equal(second.paid.length, 0);
  assert.equal(payoutsOf("sellerPayout").length, 1);
});

test("SELLER: харь худалдагчийн захиалгыг төлөх боломжгүй (өгөгдлийн тусгаарлалт)", async () => {
  seedSeller("S1");
  seedSeller("S2");
  seedSellerOrder("mine", { sellerId: "S1" });
  seedSellerOrder("theirs", { sellerId: "S2" });
  await assert.rejects(() => sellerSvc.paySellerBatch("S1", ["theirs"], "CASH", undefined, NOW), /жагсаалтад байхгүй/);
  assert.equal(orderOf("theirs").sellerPayoutId, null);
});
