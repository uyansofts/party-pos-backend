// Фаз 1 review — storefront.html-ийн polling UI-ийн ЖИНХЭНЭ ажиллагааг (хуурамч DOM + mock timer + хуурамч fetch) шалгана.
// storefront.html-ээс PAYMENT_STATUS_PURE + PAYMENT_POLL_UI блокуудыг задалж ажиллуулна. Шинэ dependency-гүй (Node >= 20).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const html = fs.readFileSync(path.resolve(__dirname, "../../storefront.html"), "utf8");
function slice(a: string, b: string) {
  const s = html.indexOf(a), e = html.indexOf(b);
  assert.ok(s > 0 && e > s, `${a} блок олдсонгүй`);
  return html.slice(s, e);
}
const pureBlock = slice("// <PAYMENT_STATUS_PURE_START>", "// <PAYMENT_STATUS_PURE_END>");
const uiBlock = slice("// <PAYMENT_POLL_UI_START>", "// <PAYMENT_POLL_UI_END>");

class FakeEl {
  className = ""; style: any = {}; children: FakeEl[] = []; onclick: any = null; private own = "";
  constructor(public tag = "div") {}
  get textContent() { return this.own + this.children.map(c => c.textContent).join(""); }
  set textContent(v: string) { this.own = v; this.children = []; }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  find(tag: string): FakeEl | undefined { return this.children.find(c => c.tag === tag); }
}

type Reply = { status: number; body?: any; badJson?: boolean } | "throw" | Promise<any>;

function setup() {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
  const els: Record<string, FakeEl> = {
    paymentStatusBadge: Object.assign(new FakeEl(), { className: "status-badge status-pending" }),
    paymentNotice: new FakeEl(), paymentCancelBtn: new FakeEl("button"),
  };
  els.paymentStatusBadge.textContent = "Төлбөр хүлээгдэж байна...";
  const document = { getElementById: (id: string) => els[id] ?? null, createElement: (t: string) => new FakeEl(t) };
  const queue: Reply[] = [];
  const calls: string[] = [];
  let completed = 0;
  const fetchFn = (url: string) => {
    calls.push(url);
    const r = queue.length ? queue.shift()! : ({ status: 200, body: { status: "PENDING" } } as Reply);
    if (r === "throw") return Promise.reject(new Error("net"));
    if (r instanceof Promise) return r;
    return Promise.resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: () => (r.badJson ? Promise.reject(new Error("x")) : Promise.resolve(r.body)) });
  };
  const api: any = new Function("document", "fetch", "API_BASE", "showOrderComplete",
    `let pollTimer = null;\n${pureBlock}\n${uiBlock}\nreturn { pollPaymentStatus, stopPaymentPolling, getTimer: () => pollTimer, active: () => activePayPoll };`
  )(document, fetchFn, "http://api", () => { completed++; });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  const tick = async (ms: number) => { mock.timers.tick(ms); await flush(); };
  return { els, api, queue, calls, flush, tick, completed: () => completed };
}
const pending = { status: 200, body: { status: "PENDING" } } as Reply;
const unapplied = { status: 200, body: { status: "PAID", applied: false, unappliedReason: "INSUFFICIENT_STOCK" } } as Reply;
const paid = { status: 200, body: { status: "PAID", paidAt: "x" } } as Reply;

test.afterEach(() => mock.timers.reset());

test("poll эхлэхэд эхний шалгалт ШУУД хийгдэнэ (3 сек хүлээхгүй)", async () => {
  const t = setup();
  t.api.pollPaymentStatus("tx1");
  await t.flush();
  assert.equal(t.calls.length, 1);
  assert.match(t.calls[0], /payments\/status\/tx1$/);
});

