// F5 — controller бүрийн route хамгаалалтыг эх кодоос статикаар шалгана (шинэ route нэмээд auth мартвал тест унана).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const dir = path.resolve(__dirname, "../src/controllers");
const ROUTE = /\b(\w*[rR]outer)\.(get|post|put|patch|delete)\(\s*(["'`])(.*?)\3\s*,([\s\S]*?)(?:async\b|\(req|\(_req)/g;
const USE = /\b(\w*[rR]outer)\.use\(([^)]*)\)/g;
const AUTH = /requireAuth|requireRole|requireAdmin|requireCourierAuth|requireSellerAuth/;

// Зориуд нээлттэй (public) controller-ууд / route-ууд. Шинээр нэмэхдээ ЭНД зориудаар бүртгэнэ.
const PUBLIC_FILES = new Set(["auth.controller.ts", "courier-auth.controller.ts", "customer-tracking.controller.ts", "image-proxy.controller.ts", "maps.controller.ts", "public.controller.ts", "tracking.controller.ts"]);
const PUBLIC_ROUTES: Record<string, RegExp> = {
  "payment.controller.ts": /^\/webhook\//, // gateway callback — JWT-гүй, гарын үсэг/дахин шалгалтаар хамгаална
  "seller-portal.controller.ts": /^\/login$/, // нэвтрэх endpoint (rate-limit-тэй), router.use(requireSellerAuth)-ээс өмнө
  "settings.controller.ts": /^(\/|\/check-delivery-boundary|\/compute-delivery-fee|\/compute-delivery-fee-by-district|\/boundary-points)$/, // зөвхөн GET/хүргэлтийн тооцоо
};
const PUBLIC_METHOD_GUARD: Record<string, string[]> = { "settings.controller.ts": ["get", "post"] };

function analyse(file: string) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const uses: Array<{ idx: number; text: string }> = [];
  for (const m of src.matchAll(USE)) uses.push({ idx: m.index!, text: m[2] });
  const routes = [...src.matchAll(ROUTE)].map((m) => ({ idx: m.index!, method: m[2], p: m[4], mw: m[5] }));
  return { src, uses, routes };
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));

test("controller бүрийн route нь auth-тай эсвэл зориуд public жагсаалтад бий", () => {
  const problems: string[] = [];
  for (const f of files) {
    if (PUBLIC_FILES.has(f)) continue;
    const { uses, routes } = analyse(f);
    for (const r of routes) {
      const covered = uses.some((u) => u.idx < r.idx && AUTH.test(u.text)) || AUTH.test(r.mw);
      if (covered) continue;
      const pub = PUBLIC_ROUTES[f];
      if (pub && pub.test(r.p) && (!PUBLIC_METHOD_GUARD[f] || PUBLIC_METHOD_GUARD[f].includes(r.method) || f === "payment.controller.ts")) {
        // settings: mutating (put/delete) public байж болохгүй
        if (f === "settings.controller.ts" && (r.method === "put" || r.method === "delete")) { problems.push(`${f} ${r.method} ${r.p}`); }
        continue;
      }
      problems.push(`${f} ${r.method.toUpperCase()} ${r.p}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("/api/custom-orders router-т router.use(requireAuth) байгаа", () => {
  const { uses, routes } = analyse("custom-orders.controller.ts");
  assert.ok(routes.length >= 2);
  for (const r of routes) assert.ok(uses.some((u) => u.idx < r.idx && /requireAuth/.test(u.text)), `${r.method} ${r.p}`);
});

// Санхүү / устгал / эрх өөрчлөх route-ууд ADMIN шаардах ёстой
const ADMIN_ONLY: Array<[string, string, string]> = [
  ["order.controller.ts", "post", "/:id/errand-refund"],
  ["courier.controller.ts", "post", "/:id/verify"],
  ["courier.controller.ts", "post", "/:id/deposit"],
  ["courier.controller.ts", "post", "/:id/payouts"],
  ["seller.controller.ts", "post", "/:id/portal-pin"],
  ["seller.controller.ts", "post", "/payouts/pay-all"],
  ["seller.controller.ts", "post", "/:id/payouts"],
  ["seller.controller.ts", "patch", "/:id/status"],
  ["seller-order.controller.ts", "post", "/:id/refund-done"],
  ["materials.controller.ts", "post", "/seed-defaults"],
  ["materials.controller.ts", "delete", "/:id"],
  ["featured.controller.ts", "post", "/packages"],
  ["featured.controller.ts", "patch", "/packages/:id"],
  ["featured.controller.ts", "delete", "/packages/:id"],
  ["featured.controller.ts", "post", "/promotions/:id/refunded"],
  ["settings.controller.ts", "put", "/"],
  ["settings.controller.ts", "post", "/boundary-points"],
  ["settings.controller.ts", "delete", "/boundary-points/:id"],
  ["settings.controller.ts", "put", "/boundary-points/reorder"],
];
for (const [f, method, p] of ADMIN_ONLY) {
  test(`ADMIN-only: ${f} ${method.toUpperCase()} ${p}`, () => {
    const { routes } = analyse(f);
    const r = routes.find((x) => x.method === method && x.p === p);
    assert.ok(r, "route олдсонгүй");
    assert.match(r!.mw, /requireRole\(\s*"ADMIN"\s*\)|requireAdmin/);
  });
}

test("order устгах/төлөв солих route-ууд requireRole + guard ашигладаг", () => {
  const src = fs.readFileSync(path.join(dir, "order.controller.ts"), "utf8");
  assert.match(src, /router\.delete\("\/:id", requireRole/);
  assert.match(src, /router\.post\("\/bulk-delete", requireRole/);
  assert.match(src, /router\.patch\("\/:id\/status", requireRole/);
  assert.match(src, /assessOrderDeletion/);
  assert.match(src, /planStatusChange/);
  // raw болзолгүй paymentStatus шинэчлэлт байхгүй
  assert.doesNotMatch(src, /prisma\.order\.update\(\{\s*where: \{ id: req\.params\.id \},\s*data: \{\s*paymentStatus,/);
});
