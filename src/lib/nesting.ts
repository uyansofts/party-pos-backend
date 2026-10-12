// ============================================================================
// NESTING — тэгш өнцөгт (bounding-box) дээр суурилсан байршуулалт (MaxRects, Best Short Side Fit)
// ----------------------------------------------------------------------------
// ⚠️ ХЯЗГААРЛАЛТ (хэрэглэгчид ил харуулна):
//   - Загвар бүрийг түүний ХЭМЖЭЭНИЙ ТЭГШ ӨНЦӨГТ (bounding box)-оор авна. Нарийн дүрсийн (дугуй, од) бодит
//     контурыг ашиглан завсар руу шургуулахгүй → бодит геометрийн nesting-ээс ХУУЧИН байж болно.
//   - Хамгийн оновчтой (optimal) байршуулалтыг ГАРАНТИЛАХГҮЙ: энэ нь heuristic. Олон хувилбар харьцуулж, хамгийн
//     сайныг нь сонгодог ч "хамгийн сайн боломжит" гэж зарлахгүй.
//   - Эргүүлэлт зөвхөн 90°.
//   - Зүсэлтийн зай (spacing), margin, kerf-ийг ХЭРЭГЛЭГЧ тохируулна — материалд тохирох эсэхийг энд баталгаажуулахгүй.
// Баталгаа: validateLayout() нь аливаа үр дүнд давхцал, хил хэтрэлт, зайн зөрчил байхгүйг ТУСДАА шалгана.
// Бүх тооцоог 1/100 см-ийн бүхэл тоогоор (хөвөх таслалгүй) хийнэ.
// ============================================================================

export class NestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestingError";
  }
}

export interface DesignInput {
  id: string;
  name?: string;
  widthCm: number;
  heightCm: number;
  quantity: number;
  /** Заавал биш: SVG path "d" (0,0 эхлэлтэй, см нэгжтэй). Байвал SVG экспортод бодит контур, байхгүй бол тэгш өнцөгт. */
  path?: string;
}

export interface NestingInput {
  /** SHEET: тогтсон хэмжээтэй хуудас (олон хуудас). ROLL: тогтсон өргөнтэй, үнэгүй урт. */
  mode: "SHEET" | "ROLL";
  sheetWidthCm: number; // ROLL үед рулоны өргөн
  sheetHeightCm?: number; // SHEET үед
  marginCm: number;
  spacingCm: number;
  allowRotate: boolean;
  designs: DesignInput[];
  maxSheets?: number; // SHEET: хамгийн ихдээ
  strategy?: SortStrategy;
}

export type SortStrategy = "AREA" | "LONG_SIDE" | "WIDTH";

export interface Placement {
  designId: string;
  index: number; // тухайн загварын хэд дэх ширхэг
  sheet: number;
  xCm: number;
  yCm: number;
  widthCm: number; // байршуулсан (эргүүлсэн бол сольсон) хэмжээ
  heightCm: number;
  rotated: boolean;
}

export interface SheetResult {
  index: number;
  widthCm: number;
  heightCm: number; // ROLL үед ашигласан урт
  placements: Placement[];
  usedAreaCm2: number;
  utilization: number; // 0..1 (ашигласан талбай / хуудасны талбай)
}

export interface NestingResult {
  mode: "SHEET" | "ROLL";
  strategy: SortStrategy;
  allowRotate: boolean;
  sheets: SheetResult[];
  unplaced: Array<{ designId: string; index: number; reason: string }>;
  totalPieces: number;
  placedPieces: number;
  usedAreaCm2: number;
  sheetAreaCm2: number; // нийт хуудас/рулоны ашигласан талбай
  wasteAreaCm2: number;
  utilization: number;
  rollLengthCm?: number;
  warnings: string[];
}

const S = 100; // 1 см = 100 нэгж
const toU = (cm: number) => Math.round(cm * S);
const toCm = (u: number) => u / S;

interface R { x: number; y: number; w: number; h: number }

