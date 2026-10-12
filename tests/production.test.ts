// ============================================================================
// ҮЙЛДВЭРЛЭЛИЙН ЦӨМИЙН ТЕСТ — нэгж хөрвүүлэлт, nesting, зүсэлтийн тооцоо, SVG экспорт, багцын боломжит тоо
// (DB, сүлжээ шаардахгүй — цэвэр логик)
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnitError, areaCm2, costPerCm2, rollAreaCm2, toCm, usableAreaCm2 } from "../src/lib/units";
import { NestingError, compareVariants, layoutToSvgs, nest, validateLayout, type NestingInput } from "../src/lib/nesting";
import { CuttingError, estimateCutting } from "../src/lib/cutting";
import { BundleError, bundleAvailability, planBundleOrder } from "../src/lib/bundle";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ---------------- UNITS ----------------
test("UNITS: 1 м = 100 см, 1 м² = 10,000 см², таамаглахгүй", () => {
  assert.equal(toCm(1, "m"), 100);
  assert.equal(toCm(25, "mm"), 2.5);
  assert.throws(() => toCm(1, "inch"), UnitError);
  assert.throws(() => toCm(1, undefined), UnitError);
  assert.throws(() => toCm(NaN, "cm"), UnitError);
  near(areaCm2(30.5, 30.5), 930.25, 1e-9);
  assert.equal(rollAreaCm2(30.5, 50), 30.5 * 5000);
  assert.throws(() => rollAreaCm2(0, 5), UnitError);
});

test("UNITS: 30.5×30.5 см хуудас 2,700₮ → см² өртөг = 2700/930.25; margin-ийн дараах ашиглах талбай", () => {
  near(costPerCm2(2700, areaCm2(30.5, 30.5)), 2700 / 930.25, 1e-12);
  near(costPerCm2(2700, 930.25) * 930.25, 2700, 1e-9);
  near(usableAreaCm2(30.5, 30.5, 0.5), 29.5 * 29.5, 1e-9);
  assert.equal(usableAreaCm2(1, 1, 0.5), 0);
  assert.throws(() => costPerCm2(100, 0), UnitError);
});

// ---------------- NESTING ----------------
const sheetIn = (over: Partial<NestingInput> = {}): NestingInput => ({
  mode: "SHEET", sheetWidthCm: 30.5, sheetHeightCm: 30.5, marginCm: 0.5, spacingCm: 0.2, allowRotate: false,
  designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 20 }], ...over,
});

test("NESTING: 20 ширхэг 5×5 нэг хуудсанд багтана, шалгалт цэвэр", () => {
  const inp = sheetIn();
  const r = nest(inp);
  assert.equal(r.sheets.length, 1);
  assert.equal(r.placedPieces, 20);
  assert.deepEqual(validateLayout(inp, r), []);
  near(r.usedAreaCm2, 20 * 25, 1e-6);
});

test("NESTING: хуудасны багтаамж 25 (5 мөр × 5 багана) → 30 ширхэг 2 хуудас", () => {
  const inp = sheetIn({ designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 30 }] });
  const r = nest(inp);
  assert.equal(r.sheets.length, 2);
  assert.equal(r.sheets[0].placements.length, 25);
  assert.equal(r.sheets[1].placements.length, 5);
  assert.deepEqual(validateLayout(inp, r), []);
});

test("NESTING: spacing ба margin-ийг баримтална (зайгүй бол илүү багтана)", () => {
  const tight = sheetIn({ marginCm: 0, spacingCm: 0, sheetWidthCm: 30, sheetHeightCm: 30, designs: [{ id: "a", widthCm: 10, heightCm: 10, quantity: 9 }] });
  assert.equal(nest(tight).sheets.length, 1); // яг 3×3
  const spaced = { ...tight, spacingCm: 0.1 };
  const r = nest(spaced);
  assert.equal(r.sheets.length, 3); // зай 0.1 нэмэхэд нэг хуудсанд 2×2=4 л багтана → ⌈9/4⌉ = 3
  assert.deepEqual(validateLayout(spaced, r), []);
});

