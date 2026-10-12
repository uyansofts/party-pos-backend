// ============================================================================
// CUTTING ESTIMATE — Cricut / лазер зүсэлтийн материал, хаягдал, өртгийн тооцоолуур (цэвэр логик)
// ----------------------------------------------------------------------------
// Машины ажлын талбай, margin, зай (spacing), kerf, үнэ БҮГД хэрэглэгчийн тохиргоо — кодод хатуу утга байхгүй.
// Баталгаажаагүй параметрийг (жишээ нь kerf) "зөв" гэж үзэхгүй — үр дүнд assumptions/warnings-аар ил харуулна.
//
// Нэг "хэсэг" (tile) = машинд нэг удаа тавих талбай = min(материалын хэмжээ, машины ажлын талбай).
// Хуудас нь машины ажлын талбайнаас том бол нэг хуудаснаас хэд хэдэн tile гарна.
// Өртөг:
//   purchased   — худалдан авсан бүтэн хуудас/рулоны өртөг (хаягдалтай нь)
//   usedArea    — зүсэлтэнд бодитоор орсон талбайн өртөг
//   waste       — purchased − usedArea (хаягдал + ашиглагдаагүй хэсэг)
// ============================================================================

import { nest, compareVariants, validateLayout, NestingError, type DesignInput, type NestingInput, type NestingResult } from "./nesting";

export class CuttingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuttingError";
  }
}

export interface CuttingInput {
  machine: {
    kind: "CRICUT" | "LASER" | "OTHER";
    name?: string;
    workWidthCm: number; // бодитоор зүсэх боломжтой талбай (нийт хавтангийн хэмжээ БИШ)
    workHeightCm?: number; // ROLL үед ихэвчлэн хязгааргүй (өгөхгүй)
    hourlyRate?: number; // машин ашиглалтын өртөг ₮/цаг
    minutesPerPiece?: number; // нэг ширхэг загварт зарцуулах машины минут
    setupMinutes?: number;
  };
  material: {
    name?: string;
    form: "SHEET" | "ROLL";
    widthCm: number; // хуудасны өргөн / рулоны өргөн
    heightCm?: number; // хуудасны өндөр
    rollLengthM?: number; // рулоны БҮТЭН урт (рулоны үнэ энэ уртад хамаарна)
    purchasePrice: number; // нэг хуудас / нэг бүтэн рулоны худалдан авсан үнэ
    thicknessMm?: number; // зөвхөн мэдээлэл (баталгаажуулалтад ашиглахгүй)
  };
  designs: DesignInput[];
  marginCm: number;
  spacingCm: number;
  kerfCm?: number; // лазер: зүсэлтийн өргөн — загвар бүрийн хэмжээнд нэмж зай үлдээнэ (хэрэглэгч оруулсан, баталгаагүй)
  allowRotate: boolean;
  laborPerHour?: number;
  laborMinutes?: number;
  extraCost?: number; // нэмэлт зардал (хавсралт г.м)
  markupPercent?: number; // борлуулах үнэд нэмэх хувь
}

export interface CuttingEstimate {
  nesting: NestingResult;
  tiles: number; // машинд тавих нийт удаа
  tilesPerSheet: number;
  materialUnits: number; // хэрэгтэй хуудас / рулоны урт (м)
  materialUnitLabel: "sheet" | "m";
  totalPieces: number;
  usedAreaCm2: number;
  purchasedAreaCm2: number;
  wasteAreaCm2: number;
  wastePercent: number;
  costs: {
    materialPurchased: number;
    materialUsedArea: number;
    materialWaste: number;
    machine: number;
    labor: number;
    extra: number;
    total: number;
    perPiece: number;
    sellPrice: number | null;
    profit: number | null;
    profitPercent: number | null;
  };
  assumptions: string[];
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown, name: string, { min = 0, allowZero = true }: { min?: number; allowZero?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || (!allowZero && v === 0)) throw new CuttingError(`${name} буруу байна`);
  return v;
}