class Bin {
  free: R[];
  constructor(public w: number, public h: number) {
    this.free = [{ x: 0, y: 0, w, h }];
  }
  /** Best Short Side Fit: үлдэх богино талын зай хамгийн бага байх чөлөөт тэгш өнцөгт. */
  find(w: number, h: number, rotate: boolean): { x: number; y: number; w: number; h: number; rotated: boolean; s1: number; s2: number } | null {
    let best: ReturnType<Bin["find"]> = null;
    const tryFit = (pw: number, ph: number, rotated: boolean) => {
      for (const f of this.free) {
        if (pw <= f.w && ph <= f.h) {
          const lw = f.w - pw;
          const lh = f.h - ph;
          const s1 = Math.min(lw, lh);
          const s2 = Math.max(lw, lh);
          if (!best || s1 < best.s1 || (s1 === best.s1 && s2 < best.s2)) best = { x: f.x, y: f.y, w: pw, h: ph, rotated, s1, s2 };
        }
      }
    };
    tryFit(w, h, false);
    if (rotate && w !== h) tryFit(h, w, true);
    return best;
  }
  place(r: R) {
    const next: R[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // contained-аар нь хасах
    this.free = next.filter((a, i) => !next.some((b, j) => i !== j && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || i > j)));
  }
}

export const LIMITS = { maxDesigns: 50, maxPieces: 2000, minDimCm: 0.1, maxDimCm: 1000, maxSheets: 200 };

function validateInput(inp: NestingInput) {
  if (inp.mode !== "SHEET" && inp.mode !== "ROLL") throw new NestingError("mode нь SHEET эсвэл ROLL байх ёстой");
  const okDim = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < LIMITS.minDimCm || v > LIMITS.maxDimCm) throw new NestingError(`${name} нь ${LIMITS.minDimCm}–${LIMITS.maxDimCm} см хооронд байх ёстой`);
  };
  okDim(inp.sheetWidthCm, "Хуудас/рулоны өргөн");
  if (inp.mode === "SHEET") okDim(inp.sheetHeightCm, "Хуудасны өндөр");
  for (const [v, n] of [[inp.marginCm, "margin"], [inp.spacingCm, "Зай"]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 50) throw new NestingError(`${n} нь 0–50 см байх ёстой`);
  }
  if (!Array.isArray(inp.designs) || inp.designs.length === 0) throw new NestingError("Дор хаяж нэг загвар шаардлагатай");
  if (inp.designs.length > LIMITS.maxDesigns) throw new NestingError(`Загварын төрөл ${LIMITS.maxDesigns}-аас ихгүй байх ёстой`);
  const ids = new Set<string>();
  let pieces = 0;
  for (const d of inp.designs) {
    if (!d || typeof d.id !== "string" || !d.id) throw new NestingError("Загвар бүрт id шаардлагатай");
    if (ids.has(d.id)) throw new NestingError(`Загварын id давхардсан: ${d.id}`);
    ids.add(d.id);
    okDim(d.widthCm, `Загвар "${d.id}" өргөн`);
    okDim(d.heightCm, `Загвар "${d.id}" өндөр`);
    if (!Number.isInteger(d.quantity) || d.quantity < 1) throw new NestingError(`Загвар "${d.id}" тоо ширхэг бүхэл тоо ≥ 1 байх ёстой`);
    pieces += d.quantity;
  }
  if (pieces > LIMITS.maxPieces) throw new NestingError(`Нийт ширхэг ${LIMITS.maxPieces}-аас ихгүй байх ёстой`);
}