test("inFlight guard: өмнөх хүсэлт дуусаагүй байхад interval шинэ хүсэлт илгээхгүй", async () => {
  const t = setup();
  let release: any; t.queue.push(new Promise(r => { release = r; }));
  t.api.pollPaymentStatus("tx1");
  await t.flush();
  await t.tick(3000); await t.tick(3000);
  assert.equal(t.calls.length, 1);
  release({ status: 200, ok: true, json: async () => ({ status: "PENDING" }) });
  await t.flush();
  await t.tick(3000);
  assert.equal(t.calls.length, 2);
});

test("PAID (applied талбаргүй) → амжилт, interval зогсоно, showOrderComplete 1 удаа", async () => {
  const t = setup();
  t.queue.push(paid);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-paid");
  assert.equal(t.api.getTimer(), null);
  await t.tick(1200); await t.tick(10_000);
  assert.equal(t.completed(), 1);
  assert.equal(t.calls.length, 1);
});

test("PAID_UNAPPLIED → амжилт БИШ: showOrderComplete дуудагдахгүй, цуцлах товч нуугдана, лавлах дугаар + retry товч", async () => {
  const t = setup();
  t.queue.push(unapplied);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  await t.tick(5000);
  assert.equal(t.completed(), 0);
  assert.equal(t.els.paymentCancelBtn.style.display, "none");
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-warn");
  assert.match(t.els.paymentNotice.textContent, /Бараа дууссан/);
  assert.match(t.els.paymentNotice.textContent, /Лавлах дугаар: tx1/);
  assert.ok(t.els.paymentNotice.find("button"));
  assert.equal(t.api.getTimer(), null);
  assert.equal(t.calls.length, 1); // дахин polling хийхгүй
});

test("PAID_UNAPPLIED → retry: анхааруулга+лавлах дугаар алдагдахгүй, цуцлах товч нуугдсан хэвээр; дараа нь PAID_APPLIED бол амжилт", async () => {
  const t = setup();
  t.queue.push(unapplied, unapplied);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.els.paymentNotice.find("button")!.onclick();
  // retry дарсан даруй (хариу ирэхээс өмнө) цуцлах товч нуугдсан хэвээр
  assert.equal(t.els.paymentCancelBtn.style.display, "none");
  await t.flush();
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-warn");
  assert.match(t.els.paymentNotice.textContent, /Лавлах дугаар: tx1/);
  assert.equal(t.completed(), 0);
  assert.equal(t.calls.length, 2);
  t.queue.push(paid);
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  await t.tick(1200);
  assert.equal(t.completed(), 1);
});

for (const [name, reply, badge] of [
  ["FAILED", { status: 200, body: { status: "FAILED" } }, "status-failed"],
  ["EXPIRED", { status: 200, body: { status: "EXPIRED" } }, "status-failed"],
  ["401", { status: 401, body: {} }, "status-failed"],
  ["403", { status: 403, body: {} }, "status-failed"],
  ["404", { status: 404, body: {} }, "status-failed"],
] as [string, Reply, string][]) {
  test(`${name} → polling зогсоно, мэдэгдэл+retry харагдана; retry дарахад badge/мэдэгдэл/товч анхны төлөвт, дахин polling эхэлнэ`, async () => {
    const t = setup();
    t.queue.push(reply);
    t.api.pollPaymentStatus("tx1"); await t.flush();
    assert.equal(t.api.getTimer(), null);
    assert.equal(t.els.paymentStatusBadge.className, "status-badge " + badge);
    assert.ok(t.els.paymentNotice.find("button"));
    await t.tick(9000);
    assert.equal(t.calls.length, 1, "terminal-ийн дараа хүсэлт илгээгдэхгүй");
    // retry → PENDING
    t.els.paymentCancelBtn.style.display = "none";
    t.els.paymentNotice.find("button")!.onclick();
    assert.equal(t.els.paymentStatusBadge.className, "status-badge status-pending");
    assert.equal(t.els.paymentStatusBadge.textContent, "Төлбөр хүлээгдэж байна...");
    assert.equal(t.els.paymentNotice.textContent, "");
    assert.equal(t.els.paymentCancelBtn.style.display, "");
    await t.flush();
    assert.equal(t.calls.length, 2, "retry нь шууд шалгана");
    assert.notEqual(t.api.getTimer(), null);
    await t.tick(3000);
    assert.equal(t.calls.length, 3);
  });
}