export function estimateCutting(input: CuttingInput, opts: { compare?: boolean } = {}): CuttingEstimate {
  const { machine, material } = input;
  if (!machine || !material) throw new CuttingError("machine болон material шаардлагатай");
  const workW = num(machine.workWidthCm, "Машины ажлын талбайн өргөн", { allowZero: false });
  const kerf = input.kerfCm ?? 0;
  num(kerf, "kerf");
  if (kerf > 5) throw new CuttingError("kerf нь 5 см-ээс ихгүй байх ёстой");
  const warnings: string[] = [];
  const assumptions: string[] = [
    "Нэг хэсэг (tile) = материалын хэмжээ ба машины ажлын талбайн жижиг нь.",
    "Загварыг тэгш өнцөгт хүрээгээр (bounding box) байрлуулсан — нарийн контурын завсрыг ашиглаагүй.",
  ];
  if (kerf > 0) assumptions.push(`kerf ${kerf} см-ийг хэрэглэгчийн утгаар загвар бүрийн хэмжээнд нэмсэн (материал/зузаанд тохирох эсэх баталгаажаагүй).`);
  if (machine.kind === "LASER" && material.thicknessMm == null) warnings.push("Лазерын зүсэлтэд материалын зузааныг оруулаагүй байна — параметрийг шалгана уу.");

  // Загвар бүрийн хэмжээнд kerf нэмнэ
  const designs: DesignInput[] = input.designs.map((d) => ({ ...d, widthCm: r2(d.widthCm + kerf), heightCm: r2(d.heightCm + kerf) }));

  // Tile хэмжээ
  let tileW: number;
  let tileH: number | undefined;
  let mode: "SHEET" | "ROLL";
  let tilesPerSheet = 1;
  if (material.form === "SHEET") {
    const mw = num(material.widthCm, "Хуудасны өргөн", { allowZero: false });
    const mh = num(material.heightCm, "Хуудасны өндөр", { allowZero: false });
    const workH = num(machine.workHeightCm ?? Number.MAX_SAFE_INTEGER, "Машины ажлын талбайн өндөр", { allowZero: false });
    tileW = Math.min(mw, workW);
    tileH = Math.min(mh, workH);
    tilesPerSheet = Math.max(1, Math.floor(mw / tileW)) * Math.max(1, Math.floor(mh / tileH));
    if (mw > workW || mh > workH) assumptions.push(`Хуудас (${mw}×${mh}) машины ажлын талбайгаас (${workW}×${machine.workHeightCm ?? "∞"}) том тул нэг хуудаснаас ${tilesPerSheet} tile гарна.`);
    mode = "SHEET";
  } else {
    tileW = Math.min(num(material.widthCm, "Рулоны өргөн", { allowZero: false }), workW);
    mode = "ROLL";
    if (material.widthCm > workW) warnings.push("Рулоны өргөн машины ажлын өргөнөөс их — зөвхөн ажлын өргөнийг ашиглана.");
  }

  const nIn: NestingInput = {
    mode,
    sheetWidthCm: tileW,
    sheetHeightCm: tileH,
    marginCm: input.marginCm,
    spacingCm: input.spacingCm,
    allowRotate: input.allowRotate,
    designs,
  };
  let nesting: NestingResult;
  try {
    if (opts.compare !== false) {
      const best = compareVariants(nIn)[0];
      nesting = best ? best.result : nest(nIn);
    } else nesting = nest(nIn);
  } catch (e) {
    if (e instanceof NestingError) throw new CuttingError(e.message);
    throw e;
  }
  const errs = validateLayout({ ...nIn, allowRotate: nesting.allowRotate, strategy: nesting.strategy }, nesting);
  if (errs.length) throw new CuttingError(`Байршуулалтын дотоод шалгалт амжилтгүй: ${errs[0]}`);
  if (nesting.unplaced.length) warnings.push(`${nesting.unplaced.length} ширхэг байрлаагүй (хэт том эсвэл хязгаар хэтэрсэн) — тооцоо зөвхөн байрласан хэсгийн.`);

  const tiles = mode === "SHEET" ? nesting.sheets.length : 1;
  const price = num(material.purchasePrice, "Материалын үнэ");
  let materialUnits: number;
  let purchasedAreaCm2: number;
  let materialPurchased: number;
  let label: "sheet" | "m";
  if (material.form === "SHEET") {
    materialUnits = Math.ceil(tiles / tilesPerSheet);
    purchasedAreaCm2 = materialUnits * material.widthCm * (material.heightCm as number);
    materialPurchased = materialUnits * price;
    label = "sheet";
  } else {
    const rollLenM = num(material.rollLengthM, "Рулоны бүтэн урт (м)", { allowZero: false });
    const usedLenM = (nesting.rollLengthCm ?? 0) / 100;
    materialUnits = r2(usedLenM);
    purchasedAreaCm2 = material.widthCm * usedLenM * 100;
    // Рулоны үнийг уртад харьцуулан хуваарилна (зүссэн урт хэрийн төлбөр)
    materialPurchased = (price / rollLenM) * usedLenM;
    label = "m";
    if (usedLenM > rollLenM) warnings.push(`Шаардагдах урт (${r2(usedLenM)} м) рулоны бүтэн уртаас (${rollLenM} м) их — нэгээс олон рулон хэрэгтэй.`);
  }
  const usedAreaCm2 = nesting.usedAreaCm2;
  const costPerCm2 = purchasedAreaCm2 > 0 ? materialPurchased / purchasedAreaCm2 : 0;
  const materialUsedArea = costPerCm2 * usedAreaCm2;
  const materialWaste = materialPurchased - materialUsedArea;

  const totalPieces = nesting.placedPieces;
  const machineMin = (machine.setupMinutes ?? 0) + (machine.minutesPerPiece ?? 0) * totalPieces;
  const machineCost = ((machine.hourlyRate ?? 0) * machineMin) / 60;
  const labor = ((input.laborPerHour ?? 0) * (input.laborMinutes ?? 0)) / 60;
  const extra = input.extraCost ?? 0;
  const total = materialPurchased + machineCost + labor + extra;
  const perPiece = totalPieces > 0 ? total / totalPieces : 0;
  const markup = input.markupPercent;
  const sellPrice = markup != null ? total * (1 + markup / 100) : null;

  return {
    nesting,
    tiles,
    tilesPerSheet,
    materialUnits,
    materialUnitLabel: label,
    totalPieces,
    usedAreaCm2: r2(usedAreaCm2),
    purchasedAreaCm2: r2(purchasedAreaCm2),
    wasteAreaCm2: r2(purchasedAreaCm2 - usedAreaCm2),
    wastePercent: purchasedAreaCm2 > 0 ? r2(((purchasedAreaCm2 - usedAreaCm2) / purchasedAreaCm2) * 100) : 0,
    costs: {
      materialPurchased: r2(materialPurchased),
      materialUsedArea: r2(materialUsedArea),
      materialWaste: r2(materialWaste),
      machine: r2(machineCost),
      labor: r2(labor),
      extra: r2(extra),
      total: r2(total),
      perPiece: r2(perPiece),
      sellPrice: sellPrice != null ? r2(sellPrice) : null,
      profit: sellPrice != null ? r2(sellPrice - total) : null,
      profitPercent: sellPrice != null && sellPrice > 0 ? r2(((sellPrice - total) / sellPrice) * 100) : null,
    },
    assumptions,
    warnings: [...warnings, ...nesting.warnings],
  };
}