export function nest(inp: NestingInput): NestingResult {
  validateInput(inp);
  const strategy: SortStrategy = inp.strategy ?? "AREA";
  const margin = toU(inp.marginCm);
  const spacing = toU(inp.spacingCm);
  const W = toU(inp.sheetWidthCm);
  const isRoll = inp.mode === "ROLL";
  const H = isRoll ? toU(100_000) : toU(inp.sheetHeightCm as number); // ROLL: практикт хязгааргүй урт
  const maxSheets = Math.min(inp.maxSheets ?? LIMITS.maxSheets, LIMITS.maxSheets);
  // Bin = ашиглах боломжтой хэсэг (margin хасаж), spacing-ийг тооцоход нэмэлт spacing зөөнө (сүүлчийн ширхэгийн хойно зай шаардахгүй).
  const binW = W - 2 * margin + spacing;
  const binH = H - 2 * margin + spacing;

  type Piece = { designId: string; index: number; w: number; h: number };
  const pieces: Piece[] = [];
  const warnings: string[] = [
    "Байршуулалт нь загварын тэгш өнцөгт хүрээнд (bounding box) суурилсан heuristic — хамгийн оновчтой гэж баталгаажаагүй.",
  ];
  for (const d of inp.designs) {
    for (let i = 0; i < d.quantity; i++) pieces.push({ designId: d.id, index: i, w: toU(d.widthCm), h: toU(d.heightCm) });
  }
  const key = (p: Piece) => (strategy === "LONG_SIDE" ? Math.max(p.w, p.h) * 1e9 + p.w * p.h : strategy === "WIDTH" ? p.w * 1e9 + p.h : p.w * p.h);
  pieces.sort((a, b) => key(b) - key(a) || a.designId.localeCompare(b.designId) || a.index - b.index);

  const bins: Bin[] = [];
  const placed: Array<Placement & { _sheet: number }> = [];
  const unplaced: NestingResult["unplaced"] = [];

  for (const p of pieces) {
    const fw = p.w + spacing;
    const fh = p.h + spacing;
    let done = false;
    for (let b = 0; b < bins.length && !done; b++) {
      const f = bins[b].find(fw, fh, inp.allowRotate);
      if (f) {
        bins[b].place({ x: f.x, y: f.y, w: f.w, h: f.h });
        placed.push({ designId: p.designId, index: p.index, sheet: b, xCm: toCm(margin + f.x), yCm: toCm(margin + f.y), widthCm: toCm(f.rotated ? p.h : p.w), heightCm: toCm(f.rotated ? p.w : p.h), rotated: f.rotated, _sheet: b });
        done = true;
      }
    }
    if (done) continue;
    if (!isRoll && bins.length >= maxSheets) {
      unplaced.push({ designId: p.designId, index: p.index, reason: `Хуудасны дээд хязгаар (${maxSheets}) хүрсэн` });
      continue;
    }
    const nb = new Bin(binW, binH);
    const f = nb.find(fw, fh, inp.allowRotate);
    if (!f) {
      unplaced.push({
        designId: p.designId,
        index: p.index,
        reason: `Хэмжээ (${toCm(p.w)}×${toCm(p.h)} см) margin/зайг хасахад ${isRoll ? "рулоны өргөн" : "хуудас"} (${inp.sheetWidthCm}${isRoll ? "" : `×${inp.sheetHeightCm}`} см)-д багтахгүй`,
      });
      continue;
    }
    bins.push(nb);
    nb.place({ x: f.x, y: f.y, w: f.w, h: f.h });
    placed.push({ designId: p.designId, index: p.index, sheet: bins.length - 1, xCm: toCm(margin + f.x), yCm: toCm(margin + f.y), widthCm: toCm(f.rotated ? p.h : p.w), heightCm: toCm(f.rotated ? p.w : p.h), rotated: f.rotated, _sheet: bins.length - 1 });
  }

  const sheets: SheetResult[] = bins.map((_, i) => {
    const pl = placed.filter((x) => x._sheet === i).map(({ _sheet, ...rest }) => rest);
    const usedU = pl.reduce((s, q) => s + toU(q.widthCm) * toU(q.heightCm), 0);
    const heightCm = isRoll ? toCm(Math.max(0, ...pl.map((q) => toU(q.yCm) + toU(q.heightCm))) + margin) : (inp.sheetHeightCm as number);
    const area = Math.round(toU(inp.sheetWidthCm) * toU(heightCm)) / (S * S);
    return { index: i, widthCm: inp.sheetWidthCm, heightCm, placements: pl, usedAreaCm2: usedU / (S * S), utilization: area > 0 ? usedU / (S * S) / area : 0 };
  });

  const usedAreaCm2 = sheets.reduce((s, x) => s + x.usedAreaCm2, 0);
  const sheetAreaCm2 = sheets.reduce((s, x) => s + x.widthCm * x.heightCm, 0);
  if (unplaced.length) warnings.push(`${unplaced.length} ширхэг байрлаагүй — тайлбарыг unplaced хэсгээс харна уу.`);
  return {
    mode: inp.mode,
    strategy,
    allowRotate: inp.allowRotate,
    sheets,
    unplaced,
    totalPieces: pieces.length,
    placedPieces: placed.length,
    usedAreaCm2: Math.round(usedAreaCm2 * 1e4) / 1e4,
    sheetAreaCm2: Math.round(sheetAreaCm2 * 1e4) / 1e4,
    wasteAreaCm2: Math.round((sheetAreaCm2 - usedAreaCm2) * 1e4) / 1e4,
    utilization: sheetAreaCm2 > 0 ? usedAreaCm2 / sheetAreaCm2 : 0,
    ...(isRoll ? { rollLengthCm: sheets[0] ? sheets[0].heightCm : 0 } : {}),
    warnings,
  };
}

