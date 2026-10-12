// POST /api/orders/:id/issue — бараа олголтын найдвартай байдал (эрх, төлбөр, төлөв, идемпотент, зэрэгцээ хүсэлт).
// Controller-ийг жинхэнэ код хэвээр ачаалж, express-ийг л хуурамч Router-оор орлуулж handler chain-ийг (requireAuth → requireRole → handler) ажиллуулна.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, install, load, reset, seedOrder as seedOrderRaw } from "./support/harness";

const Module = require("module");
type Handler = (req: any, res: any, next: () => void) => any;
const routers: Array<{ uses: Handler[]; routes: Array<{ method: string; path: string; handlers: Handler[] }> }> = [];

install();
const origLoad = Module._load;
Module._load = function (request: string, parent: any, ...rest: any[]) {
  if (request === "express") {
    const Router = () => {
      const rec = { uses: [] as Handler[], routes: [] as Array<{ method: string; path: string; handlers: Handler[] }> };
      routers.push(rec);
      const r: any = { use: (...h: Handler[]) => rec.uses.push(...h) };
      for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (path: string, ...h: Handler[]) => rec.routes.push({ method: m, path, handlers: h });
      return r;
    };
    return { Router };
  }
  try {
    return origLoad.call(this, request, parent, ...rest);
  } catch (e: any) {
    // node_modules байхгүй sandbox-д л (сүлжээгүй) гуравдагч модулийг хоосон stub-аар орлуулна
    if (e.code === "MODULE_NOT_FOUND" && !request.startsWith(".") && !request.startsWith("/")) {
      const fn: any = new Proxy(function () {}, { get: (_t, k) => (k === "__esModule" ? false : () => ({})), apply: () => (() => undefined) });
      return fn;
    }
    throw e;
  }
};
load("controllers/order.controller");
const orderRouter = routers.find((r) => r.routes.some((x) => x.method === "post" && x.path === "/:id/issue"))!;
const uses = orderRouter.uses;
const issueRoute = orderRouter.routes.find((r) => r.method === "post" && r.path === "/:id/issue")!;

