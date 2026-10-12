// ============================================================================
// RENTAL AVAILABILITY — түрээсийн огнооны давхцал, нөөцийн тоо, зэрэгцээ захиалга
// ⚠️ fake Prisma дээр. PostgreSQL-ийн `pg_advisory_xact_lock`-ийг fake DB-ийн түгжээгээр (productId түлхүүр, commit хүртэл)
//    ДУУРАЙЖ байгаа — бодит advisory lock-ийн ажиллагааг ТУРШААГҮЙ. Харин "lock-гүй бол давхар захиална" гэсэн
//    эсрэг шалгалт нь тест lock-ийн нөлөөг үнэхээр мэдэрдгийг харуулна.
// ============================================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset } from "./support/harness";
import { startOfTodayInUlaanbaatar } from "../src/lib/timezone";

const rental = load<typeof import("../src/services/rental-availability.service")>("services/rental-availability.service");

const DAY = 86400000;
const base = startOfTodayInUlaanbaatar().getTime() + 10 * DAY; // ирээдүйн, өдрөөр тэгшилсэн
const D = (n: number) => new Date(base + n * DAY);

beforeEach(() => reset());

function seedProduct(id = "P1", rentalStockQty = 1, isRental = true) {
  return db.seed("product", { id, name: id, isRental, rentalStockQty });
}
/** Бүртгэгдсэн түрээс (BOOKED/ACTIVE/…) — rentalDetail мөрөнд orderItem {productId, quantity}-ийг embedded байдлаар хадгална. */
function seedRental(id: string, o: { productId?: string; qty?: number; from: number; to: number; status?: string }) {
  const productId = o.productId ?? "P1";
  db.seed("orderItem", { id: `oi-${id}`, productId, quantity: o.qty ?? 1, itemType: "RENTAL" });
  return db.seed("rentalDetail", {
    id,
    orderItemId: `oi-${id}`,
    orderItem: { productId, quantity: o.qty ?? 1 },
    startDate: D(o.from),
    endDate: D(o.to),
    rentalStatus: o.status ?? "BOOKED",
  });
}
function seedRequest(id: string, productId = "P1", qty = 1) {
  db.seed("orderItem", { id, productId, quantity: qty, itemType: "RENTAL" });
}

const prisma = db.client();
let ownerSeq = 1_000_000;
/** reserveRentalWithinTx-ийг fake tx дээр ажиллуулна. withLock=true бол pg_advisory_xact_lock-ийг productId дээр дуурайна (commit хүртэл). */
async function reserve(itemId: string, productId: string, from: number, to: number, withLock = true) {
  const owner = ++ownerSeq;
  try {
    return await prisma.$transaction(async (tx: any) => {
      const wrapped = new Proxy(tx, {
        get: (t, k: string) => {
          if (k === "$executeRawUnsafe") return async (_sql: string, key: string) => (withLock ? db._lock(`advisory:${key}`, owner) : undefined);
          // fake DB нь join мэддэггүй: шинээр үүссэн rentalDetail-д бодит DB-ийн `orderItem` холбоосыг embedded байдлаар нэмнэ
          // (давхцлын хайлт `orderItem: { productId }`-ээр шүүдэг тул).
          if (k === "rentalDetail")
            return new Proxy(t.rentalDetail, {
              get: (rt, op: string) =>
                op === "create"
                  ? async (args: any) => {
                      const item = await t.orderItem.findUnique({ where: { id: args.data.orderItemId } });
                      return rt.create({ ...args, data: { ...args.data, orderItem: { productId: item.productId, quantity: item.quantity } } });
                    }
                  : rt[op],
            });
          return t[k];
        },
      });
      return rental.reserveRentalWithinTx(wrapped, {
        orderItemId: itemId,
        productId,
        startDate: D(from),
        endDate: D(to),
        dailyRate: 10000,
        depositAmount: 20000,
      });
    });
  } finally {
    db._release(owner, [`advisory:${productId}`]);
  }
}
const detailsOf = (productId = "P1") => db.all("rentalDetail").filter((r) => r.orderItem?.productId === productId);

