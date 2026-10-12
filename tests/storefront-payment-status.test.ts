// Фаз 1 — storefront.html-ийн төлбөрийн төлвийн ЦЭВЭР логик (PAYMENT_STATUS_PURE блок). DOM/сүлжээ ашиглахгүй, шинэ dependency-гүй.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const html = fs.readFileSync(path.resolve(__dirname, "../../storefront.html"), "utf8");
const start = html.indexOf("// <PAYMENT_STATUS_PURE_START>");
const end = html.indexOf("// <PAYMENT_STATUS_PURE_END>");
assert.ok(start > 0 && end > start, "PAYMENT_STATUS_PURE блок олдсонгүй");
const block = html.slice(start, end);

const api: any = new Function(
  `${block}\nreturn { PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_TIMEOUT_MS, PAYMENT_WARN_AFTER_FAILURES, paymentUnappliedMessage, classifyPaymentPoll, isTerminalPaymentPollKind, paymentPollProblemMessage, hasPaymentPollTimedOut };`
)();
const c = api.classifyPaymentPoll;

test("PAID, applied талбаргүй (backend-ийн хэвийн гэрээ) → PAID_APPLIED", () => {
  assert.deepEqual(c(200, { status: "PAID", paidAt: "2026-10-10T00:00:00Z" }), { kind: "PAID_APPLIED" });
});

test("PAID + applied:true (ирвэл ч амжилт) → PAID_APPLIED", () => {
  assert.deepEqual(c(200, { status: "PAID", applied: true }), { kind: "PAID_APPLIED" });
});

test("PAID + applied:false → PAID_UNAPPLIED, шалтгаан дамжина; амжилт БИШ", () => {
  const r = c(200, { status: "PAID", paidAt: "x", applied: false, unappliedReason: "INSUFFICIENT_STOCK" });
  assert.deepEqual(r, { kind: "PAID_UNAPPLIED", reason: "INSUFFICIENT_STOCK" });
  assert.notEqual(r.kind, "PAID_APPLIED");
});

test("applied:false боловч unappliedReason байхгүй/текст биш → reason=null", () => {
  assert.deepEqual(c(200, { status: "PAID", applied: false }), { kind: "PAID_UNAPPLIED", reason: null });
  assert.deepEqual(c(200, { status: "PAID", applied: false, unappliedReason: 5 }), { kind: "PAID_UNAPPLIED", reason: null });
});

test("applied нь bool биш ('false' текст) бол unapplied гэж таамаглахгүй, амжилт ч гэж зохиохгүй зөвхөн === false-ийг шалгана", () => {
  assert.equal(c(200, { status: "PAID", applied: "false" }).kind, "PAID_APPLIED");
});

test("PENDING / FAILED / EXPIRED", () => {
  assert.equal(c(200, { status: "PENDING" }).kind, "PENDING");
  assert.equal(c(200, { status: "FAILED" }).kind, "FAILED");
  assert.equal(c(200, { status: "EXPIRED" }).kind, "EXPIRED");
});

test("үл мэдэгдэх / байхгүй status, JSON биш → UNKNOWN_STATUS (хэзээ ч амжилт биш)", () => {
  for (const body of [{ status: "WHATEVER" }, {}, null, "PAID", 5, [], { status: "paid" }]) {
    assert.equal(c(200, body as any).kind, "UNKNOWN_STATUS", JSON.stringify(body));
  }
});

test("HTTP 401 / 403 / 404 тусад нь ялгагдана, терминал", () => {
  assert.equal(c(401, null).kind, "UNAUTHORIZED");
  assert.equal(c(403, { error: "x" }).kind, "FORBIDDEN");
  assert.equal(c(404, { error: "Олдсонгүй" }).kind, "NOT_FOUND");
  for (const k of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]) assert.equal(api.isTerminalPaymentPollKind(k), true);
});

test("500 / 429 → HTTP_ERROR, сүлжээний алдаа → NETWORK_ERROR; хоёул түр зуурын (терминал биш)", () => {
  assert.deepEqual(c(500, null), { kind: "HTTP_ERROR", httpStatus: 500 });
  assert.deepEqual(c(429, null), { kind: "HTTP_ERROR", httpStatus: 429 });
  assert.equal(c(null, null).kind, "NETWORK_ERROR");
  for (const k of ["HTTP_ERROR", "NETWORK_ERROR", "UNKNOWN_STATUS", "PENDING"]) assert.equal(api.isTerminalPaymentPollKind(k), false);
});

test("401/403/404 бүрт тусдаа ойлгомжтой мессеж; FAILED/EXPIRED/TIMEOUT мессежтэй", () => {
  const msgs = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "FAILED", "EXPIRED", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR"].map((k) => api.paymentPollProblemMessage(k));
  assert.equal(new Set(msgs).size, msgs.length);
  assert.ok(msgs.every((m: string) => m.length > 10));
});

test("unappliedReason тайлбар: backend-ийн бүх шалтгаан + үл мэдэгдэх + null", () => {
  for (const r of ["ORDER_NOT_FOUND", "CANCELLED", "REFUNDED", "ALREADY_PAID", "NOTHING_DUE", "INSUFFICIENT_STOCK"]) {
    assert.ok(api.paymentUnappliedMessage(r).endsWith("."), r);
    assert.ok(!api.paymentUnappliedMessage(r).startsWith("Шалтгаан:"), r);
  }
  assert.equal(api.paymentUnappliedMessage("NEW_CODE"), "Шалтгаан: NEW_CODE"); // зохиож тайлбарлахгүй
  assert.equal(api.paymentUnappliedMessage(null), "Шалтгаан тодорхойгүй байна.");
});

test("timeout: интервал/хугацаа хэвээр (3с / 15мин), хязгаараас хойш л дуусна", () => {
  assert.equal(api.PAYMENT_POLL_INTERVAL_MS, 3000);
  assert.equal(api.PAYMENT_POLL_TIMEOUT_MS, 15 * 60 * 1000);
  assert.equal(api.hasPaymentPollTimedOut(0, 15 * 60 * 1000, api.PAYMENT_POLL_TIMEOUT_MS), false);
  assert.equal(api.hasPaymentPollTimedOut(0, 15 * 60 * 1000 + 1, api.PAYMENT_POLL_TIMEOUT_MS), true);
  assert.equal(api.PAYMENT_WARN_AFTER_FAILURES, 3);
});

test("storefront: showOrderComplete зөвхөн PAID_APPLIED салбарт дуудагдана; polling алдааг чимээгүй залгихгүй", () => {
  const from = html.indexOf("function pollPaymentStatus(");
  const poll = html.slice(from, html.indexOf("ЗАХИАЛГЫН ХЯНАЛТЫН ХУУДАС", from));
  assert.ok(from > 0 && poll.length > 500);
  assert.equal((poll.match(/showOrderComplete\(\)/g) ?? []).length, 1);
  const idx = poll.indexOf("showOrderComplete()");
  assert.ok(poll.lastIndexOf("PAID_APPLIED", idx) > poll.lastIndexOf("PAID_UNAPPLIED", idx) || poll.lastIndexOf("PAID_UNAPPLIED", idx) === -1);
  assert.doesNotMatch(poll, /catch \(e\) \{ \/\* дараагийн poll дээр дахин оролдоно \*\/ \}/);
});
