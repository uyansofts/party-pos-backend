// ============================================================================
// COURIER ACCEPT / OFFER — хоёр курьер зэрэг "Accept" дарахад ганцхан нь авна; курьерт гаргах дүрмүүд
// ⚠️ fake Prisma (санах ой) дээр: updateMany-ийн WHERE-ийг түгжээний дараа дахин шалгадаг (READ COMMITTED) загвар.
//    Бодит PostgreSQL дээрх зэрэгцээ ажиллагааг ТУРШААГҮЙ.
// ============================================================================
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { db, events, load, reset } from "./support/harness";

const da = load<typeof import("../src/services/delivery-assignment.service")>("services/delivery-assignment.service");

beforeEach(() => {
  mock.restoreAll();
  reset();
  // acceptDelivery "ACCEPTED" хариуг upsert-ээр бүртгэдэг (алдааг залгидаг) — fake DB upsert дэмждэггүй тул чимээгүй болгоно.
  mock.method(console, "error", () => undefined);
});

const orderOf = (id: string) => db.get("order", id)!;
const taken = () => events.filter((e) => e.event === "delivery_taken");

function seedOffered(id = "o1", over: Record<string, unknown> = {}) {
  return db.seed("order", {
    id,
    orderNumber: `N-${id}`,
    orderType: "ONLINE",
    storeId: "default",
    paymentStatus: "PAID",
    deliveryAssignStatus: "OFFERED",
    courierId: null,
    requestingCourierId: null,
    sellerId: null,
    sellerStatus: null,
    deliveryFee: 5000,
    serviceAmount: 0,
    items: [],
    ...over,
  });
}

// ---------------------------------------------------------------- ЗЭРЭГЦЭЭ ACCEPT
test("ACCEPT ЗЭРЭГЦЭЭ: 5 курьер нэгэн зэрэг дарахад ЯГ НЭГ нь авна, бусад нь 'аль хэдийн авсан' алдаа авна", async () => {
  seedOffered();
  const ids = ["c1", "c2", "c3", "c4", "c5"];
  const rs = await Promise.allSettled(ids.map((c) => da.acceptDelivery("o1", c)));
  const ok = rs.map((r, i) => ({ r, c: ids[i] })).filter((x) => x.r.status === "fulfilled");
  assert.equal(ok.length, 1);
  for (const r of rs.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
    assert.ok(r.reason instanceof da.DeliveryAssignmentError);
    assert.match(r.reason.message, /аль хэдийн авсан/);
  }
  const o = orderOf("o1");
  assert.equal(o.deliveryAssignStatus, "ASSIGNED");
  assert.equal(o.courierId, ok[0].c); // ялагчийн id, өөр курьерээр дарагдаагүй
  assert.ok(o.deliveryAcceptedAt);
  assert.equal(taken().length, 1); // "delivery_taken" зөвхөн ялагчийн хувьд НЭГ удаа
});