// ---------------------------------------------------------------- ДАВХЦАЛ
test("ДАВХЦАЛ: нөөц 1, [0,3) захиалагдсан — [1,2) (дотор), [2,5) (хэсэгчлэн), [-2,1) (өмнөөс), [-1,4) (бүтнээр нь хамарсан) бүгд татгалзана", async () => {
  seedProduct("P1", 1);
  seedRental("r0", { from: 0, to: 3 });
  const cases: Array<[number, number]> = [[1, 2], [2, 5], [-2, 1], [-1, 4], [0, 3]];
  for (const [i, [f, t]] of cases.entries()) {
    seedRequest(`req${i}`);
    await assert.rejects(() => reserve(`req${i}`, "P1", f, t), (e: any) => e instanceof rental.RentalUnavailableError && e.availableQty === 0, `[${f},${t})`);
  }
  assert.equal(detailsOf().length, 1); // шинээр юу ч нэмэгдээгүй
});

test("ДАВХЦАЛ: яг залгаа интервал ([0,3) ба [3,5)) давхцахгүй — зөвшөөрнө (дуусах өдөр = дараагийн эхлэх өдөр)", async () => {
  seedProduct("P1", 1);
  seedRental("r0", { from: 0, to: 3 });
  seedRequest("next");
  const d = await reserve("next", "P1", 3, 5);
  assert.equal(d.rentalStatus, "BOOKED");
  seedRequest("prev");
  await reserve("prev", "P1", -2, 0); // өмнөх залгаа
  assert.equal(detailsOf().length, 3);
});

test("НӨӨЦ: тоо ширхэг тооцогдоно — нөөц 3, 2 ш захиалагдсан → 1 ш авна, 2 ш татгалзана (боломжтой=1)", async () => {
  seedProduct("P1", 3);
  seedRental("r0", { from: 0, to: 3, qty: 2 });
  seedRequest("one", "P1", 1);
  seedRequest("two", "P1", 2);
  await assert.rejects(() => reserve("two", "P1", 1, 2), (e: any) => e instanceof rental.RentalUnavailableError && e.availableQty === 1);
  await reserve("one", "P1", 1, 2);
  assert.equal(detailsOf().length, 2);
});

test("НӨӨЦ: хүссэн тоо нийт нөөцөөс их (нөөц 2, хүсэлт 3) → татгалзана", async () => {
  seedProduct("P1", 2);
  seedRequest("big", "P1", 3);
  await assert.rejects(() => reserve("big", "P1", 0, 2), (e: any) => e instanceof rental.RentalUnavailableError && e.availableQty === 2);
  assert.equal(detailsOf().length, 0);
});

test("ТӨЛӨВ: BOOKED / ACTIVE / OVERDUE нөөц эзэлнэ; RETURNED / CANCELLED эзэлэхгүй", async () => {
  for (const st of ["BOOKED", "ACTIVE", "OVERDUE"]) {
    reset();
    seedProduct("P1", 1);
    seedRental("r0", { from: 0, to: 3, status: st });
    seedRequest("q");
    await assert.rejects(() => reserve("q", "P1", 1, 2), rental.RentalUnavailableError, st);
  }
  for (const st of ["RETURNED", "CANCELLED"]) {
    reset();
    seedProduct("P1", 1);
    seedRental("r0", { from: 0, to: 3, status: st });
    seedRequest("q");
    const d = await reserve("q", "P1", 1, 2);
    assert.equal(d.rentalStatus, "BOOKED", st);
  }
});

test("БАРАА: өөр барааны түрээс нөөцөд нөлөөлөхгүй", async () => {
  seedProduct("P1", 1);
  seedProduct("P2", 1);
  seedRental("rOther", { productId: "P2", from: 0, to: 3 });
  seedRequest("q", "P1");
  await reserve("q", "P1", 0, 3);
  assert.equal(detailsOf("P1").length, 1);
});

// ---------------------------------------------------------------- ЗЭРЭГЦЭЭ
test("ЗЭРЭГЦЭЭ: нөөц 1, ижил хугацаанд 5 захиалга зэрэг → ЯГ 1 нь амжилттай, 4 нь RentalUnavailable (advisory lock дуурайлттай)", async () => {
  seedProduct("P1", 1);
  for (let i = 0; i < 5; i++) seedRequest(`q${i}`);
  const rs = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => reserve(`q${i}`, "P1", 1, 3)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of rs.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) assert.ok(r.reason instanceof rental.RentalUnavailableError);
  assert.equal(detailsOf().length, 1);
});