/** Үр дүнг ТУСДАА шалгана: бүх ширхэг хил дотор, margin-ийн дотор, хоорондоо spacing-ээс ойр биш, тоо зөв. */
export function validateLayout(inp: NestingInput, res: NestingResult): string[] {
  const errs: string[] = [];
  const m = toU(inp.marginCm);
  const sp = toU(inp.spacingCm);
  const counts = new Map<string, number>();
  for (const sh of res.sheets) {
    const W = toU(sh.widthCm);
    const H = toU(sh.heightCm);
    const pl = sh.placements;
    for (const p of pl) {
      counts.set(p.designId, (counts.get(p.designId) ?? 0) + 1);
      const x = toU(p.xCm), y = toU(p.yCm), w = toU(p.widthCm), h = toU(p.heightCm);
      if (x < m || y < m || x + w > W - m || y + h > H - m) errs.push(`Хил/margin зөрчил: ${p.designId}#${p.index} (хуудас ${sh.index})`);
      const d = inp.designs.find((q) => q.id === p.designId);
      if (!d) errs.push(`Үл мэдэгдэх загвар ${p.designId}`);
      else {
        const dw = toU(d.widthCm), dh = toU(d.heightCm);
        const ok = (w === dw && h === dh) || (p.rotated && inp.allowRotate && w === dh && h === dw);
        if (!ok) errs.push(`Хэмжээ зөрсөн: ${p.designId}#${p.index}`);
      }
    }
    for (let i = 0; i < pl.length; i++) {
      for (let j = i + 1; j < pl.length; j++) {
        const a = pl[i], b = pl[j];
        const ax = toU(a.xCm), ay = toU(a.yCm), aw = toU(a.widthCm), ah = toU(a.heightCm);
        const bx = toU(b.xCm), by = toU(b.yCm), bw = toU(b.widthCm), bh = toU(b.heightCm);
        // хоорондох зай ≥ spacing (Chebyshev: x эсвэл y тэнхлэгийн аль нэгээр spacing-ээс их тусгаарлагдсан байх ёстой)
        const sepX = Math.max(bx - (ax + aw), ax - (bx + bw));
        const sepY = Math.max(by - (ay + ah), ay - (by + bh));
        if (Math.max(sepX, sepY) < sp) errs.push(`Давхцал/зай зөрчил: ${a.designId}#${a.index} ↔ ${b.designId}#${b.index} (хуудас ${sh.index})`);
      }
    }
  }
  for (const d of inp.designs) {
    const placedN = counts.get(d.id) ?? 0;
    const unplacedN = res.unplaced.filter((u) => u.designId === d.id).length;
    if (placedN + unplacedN !== d.quantity) errs.push(`Тоо ширхэг зөрсөн: ${d.id} (${placedN}+${unplacedN} ≠ ${d.quantity})`);
  }
  return errs;
}