test("NESTING: эргүүлэлт — зөвшөөрөөгүй бол багтахгүй, зөвшөөрвөл эргүүлж байрлуулна", () => {
  const base: NestingInput = { mode: "SHEET", sheetWidthCm: 10, sheetHeightCm: 20, marginCm: 0, spacingCm: 0, allowRotate: false, designs: [{ id: "d", widthCm: 20, heightCm: 10, quantity: 1 }] };
  const no = nest(base);
  assert.equal(no.placedPieces, 0);
  assert.equal(no.unplaced.length, 1);
  assert.match(no.unplaced[0].reason, /багтахгүй/);
  const yes = nest({ ...base, allowRotate: true });
  assert.equal(yes.placedPieces, 1);
  assert.equal(yes.sheets[0].placements[0].rotated, true);
  assert.deepEqual(validateLayout({ ...base, allowRotate: true }, yes), []);
});

test("NESTING: хуудаснаас том загвар unplaced, бусад нь байрлана; тоо ширхэг баланс таарна", () => {
  const inp = sheetIn({ designs: [{ id: "big", widthCm: 40, heightCm: 40, quantity: 2 }, { id: "ok", widthCm: 5, heightCm: 5, quantity: 3 }] });
  const r = nest(inp);
  assert.equal(r.unplaced.filter((u) => u.designId === "big").length, 2);
  assert.equal(r.placedPieces, 3);
  assert.deepEqual(validateLayout(inp, r), []);
  assert.ok(r.warnings.some((w) => w.includes("байрлаагүй")));
});

test("NESTING: maxSheets хязгаар", () => {
  const inp = sheetIn({ maxSheets: 1, designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 30 }] });
  const r = nest(inp);
  assert.equal(r.sheets.length, 1);
  assert.equal(r.unplaced.length, 5);
  assert.deepEqual(validateLayout(inp, r), []);
});

test("NESTING: ROLL — урт нь ашигласан талбайгаар (10×10 ×6, өргөн 30)", () => {
  const inp: NestingInput = { mode: "ROLL", sheetWidthCm: 30, marginCm: 0, spacingCm: 0, allowRotate: false, designs: [{ id: "a", widthCm: 10, heightCm: 10, quantity: 6 }] };
  const r = nest(inp);
  assert.equal(r.placedPieces, 6);
  assert.equal(r.rollLengthCm, 20);
  near(r.utilization, 1, 1e-9);
  assert.deepEqual(validateLayout(inp, r), []);
});

test("NESTING: оролтын шалгалт", () => {
  assert.throws(() => nest(sheetIn({ designs: [] })), NestingError);
  assert.throws(() => nest(sheetIn({ designs: [{ id: "a", widthCm: -1, heightCm: 5, quantity: 1 }] })), NestingError);
  assert.throws(() => nest(sheetIn({ designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 1.5 }] })), NestingError);
  assert.throws(() => nest(sheetIn({ designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 1 }, { id: "a", widthCm: 5, heightCm: 5, quantity: 1 }] })), /давхардсан/);
  assert.throws(() => nest(sheetIn({ designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 5000 }] })), /Нийт ширхэг/);
  assert.throws(() => nest({ ...sheetIn(), mode: "X" as any }), NestingError);
  assert.throws(() => nest(sheetIn({ marginCm: -1 })), NestingError);
});