test("PENDING хариу өмнөх анхааруулга/badge-ийг арилгаж 'хүлээж байна' төлөвт буцаана", async () => {
  const t = setup();
  t.queue.push("throw", "throw", "throw", pending);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  await t.tick(3000); await t.tick(3000);
  assert.match(t.els.paymentNotice.textContent, /Интернет/);
  await t.tick(3000);
  assert.equal(t.els.paymentNotice.textContent, "");
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-pending");
  assert.equal(t.els.paymentStatusBadge.textContent, "Төлбөр хүлээгдэж байна...");
});

test("түр зуурын алдаа (сүлжээ/500/буруу JSON) polling-ийг зогсоохгүй", async () => {
  const t = setup();
  t.queue.push("throw", { status: 500, body: {} }, { status: 200, badJson: true });
  t.api.pollPaymentStatus("tx1"); await t.flush();
  await t.tick(3000); await t.tick(3000);
  assert.notEqual(t.api.getTimer(), null);
  await t.tick(3000);
  assert.equal(t.calls.length, 4);
});

test("timeout: 15 минутын дараа interval цэвэрлэгдэнэ, мэдэгдэл+retry; үлдэгдэл interval байхгүй", async () => {
  const t = setup();
  t.api.pollPaymentStatus("tx1"); await t.flush();
  for (let i = 0; i < 301; i++) await t.tick(3000); // 15 мин 3 сек
  assert.equal(t.api.getTimer(), null);
  assert.equal(t.els.paymentStatusBadge.textContent, "Хугацаа дууслаа");
  assert.ok(t.els.paymentNotice.find("button"));
  const n = t.calls.length;
  await t.tick(30_000);
  assert.equal(t.calls.length, n);
  // retry → шинэ 15 мин цонх, шууд шалгана
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  assert.equal(t.calls.length, n + 1);
  await t.tick(3000);
  assert.equal(t.calls.length, n + 2);
  assert.equal(t.els.paymentStatusBadge.textContent, "Төлбөр хүлээгдэж байна...");
});

test("retry олон дарсан ч нэг л interval ажиллана (stale interval үлдэхгүй)", async () => {
  const t = setup();
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.api.pollPaymentStatus("tx1"); await t.flush();
  const before = t.calls.length;
  await t.tick(3000);
  assert.equal(t.calls.length, before + 1);
});

test("stopPaymentPolling (захиалга цуцлах): interval зогсоно, дараа ирсэн stale хариу UI-д нөлөөлөхгүй, showOrderComplete дуудагдахгүй", async () => {
  const t = setup();
  let release: any; t.queue.push(new Promise(r => { release = r; }));
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.api.stopPaymentPolling();
  assert.equal(t.api.getTimer(), null);
  release({ status: 200, ok: true, json: async () => ({ status: "PAID" }) });
  await t.flush(); await t.tick(5000);
  assert.equal(t.completed(), 0);
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-pending");
  assert.equal(t.calls.length, 1);
});

test("restart хийсний дараа хуучин poll-ийн stale хариу шинэ poll-ийн UI-г дарахгүй", async () => {
  const t = setup();
  let release: any; t.queue.push(new Promise(r => { release = r; }));
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.queue.push(pending);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  release({ status: 200, ok: true, json: async () => ({ status: "FAILED" }) });
  await t.flush();
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-pending");
  assert.equal(t.els.paymentNotice.textContent, "");
  assert.notEqual(t.api.getTimer(), null);
});