test("ЗЭРЭГЦЭЭ: нөөц 3, 5 захиалга (тус бүр 1 ш) зэрэг → яг 3 нь амжилттай, нөөцөөс хэтрэхгүй", async () => {
  seedProduct("P1", 3);
  for (let i = 0; i < 5; i++) seedRequest(`q${i}`);
  const rs = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => reserve(`q${i}`, "P1", 0, 2)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(detailsOf().length, 3);
});

test("ЗЭРЭГЦЭЭ: залгаа огноотой хоёр захиалга зэрэг ирвэл хоёулаа амжилттай (давхцалгүй)", async () => {
  seedProduct("P1", 1);
  seedRequest("a");
  seedRequest("b");
  const rs = await Promise.allSettled([reserve("a", "P1", 0, 2), reserve("b", "P1", 2, 4)]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 2);
});

test("ТЕСТИЙН МЭДРЭМЖ: lock-гүйгээр зэрэг уншвал давхар захиална — тест lock-ийн нөлөөг үнэхээр шалгаж байна", async () => {
  seedProduct("P1", 1);
  for (let i = 0; i < 3; i++) seedRequest(`q${i}`);
  const rs = await Promise.allSettled([0, 1, 2].map((i) => reserve(`q${i}`, "P1", 1, 3, false)));
  assert.ok(rs.filter((r) => r.status === "fulfilled").length > 1, "lock-гүй үед давхар захиалга гарах ёстой (fake DB-д)");
});

// ---------------------------------------------------------------- ОГНОО
test("ОГНОО: эхлэх нь дуусахаас өмнө байх ёстой; өнгөрсөн өдрөөс эхэлж болохгүй; бүртгэл үүсэхгүй", async () => {
  seedProduct("P1", 1);
  seedRequest("q");
  await assert.rejects(() => reserve("q", "P1", 3, 3), /Эхлэх огноо дуусах огнооноос өмнө/);
  await assert.rejects(() => reserve("q", "P1", 5, 3), /Эхлэх огноо дуусах огнооноос өмнө/);
  await assert.rejects(() => reserve("q", "P1", -30, -28), /өнгөрсөн/);
  assert.equal(detailsOf().length, 0);
});

test("ХОНОГ: rentalDays = дуусах − эхлэх (өдрөөр), өдрийн үнэ/барьцаа бүртгэгдэнэ", async () => {
  seedProduct("P1", 1);
  seedRequest("q");
  const d = await reserve("q", "P1", 1, 5);
  assert.equal(d.rentalDays, 4);
  assert.equal(d.dailyRate, 10000);
  assert.equal(d.depositAmount, 20000);
  assert.equal(d.orderItemId, "q");
});

// ---------------------------------------------------------------- checkAvailability (унших)
test("checkAvailability: боломжтой тоо, excludeOrderItemId-ээр өөрийн мөрийг хасч тооцно", async () => {
  seedProduct("P1", 3);
  seedRental("r0", { from: 0, to: 3, qty: 2 });
  const a = await rental.checkAvailability({ productId: "P1", startDate: D(1), endDate: D(2), requestedQty: 1 });
  assert.deepEqual(a, { available: true, availableQty: 1, totalStock: 3 });
  const b = await rental.checkAvailability({ productId: "P1", startDate: D(1), endDate: D(2), requestedQty: 2 });
  assert.equal(b.available, false);
  assert.equal(b.availableQty, 1);
  const c = await rental.checkAvailability({ productId: "P1", startDate: D(1), endDate: D(2), requestedQty: 3, excludeOrderItemId: "oi-r0" });
  assert.equal(c.available, true); // өөрийн (засварлаж буй) мөрийг тооцохгүй
  const d = await rental.checkAvailability({ productId: "P1", startDate: D(3), endDate: D(4), requestedQty: 3 });
  assert.equal(d.available, true); // залгаа
});

test("checkAvailability: түрээслэгддэггүй бараа, буруу огноо татгалзана", async () => {
  seedProduct("P1", 1, false);
  await assert.rejects(() => rental.checkAvailability({ productId: "P1", startDate: D(1), endDate: D(2) }), /түрээслэгддэггүй/);
  seedProduct("P2", 1);
  await assert.rejects(() => rental.checkAvailability({ productId: "P2", startDate: D(2), endDate: D(1) }), /өмнө байх ёстой/);
});