export interface VariantComparison {
  label: string;
  result: NestingResult;
  sheetsUsed: number;
  utilization: number;
  valid: boolean;
}

/** Эрэмбэлэлт × эргүүлэлт хувилбаруудыг ажиллуулж, ЭХЛЭЭД бүх ширхэг байрласан, дараа нь цөөн хуудас, өндөр ашиглалтаар эрэмблэнэ. */
export function compareVariants(inp: NestingInput): VariantComparison[] {
  const strategies: SortStrategy[] = ["AREA", "LONG_SIDE", "WIDTH"];
  const rotations = inp.allowRotate ? [true, false] : [false];
  const out: VariantComparison[] = [];
  for (const allowRotate of rotations) {
    for (const strategy of strategies) {
      const v: NestingInput = { ...inp, allowRotate, strategy };
      const result = nest(v);
      out.push({ label: `${strategy}${allowRotate ? " + эргүүлэлт" : ""}`, result, sheetsUsed: result.sheets.length, utilization: result.utilization, valid: validateLayout(v, result).length === 0 });
    }
  }
  return out
    .filter((x) => x.valid)
    .sort((a, b) => a.result.unplaced.length - b.result.unplaced.length || (a.result.mode === "ROLL" ? (a.result.rollLengthCm ?? 0) - (b.result.rollLengthCm ?? 0) : a.sheetsUsed - b.sheetsUsed) || b.utilization - a.utilization);
}

// ---------------------------------------------------------------------------
// SVG ЭКСПОРТ
// ---------------------------------------------------------------------------
const SAFE_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]{1,20000}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Хуудас бүрт нэг SVG (см нэгжтэй). Загварт path байвал бодит контур, үгүй бол тэгш өнцөгт хүрээ. */
export function layoutToSvgs(inp: NestingInput, res: NestingResult, opts: { labels?: boolean } = {}): string[] {
  const byId = new Map(inp.designs.map((d) => [d.id, d]));
  return res.sheets.map((sh) => {
    const parts: string[] = [];
    parts.push(`<rect id="sheet-outline" x="0" y="0" width="${sh.widthCm}" height="${sh.heightCm}" fill="none" stroke="#999999" stroke-width="0.05" stroke-dasharray="0.5 0.5"/>`);
    for (const p of sh.placements) {
      const d = byId.get(p.designId)!;
      const hasPath = typeof d.path === "string" && SAFE_PATH.test(d.path);
      if (hasPath) {
        // эргүүлсэн (90° цагийн зүүн): (x,y) → (h - y, x) шилжилттэй
        const tf = p.rotated ? `translate(${p.xCm + p.widthCm} ${p.yCm}) rotate(90)` : `translate(${p.xCm} ${p.yCm})`;
        parts.push(`<path d="${d.path}" transform="${tf}" fill="none" stroke="#000000" stroke-width="0.05"><title>${esc(d.name ?? d.id)}</title></path>`);
      } else {
        parts.push(`<rect x="${p.xCm}" y="${p.yCm}" width="${p.widthCm}" height="${p.heightCm}" fill="none" stroke="#000000" stroke-width="0.05"><title>${esc(d.name ?? d.id)}</title></rect>`);
      }
      if (opts.labels) parts.push(`<text x="${p.xCm + p.widthCm / 2}" y="${p.yCm + p.heightCm / 2}" font-size="${Math.max(0.4, Math.min(p.widthCm, p.heightCm) / 5)}" text-anchor="middle" fill="#cc0000">${esc(d.name ?? d.id)}</text>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${sh.widthCm}cm" height="${sh.heightCm}cm" viewBox="0 0 ${sh.widthCm} ${sh.heightCm}">\n${parts.join("\n")}\n</svg>\n`;
  });
}