// Санамсаргүй (тогтмол seed) 300 тохиргоо: давхцал, хил, зай, тоо — үргэлж зөв байх ёстой
test("NESTING (property): 300 санамсаргүй тохиргоонд давхцал/хил/зай/тоо зөрчил 0", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a: number, b: number) => Math.round((a + rnd() * (b - a)) * 10) / 10;
  for (let i = 0; i < 300; i++) {
    const inp: NestingInput = {
      mode: rnd() < 0.3 ? "ROLL" : "SHEET",
      sheetWidthCm: pick(15, 80), sheetHeightCm: pick(15, 80),
      marginCm: pick(0, 2), spacingCm: pick(0, 1), allowRotate: rnd() < 0.5,
      designs: Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, k) => ({ id: `d${k}`, widthCm: pick(0.5, 20), heightCm: pick(0.5, 20), quantity: 1 + Math.floor(rnd() * 12) })),
      strategy: (["AREA", "LONG_SIDE", "WIDTH"] as const)[Math.floor(rnd() * 3)],
    };
    const r = nest(inp);
    const errs = validateLayout(inp, r);
    assert.deepEqual(errs, [], `#${i}: ${errs[0]}`);
    assert.ok(r.utilization >= 0 && r.utilization <= 1.000001);
  }
});

test("NESTING: validateLayout өөрөө зөрчлийг барьдаг (хуурамчаар давхцуулсан үр дүн)", () => {
  const inp = sheetIn({ designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 2 }] });
  const r = nest(inp);
  r.sheets[0].placements[1] = { ...r.sheets[0].placements[1], xCm: r.sheets[0].placements[0].xCm, yCm: r.sheets[0].placements[0].yCm };
  assert.ok(validateLayout(inp, r).some((e) => e.includes("Давхцал")));
  const r2 = nest(inp);
  r2.sheets[0].placements[0] = { ...r2.sheets[0].placements[0], xCm: 0 }; // margin-ийн дотор
  assert.ok(validateLayout(inp, r2).some((e) => e.includes("Хил/margin")));
});

test("NESTING: compareVariants — зөв хувилбар эхэнд, бүгд хүчинтэй", () => {
  const inp = sheetIn({ allowRotate: true, designs: [{ id: "a", widthCm: 12, heightCm: 7, quantity: 9 }, { id: "b", widthCm: 3, heightCm: 9, quantity: 8 }] });
  const v = compareVariants(inp);
  assert.ok(v.length >= 3);
  assert.ok(v.every((x) => x.valid));
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1], b = v[i];
    assert.ok(a.result.unplaced.length < b.result.unplaced.length || a.sheetsUsed < b.sheetsUsed || (a.sheetsUsed === b.sheetsUsed && a.utilization >= b.utilization - 1e-12));
  }
});

// ---------------- SVG ----------------
test("SVG: хуудас бүрт нэг SVG, см хэмжээс, ширхэг бүр rect", () => {
  const inp = sheetIn({ designs: [{ id: "a", name: "Нэр <b>", widthCm: 5, heightCm: 5, quantity: 3 }] });
  const r = nest(inp);
  const svgs = layoutToSvgs(inp, r, { labels: true });
  assert.equal(svgs.length, 1);
  assert.match(svgs[0], /^<\?xml/);
  assert.match(svgs[0], /width="30.5cm" height="30.5cm" viewBox="0 0 30.5 30.5"/);
  assert.equal((svgs[0].match(/<rect x=/g) ?? []).length, 3);
  assert.ok(!svgs[0].includes("<b>")); // нэр escape хийгдсэн
  assert.ok(svgs[0].includes("&lt;b&gt;"));
});

test("SVG: path өгвөл контур ашиглана; аюултай path (script) бол ЗӨВХӨН хүрээ, эргүүлсэн бол transform", () => {
  const inp: NestingInput = { mode: "SHEET", sheetWidthCm: 10, sheetHeightCm: 20, marginCm: 0, spacingCm: 0, allowRotate: true,
    designs: [{ id: "p", widthCm: 20, heightCm: 10, quantity: 1, path: "M0 0 L20 0 L20 10 L0 10 Z" }] };
  const svg = layoutToSvgs(inp, nest(inp))[0];
  assert.match(svg, /<path d="M0 0 L20 0 L20 10 L0 10 Z" transform="translate\(10 0\) rotate\(90\)"/);

  const evil: NestingInput = { ...inp, allowRotate: false, sheetWidthCm: 30, sheetHeightCm: 30, designs: [{ id: "e", widthCm: 5, heightCm: 5, quantity: 1, path: '"/><script>alert(1)</script>' }] };
  const out = layoutToSvgs(evil, nest(evil))[0];
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("<path"));
  assert.match(out, /<rect x=/);
});

