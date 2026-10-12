// F5/F8 — requireAuth + requireRole (нэвтрээгүй / буруу эрх / идэвхгүй ажилтан / горимууд)
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, load, reset } from "./support/harness";

const mw = load("middleware/auth.middleware");

function call(handler: any, token?: string) {
  return new Promise<{ status: number; body: any; nextCalled: boolean }>((resolve) => {
    const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const out = { status: 200, body: undefined as any, nextCalled: false };
    const res: any = {
      status(c: number) { out.status = c; return res; },
      json(b: any) { out.body = b; resolve(out); return res; },
    };
    handler(req, res, () => { out.nextCalled = true; resolve(out); });
  });
}

const admin = () => db.seed("staff", { id: "adm", role: "ADMIN", isActive: true });
const cashier = () => db.seed("staff", { id: "csh", role: "CASHIER", isActive: true });

beforeEach(() => {
  reset();
  mw.resetRoleCache();
  delete process.env.STAFF_ROLE_ENFORCEMENT;
});

test("нэвтрээгүй → 401 (requireAuth ба requireRole хоёулаа)", async () => {
  assert.equal((await call(mw.requireAuth)).status, 401);
  const r = await call(mw.requireRole("ADMIN"));
  assert.equal(r.status, 401);
  assert.equal(r.nextCalled, false);
});

test("хүчингүй токен → 401", async () => {
  assert.equal((await call(mw.requireRole("ADMIN"), "garbage")).status, 401);
});

test("CASHIER ADMIN route-д → 403 (ADMIN байгаа үед)", async () => {
  admin(); cashier();
  const r = await call(mw.requireRole("ADMIN"), "staff:csh");
  assert.equal(r.status, 403);
  assert.equal(r.nextCalled, false);
});

test("ADMIN → next()", async () => {
  admin();
  const r = await call(mw.requireRole("ADMIN"), "staff:adm");
  assert.equal(r.nextCalled, true);
});

test("токен дахь role-д БИШ DB-ийн одоогийн role-д найдна (токен CASHIER, DB ADMIN → зөвшөөрнө; буцаад бас)", async () => {
  admin();
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:adm")).nextCalled, true);
  db.seed("staff", { id: "adm", role: "CASHIER", isActive: true }); // эрх хасагдсан
  mw.resetRoleCache();
  db.seed("staff", { id: "adm2", role: "ADMIN", isActive: true }); // өөр ADMIN байгаа тул enforcement идэвхтэй
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:adm")).status, 403);
});

test("идэвхгүй болгосон ADMIN → 401", async () => {
  admin();
  db.seed("staff", { id: "adm3", role: "ADMIN", isActive: false });
  const r = await call(mw.requireRole("ADMIN"), "staff:adm3");
  assert.equal(r.status, 401);
});

test("устгагдсан ажилтны хүчинтэй токен → 401", async () => {
  admin();
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:ghost")).status, 401);
});

test("ADMIN огт байхгүй + CASHIER ADMIN route-д → 403 (fail-closed)", async () => {
  cashier();
  const r = await call(mw.requireRole("ADMIN"), "staff:csh");
  assert.equal(r.status, 403);
  assert.equal(r.nextCalled, false);
});

test("ADMIN огт байхгүй + идэвхгүй/устгагдсан ажилтан → 401", async () => {
  db.seed("staff", { id: "off", role: "CASHIER", isActive: false });
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:off")).status, 401);
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:ghost")).status, 401);
});

test("STAFF_ROLE_ENFORCEMENT=on → CASHIER 403", async () => {
  process.env.STAFF_ROLE_ENFORCEMENT = "on";
  cashier();
  assert.equal((await call(mw.requireRole("ADMIN"), "staff:csh")).status, 403);
});

for (const mode of ["off", "OFF", "auto", "false", "0"]) {
  test(`STAFF_ROLE_ENFORCEMENT=${mode} эрхийн шалгалтыг тойрч ЧАДАХГҮЙ`, async () => {
    process.env.STAFF_ROLE_ENFORCEMENT = mode;
    mw.resetRoleCache();
    // ADMIN байхгүй
    cashier();
    assert.equal((await call(mw.requireRole("ADMIN"), "staff:csh")).status, 403);
    // ADMIN байгаа ч CASHIER 403
    admin();
    assert.equal((await call(mw.requireRole("ADMIN"), "staff:csh")).status, 403);
    // идэвхгүй / устгагдсан → 401
    db.seed("staff", { id: "off", role: "ADMIN", isActive: false });
    assert.equal((await call(mw.requireRole("ADMIN"), "staff:off")).status, 401);
    assert.equal((await call(mw.requireRole("ADMIN"), "staff:ghost")).status, 401);
    // идэвхтэй ADMIN → next()
    assert.equal((await call(mw.requireRole("ADMIN"), "staff:adm")).nextCalled, true);
  });
}

test("requireRole('ADMIN','CASHIER') — хоёр role-д нээлттэй, гэхдээ идэвхгүйг хаана", async () => {
  admin(); cashier();
  db.seed("staff", { id: "off", role: "CASHIER", isActive: false });
  assert.equal((await call(mw.requireRole("ADMIN", "CASHIER"), "staff:csh")).nextCalled, true);
  assert.equal((await call(mw.requireRole("ADMIN", "CASHIER"), "staff:off")).status, 401);
});