async function call(opts: { id: string; token?: string | null }) {
  const req: any = { params: { id: opts.id }, headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? "staff:s1"}` }, body: {} };
  let status = 200;
  let body: any;
  let finish: () => void = () => {};
  const finished = new Promise<void>((r) => (finish = r));
  const res: any = { status(c: number) { status = c; return res; }, json(b: any) { body = b; finish(); return res; } };
  const chain = [...uses, ...issueRoute.handlers];
  for (let i = 0; i < chain.length; i++) {
    const isLast = i === chain.length - 1;
    if (isLast) {
      await chain[i](req, res, () => {});
      break;
    }
    // middleware: next() дуудагдах эсвэл хариу өгөгдөх хүртэл хүлээнэ (requireRole нь async)
    let nexted = false;
    await Promise.race([new Promise<void>((resolve) => { chain[i](req, res, () => { nexted = true; resolve(); }); }), finished]);
    if (!nexted) break;
  }
  return { status, body };
}

// Бодит DB-д OrderItem.isIssued @default(false) тул seed-д тодорхой тавина
function seedOrder(o: Parameters<typeof seedOrderRaw>[0]) {
  const r = seedOrderRaw(o);
  db.seed("orderItem", { ...db.get("orderItem", `item-${o.id}`)!, isIssued: false, issuedAt: null });
  return r;
}
const patchOrder = (id: string, patch: Record<string, unknown>) => db.seed("order", { ...db.get("order", id)!, ...patch });
const items = (orderId: string) => db.all("orderItem").filter((i) => i.orderId === orderId);
const OLD = new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  reset();
  db.seed("staff", { id: "s1", role: "CASHIER", isActive: true });
  db.seed("staff", { id: "adm", role: "ADMIN", isActive: true });
  db.seed("staff", { id: "off", role: "CASHIER", isActive: false });
});

test("route нь requireRole(ADMIN, CASHIER)-тэй (зөвхөн ADMIN болгоогүй); router.use(requireAuth) хүчинтэй", () => {
  assert.equal(issueRoute.handlers.length, 2);
  assert.ok(uses.length >= 1);
});

test("токенгүй → 401; идэвхгүй ажилтан → 401; олдохгүй ажилтан → 401; бараа олгогдохгүй", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  assert.equal((await call({ id: "o1", token: null })).status, 401);
  assert.equal((await call({ id: "o1", token: "staff:off" })).status, 401);
  assert.equal((await call({ id: "o1", token: "staff:ghost" })).status, 401);
  assert.ok(items("o1").every((i) => !i.isIssued));
});

test("CASHIER болон ADMIN хоёулаа олгож чадна", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  assert.equal((await call({ id: "o1", token: "staff:s1" })).status, 200);
  seedOrder({ id: "o2", total: 1000, paid: 1000, status: "PAID" });
  assert.equal((await call({ id: "o2", token: "staff:adm" })).status, 200);
});

test("захиалга олдохгүй → 404", async () => {
  const r = await call({ id: "nope" });
  assert.equal(r.status, 404);
});

for (const status of ["PENDING", "PARTIALLY_PAID"]) {
  test(`${status} (бүрэн төлөгдөөгүй) → 409, олгогдохгүй`, async () => {
    seedOrder({ id: "o1", total: 1000, paid: status === "PENDING" ? 0 : 400, status });
    const r = await call({ id: "o1" });
    assert.equal(r.status, 409);
    assert.ok(items("o1").every((i) => !i.isIssued && !i.issuedAt));
  });
}

test("PAID гэж тэмдэглэгдсэн ч paidAmount < totalAmount (тогтворгүй өгөгдөл) → 409", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 999.99, status: "PAID" });
  assert.equal((await call({ id: "o1" })).status, 409);
  assert.ok(items("o1").every((i) => !i.isIssued));
});

test("CANCELLED, REFUNDED, cancelledAt-тай PAID → 409, олгогдохгүй", async () => {
  seedOrder({ id: "c", total: 1000, paid: 1000, status: "CANCELLED" });
  seedOrder({ id: "r", total: 1000, paid: 1000, status: "REFUNDED" });
  seedOrder({ id: "x", total: 1000, paid: 1000, status: "PAID", cancelledAt: new Date() });
  for (const id of ["c", "r", "x"]) {
    assert.equal((await call({ id })).status, 409, id);
    assert.ok(items(id).every((i) => !i.isIssued), id);
  }
});

test("төгрөгийн бутархай: toCents-ээр харьцуулна (0.1+0.2 нь 0.3-тай тэнцүү, 0.29 нь бага)", async () => {
  seedOrder({ id: "f1", total: 0.3, paid: 0.1 + 0.2, status: "PAID" });
  assert.equal((await call({ id: "f1" })).status, 200);
  seedOrder({ id: "f2", total: 0.3, paid: 0.29, status: "PAID" });
  assert.equal((await call({ id: "f2" })).status, 409);
  seedOrder({ id: "f3", total: 10000.5, paid: 10000.5, status: "PAID" });
  assert.equal((await call({ id: "f3" })).status, 200);
});

test("PAID → зөвхөн SALE мөр isIssued=true; RENTAL мөр өөрчлөгдөхгүй; хариу { success:true }", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  db.seed("orderItem", { id: "rent-1", orderId: "o1", itemType: "RENTAL", isIssued: false, issuedAt: null });
  const r = await call({ id: "o1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true });
  const sale = db.get("orderItem", "item-o1")!;
  assert.equal(sale.isIssued, true);
  assert.ok(sale.issuedAt instanceof Date);
  const rent = db.get("orderItem", "rent-1")!;
  assert.equal(rent.isIssued, false);
  assert.equal(rent.issuedAt, null);
});

test("давтан хүсэлт өмнө олгосон барааны issuedAt-ийг шинэчилдэггүй; шинэ мөрийг л тэмдэглэнэ", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  db.seed("orderItem", { id: "old", orderId: "o1", itemType: "SALE", isIssued: true, issuedAt: OLD });
  assert.equal((await call({ id: "o1" })).status, 200);
  assert.equal((db.get("orderItem", "old")!.issuedAt as Date).getTime(), OLD.getTime());
  const first = db.get("orderItem", "item-o1")!.issuedAt as Date;
  assert.ok(first.getTime() > OLD.getTime());
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call({ id: "o1" })).status, 200); // идемпотент
  assert.equal((db.get("orderItem", "item-o1")!.issuedAt as Date).getTime(), first.getTime());
  assert.equal((db.get("orderItem", "old")!.issuedAt as Date).getTime(), OLD.getTime());
});

test("зэрэгцээ давхар хүсэлт: хоёулаа 200, мөр олгогдсон төлөвт, алдаа/давхар эвдрэл гарахгүй", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  const [a, b] = await Promise.all([call({ id: "o1" }), call({ id: "o1" })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const sale = db.get("orderItem", "item-o1")!;
  assert.equal(sale.isIssued, true);
  const writes = db.log.filter((l) => l.table === "orderItem" && l.op === "updateMany").length;
  assert.ok(writes >= 1);
});

test("pre-check-ийн дараа, transaction-ий өмнө захиалга REFUNDED болвол → 409, олгогдохгүй (check-then-act race хаагдсан)", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  db.beforeOnce("order", "updateMany", () => {
    patchOrder("o1", { paymentStatus: "REFUNDED" });
  });
  const r = await call({ id: "o1" });
  assert.equal(r.status, 409);
  assert.ok(items("o1").every((i) => !i.isIssued && !i.issuedAt));
});

test("pre-check-ийн дараа cancelledAt тавигдвал → 409, олгогдохгүй", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  db.beforeOnce("order", "updateMany", () => {
    patchOrder("o1", { cancelledAt: new Date() });
  });
  assert.equal((await call({ id: "o1" })).status, 409);
  assert.ok(items("o1").every((i) => !i.isIssued));
});

test("DB алдаа → 500, хэсэгчилсэн олголт үлдэхгүй", async () => {
  seedOrder({ id: "o1", total: 1000, paid: 1000, status: "PAID" });
  db.failOnce("orderItem", "updateMany");
  assert.equal((await call({ id: "o1" })).status, 500);
  assert.ok(items("o1").every((i) => !i.isIssued));
});