test("ACCEPT: нэг курьер давхар дарсан (зэрэг) ч НЭГ л удаа амжилттай", async () => {
  seedOffered();
  const rs = await Promise.allSettled([da.acceptDelivery("o1", "c1"), da.acceptDelivery("o1", "c1")]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(orderOf("o1").courierId, "c1");
  assert.equal(taken().length, 1);
});

test("ACCEPT: дараалан — хоёр дахь курьер авсан хүргэлтийг дарж бичихгүй", async () => {
  seedOffered();
  await da.acceptDelivery("o1", "c1");
  const at = orderOf("o1").deliveryAcceptedAt;
  await assert.rejects(() => da.acceptDelivery("o1", "c2"), /аль хэдийн авсан/);
  assert.equal(orderOf("o1").courierId, "c1");
  assert.deepEqual(orderOf("o1").deliveryAcceptedAt, at);
});

test("ACCEPT: OFFERED биш төлөвт (UNASSIGNED / ASSIGNED / DELIVERED) авч болохгүй, захиалга өөрчлөгдөхгүй", async () => {
  for (const st of ["UNASSIGNED", "ASSIGNED", "PICKED_UP", "DELIVERED"]) {
    seedOffered(`x-${st}`, { deliveryAssignStatus: st, courierId: st === "UNASSIGNED" ? null : "cOwner" });
    await assert.rejects(() => da.acceptDelivery(`x-${st}`, "c9"), da.DeliveryAssignmentError);
    assert.equal(orderOf(`x-${st}`).deliveryAssignStatus, st);
    assert.notEqual(orderOf(`x-${st}`).courierId, "c9");
  }
  assert.equal(taken().length, 0);
});

// ---------------------------------------------------------------- ИЛГЭЭМЖ (errand) ДҮРЭМ
test("ERRAND: өөрийн илгээмжийг өөрөө авч болохгүй", async () => {
  seedOffered("e1", { orderType: "COURIER_ERRAND", requestingCourierId: "cA" });
  await assert.rejects(() => da.acceptDelivery("e1", "cA"), /Өөрийн илгээмжийг өөрөө/);
  assert.equal(orderOf("e1").deliveryAssignStatus, "OFFERED");
});

test("ERRAND: төлөгдөөгүй илгээмжийг авч болохгүй", async () => {
  seedOffered("e1", { orderType: "COURIER_ERRAND", requestingCourierId: "cA", paymentStatus: "PENDING" });
  await assert.rejects(() => da.acceptDelivery("e1", "cB"), /төлбөр төлөгдөөгүй/);
  assert.equal(orderOf("e1").deliveryAssignStatus, "OFFERED");
});

test("ERRAND: өмнө нь чөлөөлөгдсөн / илгээгчээс татгалзуулсан курьер дахин авч болохгүй", async () => {
  seedOffered("e1", { orderType: "COURIER_ERRAND", requestingCourierId: "cA" });
  // fake DB нь compound unique (orderId_courierId)-ийг embedded объектоор дүрсэлнэ
  db.seed("deliveryOfferResponse", { id: "r1", orderId: "e1", courierId: "cB", response: "RELEASED", orderId_courierId: { orderId: "e1", courierId: "cB" } });
  db.seed("deliveryOfferResponse", { id: "r2", orderId: "e1", courierId: "cC", response: "REJECTED_BY_REQUESTER", orderId_courierId: { orderId: "e1", courierId: "cC" } });
  await assert.rejects(() => da.acceptDelivery("e1", "cB"), /дахин авах боломжгүй/);
  await assert.rejects(() => da.acceptDelivery("e1", "cC"), /дахин авах боломжгүй/);
  assert.equal(orderOf("e1").deliveryAssignStatus, "OFFERED");
  // өөр курьер авч чадна
  await da.acceptDelivery("e1", "cD");
  assert.equal(orderOf("e1").courierId, "cD");
});

test("ERRAND: хүргэсэн боловч төлбөрөө төлөөгүй курьер шинэ хүргэлт авч болохгүй", async () => {
  db.seed("order", { id: "debt", orderNumber: "D1", orderType: "COURIER_ERRAND", requestingCourierId: "cA", deliveryAssignStatus: "DELIVERED", paymentStatus: "PENDING", deliveryFee: 4000, items: [] });
  seedOffered("o1");
  await assert.rejects(() => da.acceptDelivery("o1", "cA"), /төлбөр төлөгдөөгүй/);
  assert.equal(orderOf("o1").deliveryAssignStatus, "OFFERED");
});

// ---------------------------------------------------------------- ХУДАЛДАГЧИЙН ЗАХИАЛГЫГ КУРЬЕРТ ГАРГАХ
test("OFFER: худалдагчийн захиалга төлөгдөөгүй эсвэл 'READY' биш бол курьерт гаргахгүй, төлөв өөрчлөгдөхгүй", async () => {
  for (const [pay, st] of [["PENDING", "READY"], ["PAID", "ACCEPTED"], ["PAID", "AWAITING_SELLER"], ["PARTIALLY_PAID", "READY"]]) {
    const id = `s-${pay}-${st}`;
    seedOffered(id, { sellerId: "sellerA", sellerStatus: st, paymentStatus: pay, deliveryAssignStatus: "UNASSIGNED" });
    await assert.rejects(() => da.offerDeliveryToAllCouriers(id), /Бэлэн/);
    assert.equal(orderOf(id).deliveryAssignStatus, "UNASSIGNED");
  }
  assert.equal(events.filter((e) => e.event === "delivery_available").length, 0);
});

test("MANUAL: Staff гараар оноохдоо ч худалдагчийн захиалга 'READY' биш бол боломжгүй; идэвхгүй курьер татгалзана", async () => {
  db.seed("courier", { id: "cA", isActive: true });
  db.seed("courier", { id: "cOff", isActive: false });
  seedOffered("s1", { sellerId: "sellerA", sellerStatus: "ACCEPTED", deliveryAssignStatus: "UNASSIGNED" });
  await assert.rejects(() => da.assignDeliveryManually("s1", "cA"), /Бэлэн/);
  seedOffered("o2", { deliveryAssignStatus: "UNASSIGNED" });
  await assert.rejects(() => da.assignDeliveryManually("o2", "cOff"), /идэвхгүй/);
  await assert.rejects(() => da.assignDeliveryManually("o2", "nobody"), /олдсонгүй|идэвхгүй/);
  assert.equal(orderOf("s1").deliveryAssignStatus, "UNASSIGNED");
  assert.equal(orderOf("o2").deliveryAssignStatus, "UNASSIGNED");
  assert.equal(orderOf("o2").courierId, null);
});

test("MANUAL: илгээмжийг илгээгч курьерт нь оноох, төлөгдөөгүй илгээмжийг оноох боломжгүй", async () => {
  db.seed("courier", { id: "cA", isActive: true });
  seedOffered("e1", { orderType: "COURIER_ERRAND", requestingCourierId: "cA", deliveryAssignStatus: "UNASSIGNED" });
  await assert.rejects(() => da.assignDeliveryManually("e1", "cA"), /илгээгч курьерт/);
  seedOffered("e2", { orderType: "COURIER_ERRAND", requestingCourierId: "cB", paymentStatus: "PENDING", deliveryAssignStatus: "UNASSIGNED" });
  await assert.rejects(() => da.assignDeliveryManually("e2", "cA"), /төлбөр төлөгдөөгүй/);
  assert.equal(orderOf("e1").deliveryAssignStatus, "UNASSIGNED");
  assert.equal(orderOf("e2").deliveryAssignStatus, "UNASSIGNED");
});

test("MANUAL: нөхцөл хангасан үед ASSIGNED болж, бусад курьерийн жагсаалтаас арилгах 'delivery_taken' явна", async () => {
  // шөнийн хориг (хугацаанаас хамаарах) таслахгүйн тулд унтраана
  db.seed("shopSettings", { id: "default", nightHoldEnabled: false });
  db.seed("courier", { id: "cA", isActive: true });
  seedOffered("o1", { deliveryAssignStatus: "UNASSIGNED" });
  const o = await da.assignDeliveryManually("o1", "cA");
  assert.equal(o.courierId, "cA");
  assert.equal(orderOf("o1").deliveryAssignStatus, "ASSIGNED");
  assert.equal(taken().length, 1);
});

// ---------------------------------------------------------------- ДАХИН ОНОХ ДҮРЭМ (Staff гараар)
function noNight() {
  db.seed("shopSettings", { id: "default", nightHoldEnabled: false }); // шөнийн хориг хугацаанаас хамаарахгүй байлгана
}
const toCourier = (id: string, event: string) => events.filter((e) => e.event === event && e.payload.__to === id);

test("REASSIGN: аль хэдийн ASSIGNED хүргэлтийг энгийн оноолтоор ДАРЖ БИЧИХГҮЙ — курьер хэвээр, мэдэгдэл явахгүй", async () => {
  noNight();
  db.seed("courier", { id: "cNew", isActive: true });
  seedOffered("o1", { deliveryAssignStatus: "ASSIGNED", courierId: "cOld" });
  await assert.rejects(() => da.assignDeliveryManually("o1", "cNew"), /аль хэдийн курьерт оноогдсон/);
  assert.equal(orderOf("o1").courierId, "cOld");
  assert.equal(events.length, 0);
});

test("REASSIGN: reassign=true үед ASSIGNED → өөр курьерт шилжинэ; өмнөх курьерт 'танаас хасагдлаа' мэдэгдэл явна", async () => {
  noNight();
  db.seed("courier", { id: "cNew", isActive: true });
  seedOffered("o1", { deliveryAssignStatus: "ASSIGNED", courierId: "cOld" });
  const o = await da.assignDeliveryManually("o1", "cNew", { reassign: true });
  assert.equal(o.courierId, "cNew");
  assert.equal(orderOf("o1").deliveryAssignStatus, "ASSIGNED");
  assert.equal(toCourier("cOld", "delivery_unassigned_from_you").length, 1);
  assert.equal(toCourier("cNew", "delivery_assigned_to_you").length, 1);
});

test("REASSIGN: нэг курьерт дахин оноох боломжгүй", async () => {
  noNight();
  db.seed("courier", { id: "cA", isActive: true });
  seedOffered("o1", { deliveryAssignStatus: "ASSIGNED", courierId: "cA" });
  await assert.rejects(() => da.assignDeliveryManually("o1", "cA", { reassign: true }), /аль хэдийн сонгосон курьерт/);
});

test("REASSIGN: курьер барааг авсан (PICKED_UP) болон түүнээс хойших төлөвт reassign=true ч ХОРИГЛОНО", async () => {
  noNight();
  db.seed("courier", { id: "cNew", isActive: true });
  for (const st of ["PICKED_UP", "GIVEN", "RETURN_PICKED_UP", "DELIVERED", "CANCELLED"]) {
    seedOffered(`x-${st}`, { deliveryAssignStatus: st, courierId: "cOld" });
    await assert.rejects(() => da.assignDeliveryManually(`x-${st}`, "cNew", { reassign: true }), /дахин оноох боломжгүй/, st);
    assert.equal(orderOf(`x-${st}`).courierId, "cOld");
    assert.equal(orderOf(`x-${st}`).deliveryAssignStatus, st);
  }
  assert.equal(events.length, 0);
});

test("REASSIGN: олдохгүй захиалга — ойлгомжтой алдаа (500 биш)", async () => {
  noNight();
  db.seed("courier", { id: "cA", isActive: true });
  await assert.rejects(() => da.assignDeliveryManually("ghost", "cA"), (e: any) => e instanceof da.DeliveryAssignmentError && /олдсонгүй/.test(e.message));
});

test("УРАЛДАА: Staff гараар оноох + курьер accept зэрэг — ЯГ НЭГ нь ялж, нөгөө нь дарж бичихгүй", async () => {
  noNight();
  db.seed("courier", { id: "cM", isActive: true });
  seedOffered("o1"); // OFFERED
  const rs = await Promise.allSettled([da.assignDeliveryManually("o1", "cM"), da.acceptDelivery("o1", "cAcc")]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const winner = rs[0].status === "fulfilled" ? "cM" : "cAcc";
  assert.equal(orderOf("o1").courierId, winner);
  assert.equal(orderOf("o1").deliveryAssignStatus, "ASSIGNED");
});

test("УРАЛДАА: хоёр Staff зэрэг өөр өөр курьерт дахин оноовол ЯГ НЭГ нь амжилттай", async () => {
  noNight();
  db.seed("courier", { id: "c2", isActive: true });
  db.seed("courier", { id: "c3", isActive: true });
  seedOffered("o1", { deliveryAssignStatus: "ASSIGNED", courierId: "c1" });
  const rs = await Promise.allSettled([
    da.assignDeliveryManually("o1", "c2", { reassign: true }),
    da.assignDeliveryManually("o1", "c3", { reassign: true }),
  ]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const winner = rs[0].status === "fulfilled" ? "c2" : "c3";
  assert.equal(orderOf("o1").courierId, winner);
  assert.equal(toCourier("c1", "delivery_unassigned_from_you").length, 1); // өмнөх курьерт НЭГ л удаа
});

test("CONTROLLER: reassign нь зөвхөн boolean true үед дамжина ('true' текст, 1 зэргийг үл тооно)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../src/controllers/courier.controller.ts"), "utf8");
  assert.match(src, /assignDeliveryManually\(orderId, courierId, \{ reassign: reassign === true \}\)/);
});