// ---------------- CUTTING ----------------
test("CUTTING (Cricut, хуудас): материал, өртөг, ашиг — гараар шалгасан тоо", () => {
  const e = estimateCutting({
    machine: { kind: "CRICUT", workWidthCm: 29.2, workHeightCm: 29.2, hourlyRate: 6000, setupMinutes: 5, minutesPerPiece: 2 },
    material: { form: "SHEET", widthCm: 30.5, heightCm: 30.5, purchasePrice: 2700 },
    designs: [{ id: "a", widthCm: 10, heightCm: 10, quantity: 4 }],
    marginCm: 0.5, spacingCm: 0.5, allowRotate: false, markupPercent: 100,
  });
  assert.equal(e.totalPieces, 4);
  assert.equal(e.tiles, 1);
  assert.equal(e.materialUnits, 1);
  near(e.purchasedAreaCm2, 930.25);
  near(e.usedAreaCm2, 400);
  near(e.wastePercent, ((930.25 - 400) / 930.25) * 100);
  assert.equal(e.costs.materialPurchased, 2700);
  near(e.costs.materialUsedArea, (2700 / 930.25) * 400);
  near(e.costs.materialUsedArea + e.costs.materialWaste, 2700);
  assert.equal(e.costs.machine, 1300); // (5 + 2×4) мин × 6000₮/цаг
  assert.equal(e.costs.total, 4000);
  assert.equal(e.costs.perPiece, 1000);
  assert.equal(e.costs.sellPrice, 8000);
  assert.equal(e.costs.profit, 4000);
  assert.equal(e.costs.profitPercent, 50);
});

test("CUTTING: хуудас машины ажлын талбайнаас том бол tile-ээр тооцно", () => {
  const e = estimateCutting({
    machine: { kind: "LASER", workWidthCm: 30, workHeightCm: 30 },
    material: { form: "SHEET", widthCm: 60, heightCm: 60, purchasePrice: 10000, thicknessMm: 3 },
    designs: [{ id: "a", widthCm: 28, heightCm: 28, quantity: 5 }],
    marginCm: 0, spacingCm: 0, allowRotate: false,
  });
  assert.equal(e.tilesPerSheet, 4);
  assert.equal(e.tiles, 5); // нэг tile-д 1 ширхэг → 5 tile
  assert.equal(e.materialUnits, 2); // ⌈5/4⌉ хуудас
  assert.equal(e.costs.materialPurchased, 20000);
  assert.ok(e.assumptions.some((a) => a.includes("tile")));
});

test("CUTTING: kerf-ийг загварын хэмжээнд нэмнэ, assumptions-д ил бичнэ; зузаангүй лазер → анхааруулга", () => {
  const e = estimateCutting({
    machine: { kind: "LASER", workWidthCm: 50, workHeightCm: 50 },
    material: { form: "SHEET", widthCm: 50, heightCm: 50, purchasePrice: 5000 },
    designs: [{ id: "a", widthCm: 24.9, heightCm: 24.9, quantity: 4 }],
    marginCm: 0, spacingCm: 0, kerfCm: 0.2, allowRotate: false,
  });
  // 24.9 + 0.2 = 25.1 → 50 см-д 2×2 багтахгүй (25.1×2 = 50.2) → нэг нь хоёр дахь tile
  assert.equal(e.nesting.sheets.length >= 2, true);
  assert.ok(e.assumptions.some((a) => a.includes("kerf")));
  assert.ok(e.warnings.some((w) => w.includes("зузаан")));
});