test("PAID-ийн дараах 1.2 сек хүлээлтэд цуцалбал showOrderComplete дуудагдахгүй", async () => {
  const t = setup();
  t.queue.push(paid);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.api.stopPaymentPolling();
  await t.tick(2000);
  assert.equal(t.completed(), 0);
});

// ---- Regression: PAID_UNAPPLIED баталгаажсаны дараах retry ----
function assertUnappliedPreserved(t: ReturnType<typeof setup>) {
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-warn");
  assert.match(t.els.paymentStatusBadge.textContent, /Төлбөр хүлээн авагдсан/);
  assert.match(t.els.paymentNotice.textContent, /Бараа дууссан/); // шалтгаан
  assert.match(t.els.paymentNotice.textContent, /Лавлах дугаар: tx1/);
  assert.equal(t.els.paymentCancelBtn.style.display, "none"); // цуцлах товч нуугдсан хэвээр
  assert.ok(t.els.paymentNotice.find("button"), "retry товч байх ёстой");
}

for (const [name, reply] of [
  ["PENDING", { status: 200, body: { status: "PENDING" } }],
  ["сүлжээний алдаа", "throw"],
  ["HTTP 500", { status: 500, body: {} }],
  ["буруу JSON", { status: 200, badJson: true }],
  ["401", { status: 401, body: {} }],
  ["403", { status: 403, body: {} }],
  ["404", { status: 404, body: {} }],
  ["FAILED", { status: 200, body: { status: "FAILED" } }],
  ["EXPIRED", { status: 200, body: { status: "EXPIRED" } }],
] as [string, Reply][]) {
  test(`REGRESSION: PAID_UNAPPLIED → retry → ${name}: анхааруулга, шалтгаан, лавлах дугаар, нуугдсан цуцлах товч хэвээр; амжилт биш`, async () => {
    const t = setup();
    t.queue.push(unapplied, reply);
    t.api.pollPaymentStatus("tx1"); await t.flush();
    assertUnappliedPreserved(t);
    t.els.paymentNotice.find("button")!.onclick();
    // хариу ирэхээс өмнө (in-flight) ч UI арилахгүй
    assertUnappliedPreserved(t);
    await t.flush();
    assertUnappliedPreserved(t);
    assert.match(t.els.paymentNotice.textContent, /Дахин шалгалаа|Түр холболт|\(40[134]\)/);
    assert.equal(t.completed(), 0);
    assert.equal(t.calls.length, 2);
    assert.equal(t.api.getTimer(), null, "retry нэг удаагийн шалгалт, interval үлдэхгүй");
    await t.tick(20_000);
    assert.equal(t.calls.length, 2);
    assert.equal(t.completed(), 0);
  });
}

test("REGRESSION: PAID_UNAPPLIED → олон удаа retry PENDING → тайлбар давхардахгүй, төлөв хэвээр; дараа нь PAID(applied) бол л амжилт", async () => {
  const t = setup();
  t.queue.push(unapplied, pending, pending);
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  assertUnappliedPreserved(t);
  assert.equal((t.els.paymentNotice.textContent.match(/Дахин шалгалаа/g) ?? []).length, 1);
  t.queue.push(paid);
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  await t.tick(1200);
  assert.equal(t.completed(), 1);
  assert.equal(t.els.paymentStatusBadge.className, "status-badge status-paid");
});

test("REGRESSION: PAID_UNAPPLIED → retry → өөр unapplied шалтгаан ирвэ шинэ шалтгаан харагдана (backend-ийн баталгаатай PAID хариу)", async () => {
  const t = setup();
  t.queue.push(unapplied, { status: 200, body: { status: "PAID", applied: false, unappliedReason: "CANCELLED" } });
  t.api.pollPaymentStatus("tx1"); await t.flush();
  t.els.paymentNotice.find("button")!.onclick(); await t.flush();
  assert.match(t.els.paymentNotice.textContent, /цуцлагдсан/);
  assert.equal(t.els.paymentCancelBtn.style.display, "none");
  assert.equal(t.completed(), 0);
});