test("CUTTING (рулон): урт нь ашигласан урт, үнэ уртад хамаарна", () => {
  const e = estimateCutting({
    machine: { kind: "CRICUT", workWidthCm: 30.5 },
    material: { form: "ROLL", widthCm: 30.5, rollLengthM: 50, purchasePrice: 50000 },
    designs: [{ id: "a", widthCm: 10, heightCm: 10, quantity: 6 }],
    marginCm: 0, spacingCm: 0, allowRotate: false,
  });
  assert.equal(e.materialUnitLabel, "m");
  near(e.materialUnits, 0.2);
  near(e.costs.materialPurchased, 200);
});

test("CUTTING: буруу оролт", () => {
  const base = {
    machine: { kind: "CRICUT" as const, workWidthCm: 29 },
    material: { form: "SHEET" as const, widthCm: 30, heightCm: 30, purchasePrice: 100 },
    designs: [{ id: "a", widthCm: 5, heightCm: 5, quantity: 1 }],
    marginCm: 0, spacingCm: 0, allowRotate: false,
  };
  assert.throws(() => estimateCutting({ ...base, machine: { ...base.machine, workWidthCm: 0 } }), CuttingError);
  assert.throws(() => estimateCutting({ ...base, material: { ...base.material, purchasePrice: -1 } }), CuttingError);
  assert.throws(() => estimateCutting({ ...base, kerfCm: 9 }), CuttingError);
  assert.throws(() => estimateCutting({ ...base, designs: [] }), CuttingError);
  assert.throws(() => estimateCutting({ ...base, material: { form: "ROLL", widthCm: 30, purchasePrice: 100 } as any }), CuttingError);
});

// ---------------- BUNDLE ----------------
test("BUNDLE: 2 шаар(20), 1 малгай(10), 1 лаа(15) → max 10, хязгаарлагч нь малгай", () => {
  const comps = [{ productId: "shaar", quantity: 2 }, { productId: "malgai", quantity: 1 }, { productId: "laa", quantity: 1 }];
  const a = bundleAvailability(comps, { shaar: 20, malgai: 10, laa: 15 });
  assert.equal(a.max, 10);
  assert.deepEqual(a.limitingProductIds.sort(), ["malgai", "shaar"].sort()); // 20/2=10 ба 10/1=10 хоёулаа хязгаар
  assert.equal(bundleAvailability(comps, { shaar: 19, malgai: 10, laa: 15 }).max, 9);
  assert.equal(bundleAvailability(comps, { shaar: 20, malgai: 10 }).max, 0); // нөөцгүй бүрэлдэхүүн
  assert.equal(bundleAvailability(comps, { shaar: 20, malgai: -5, laa: 15 }).max, 0); // сөрөг нөөц 0
});

test("BUNDLE: буруу бүрэлдэхүүн", () => {
  assert.throws(() => bundleAvailability([], {}), BundleError);
  assert.throws(() => bundleAvailability([{ productId: "a", quantity: 0 }], {}), BundleError);
  assert.throws(() => bundleAvailability([{ productId: "a", quantity: 1 }, { productId: "a", quantity: 2 }], {}), /давхардсан/);
});

test("BUNDLE: нэг бараа 2 багц + дан борлуулалтад орвол НИЙТ шаардлагыг нэг нөөцтэй харьцуулна (давхар тоолохгүй)", () => {
  const b1 = { bundleId: "B1", quantity: 3, components: [{ productId: "shaar", quantity: 2 }] }; // 6
  const b2 = { bundleId: "B2", quantity: 2, components: [{ productId: "shaar", quantity: 1 }, { productId: "laa", quantity: 1 }] }; // 2 + laa 2
  const ok = planBundleOrder([b1, b2], { shaar: 10, laa: 5 }, [{ productId: "shaar", quantity: 2 }]); // нийт 6+2+2 = 10
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.deductions, { shaar: 10, laa: 2 });
  const short = planBundleOrder([b1, b2], { shaar: 9, laa: 5 }, [{ productId: "shaar", quantity: 2 }]);
  assert.equal(short.ok, false);
  assert.deepEqual(short.shortages, [{ productId: "shaar", need: 10, have: 9 }]);
  assert.throws(() => planBundleOrder([{ ...b1, quantity: 0 }], {}), BundleError);
});
