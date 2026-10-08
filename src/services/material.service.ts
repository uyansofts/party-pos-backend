// ============================================================================
// MATERIAL SERVICE — Материалын үнэ (талбайгаар), нөөц (см²), sheet-ийн өгөгдөл.
// ----------------------------------------------------------------------------
// Үнэлгээний дүрэм (нэг л газарт — backend дээр; клиентэд өртөг ХАРАГДАХГҮЙ):
//   1) Талбай = өргөн × өндөр (см), дээш бүхэлчилнэ.
//   2) м²-ийн үнэтэй материалд:
//        талбай ≥ босго (анхдагч 1 м²)  → өртөг = costPerM2 × талбай / 10,000
//        талбай <  босго                → өртөг = min(costPerCm2 × талбай, босгын үнэ)
//      (жижиг зүсэлтийн үнэ хэзээ ч 1 м²-ийн үнээс хэтрэхгүй → том хэмжээ жижгээс
//       хямд болох "цохилт" үүсэхгүй)
//   3) Борлуулах үнэ = өртөг × (1 + нэмэх хувь/100), бүхэл ₮-д бөөрөнхийлнө.
// ============================================================================

import { MaterialMovementType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export const CM2_PER_M2 = 10_000;
export const MAX_DIMENSION_CM = 300;
export const DEFAULT_MARKUP_PERCENT = 100;

export class MaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialError";
  }
}

/** prisma БОЛОН транзакцийн клиент хоёулаа тохирно. */
export type MaterialDb = Pick<Prisma.TransactionClient, "material" | "shopSettings" | "materialMovement">;

export interface MaterialPricingFields {
  costPerCm2: Prisma.Decimal | number;
  costPerM2: Prisma.Decimal | number | null;
  bulkThresholdCm2: number;
  markupPercent: Prisma.Decimal | number | null;
}

export interface MaterialQuote {
  areaCm2: number;
  cost: number; // өртөг (₮)
  price: number; // борлуулах үнэ (₮)
  tier: "CM2" | "M2";
  markupPercent: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeMaterialQuote(material: MaterialPricingFields, areaCm2: number, shopMarkupPercent: number): MaterialQuote {
  const costPerCm2 = Number(material.costPerCm2);
  const costPerM2 = material.costPerM2 != null ? Number(material.costPerM2) : null;
  const threshold = material.bulkThresholdCm2 > 0 ? material.bulkThresholdCm2 : CM2_PER_M2;

  let cost: number;
  let tier: "CM2" | "M2" = "CM2";
  if (costPerM2 != null && areaCm2 >= threshold) {
    cost = (costPerM2 * areaCm2) / CM2_PER_M2;
    tier = "M2";
  } else if (costPerM2 != null) {
    cost = Math.min(costPerCm2 * areaCm2, (costPerM2 * threshold) / CM2_PER_M2);
  } else {
    cost = costPerCm2 * areaCm2;
  }

  const markup = material.markupPercent != null ? Number(material.markupPercent) : shopMarkupPercent;
  return { areaCm2, cost: round2(cost), price: Math.round(cost * (1 + markup / 100)), tier, markupPercent: markup };
}

/** Өргөн/өндрийг шалгаж, 1 орны нарийвчлалтай бөөрөнхийлж, талбайг (см²) тооцно. */
export function normalizeDimensions(widthCm: unknown, heightCm: unknown) {
  const w = Number(widthCm);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new MaterialError("Өргөн, өндрийг (см) зөв оруулна уу");
  }
  if (w > MAX_DIMENSION_CM || h > MAX_DIMENSION_CM) {
    throw new MaterialError(`Хэмжээ ${MAX_DIMENSION_CM} см-ээс ихгүй байх ёстой`);
  }
  // ⚠️ Хөвөх таслалтай үржвэр (жишээ нь 1.1 × 50) талбайг 1 см²-аар давуулдаг тул
  // хэмжээг 0.1 см-ийн бүхэл тоогоор (аравны нэгээр) авч, бүхэл тоогоор үржүүлнэ.
  const widthTenths = Math.round(w * 10);
  const heightTenths = Math.round(h * 10);
  if (widthTenths <= 0 || heightTenths <= 0) {
    throw new MaterialError("Хэмжээ хамгийн багадаа 0.1 см байх ёстой");
  }
  return {
    widthCm: widthTenths / 10,
    heightCm: heightTenths / 10,
    areaCm2: Math.ceil((widthTenths * heightTenths) / 100),
  };
}

/** Хэмжээ хавтангийн (хоёр талын аль ч чиглэлээр) хэмжээнд багтах эсэх. */
export function assertFitsSheet(material: { sheetWidthCm: number | null; sheetHeightCm: number | null }, widthCm: number, heightCm: number) {
  if (!material.sheetWidthCm || !material.sheetHeightCm) return;
  const sheetLong = Math.max(material.sheetWidthCm, material.sheetHeightCm);
  const sheetShort = Math.min(material.sheetWidthCm, material.sheetHeightCm);
  const long = Math.max(widthCm, heightCm);
  const short = Math.min(widthCm, heightCm);
  if (long > sheetLong || short > sheetShort) {
    throw new MaterialError(`Хэмжээ хавтангийн (${material.sheetWidthCm}×${material.sheetHeightCm} см) хэмжээнээс хэтэрсэн байна`);
  }
}

/** Сонгосон материал + хэмжээнд үнэ тооцно (checkout болон урьдчилсан үнэ хоёул ЭНЭ функцийг ашиглана). */
export async function quoteMaterial(materialId: unknown, widthCm: unknown, heightCm: unknown, db: MaterialDb = prisma) {
  if (typeof materialId !== "string" || materialId === "") {
    throw new MaterialError("Материалаа сонгоно уу");
  }
  const material = await db.material.findUnique({ where: { id: materialId } });
  if (!material || !material.isActive) {
    throw new MaterialError("Сонгосон материал олдсонгүй эсвэл идэвхгүй байна");
  }
  const dims = normalizeDimensions(widthCm, heightCm);
  assertFitsSheet(material, dims.widthCm, dims.heightCm);

  const settings = await db.shopSettings.findUnique({ where: { id: "default" } });
  const quote = computeMaterialQuote(material, dims.areaCm2, settings?.materialMarkupPercent ?? DEFAULT_MARKUP_PERCENT);
  return { material, ...dims, quote };
}

// ----------------------------------------------------------------------------
// Нөөц (см²)
// ----------------------------------------------------------------------------
export async function changeMaterialStock(
  db: MaterialDb,
  materialId: string,
  deltaCm2: number,
  type: MaterialMovementType,
  opts: { referenceOrderId?: string; note?: string } = {}
) {
  const updated = await db.material.update({
    where: { id: materialId },
    data: { stockCm2: { increment: deltaCm2 } },
  });
  await db.materialMovement.create({
    data: {
      materialId,
      type,
      quantityCm2: deltaCm2,
      balanceAfterCm2: updated.stockCm2,
      referenceOrderId: opts.referenceOrderId,
      note: opts.note,
    },
  });
  return updated;
}

export interface LowStockMaterial {
  id: string;
  name: string;
  stockCm2: number;
  minStockCm2: number;
}

/**
 * Бүрэн төлөгдсөн захиалгын материалын нөөцийг хасна (order-payment.service.ts-ийн
 * SALE_OUT-той АДИЛ агшинд, ЯГ ТЭР транзакц дотор). Доод үлдэгдлээс доош орсон
 * материалуудыг буцаана — дуудагч тал транзакц АМЖИЛТТАЙ дууссаны ДАРАА сануулна.
 */
export async function consumeMaterialsForOrder(
  db: MaterialDb,
  order: { id: string; orderNumber: string },
  items: Array<{ materialId: string | null; areaCm2: number | null; quantity: number }>
): Promise<LowStockMaterial[]> {
  const totals = new Map<string, number>();
  for (const it of items) {
    if (!it.materialId || !it.areaCm2) continue;
    totals.set(it.materialId, (totals.get(it.materialId) ?? 0) + it.areaCm2 * it.quantity);
  }

  const lowStock: LowStockMaterial[] = [];
  for (const [materialId, total] of Array.from(totals.entries())) {
    const updated = await changeMaterialStock(db, materialId, -total, MaterialMovementType.ORDER_OUT, {
      referenceOrderId: order.id,
      note: `Тусгай захиалга #${order.orderNumber}`,
    });
    if (updated.stockCm2 < updated.minStockCm2) {
      lowStock.push({ id: updated.id, name: updated.name, stockCm2: updated.stockCm2, minStockCm2: updated.minStockCm2 });
    }
  }
  return lowStock;
}

// ----------------------------------------------------------------------------
// Sheet-ээс авсан анхны материалууд (ҮНЭ = өртөг; см² ба м² мөр нэг материал болсон)
// Анхны нөөц 0 — POS дээр "Нөөц нэмэх"-ээр бодит үлдэгдлээ оруулна.
// Plywood-ийн м²-ийн үнийн босго = 90×90 хавтангийн талбай (8,100 см²): хавтан бүтнээрээ
// м²-ийн үнээр, түүнээс жижиг зүсэлт см²-ийн үнээр (хавтангийн үнээс хэтрэхгүй).
// (Анхдагч босго 10,000 см² нь 90×90 хавтанд хэзээ ч хүрэхгүй тул)
// ----------------------------------------------------------------------------
export const DEFAULT_MATERIALS = [
  { name: "Plywood 3mm", sku: "Pl1001", bulkSku: "Pl1001-1", costPerCm2: 4, costPerM2: 25000, bulkThresholdCm2: 8100, minStockCm2: 27000, sheetWidthCm: 90, sheetHeightCm: 90, note: "Хавтан 90×90 см" },
  { name: "Plywood 5mm", sku: "Pl1002", bulkSku: "Pl1002-1", costPerCm2: 5, costPerM2: 35000, bulkThresholdCm2: 8100, minStockCm2: 81000, sheetWidthCm: 90, sheetHeightCm: 90, note: "Хавтан 90×90 см" },
  { name: "Акрил хавтан 5 мм", sku: "AH1001", bulkSku: null, costPerCm2: 27, costPerM2: null, minStockCm2: 14400, sheetWidthCm: 120, sheetHeightCm: 120, note: "Хавтан 120×120 см. Өртөг: (80+300 мянга) ÷ 14,400 см²" },
  { name: "Акрил хавтан 3 мм", sku: "AH1002", bulkSku: null, costPerCm2: 16, costPerM2: null, minStockCm2: 57600, sheetWidthCm: 120, sheetHeightCm: 120, note: "Хавтан 120×120 см. Өртөг: (80+150 мянга) ÷ 14,400 см²" },
];

/** Аль хэдийн байгаа (SKU-ээр) материалыг дарж бичихгүй — зөвхөн дутууг нэмнэ. */
export async function seedDefaultMaterials(db: MaterialDb = prisma) {
  let created = 0;
  let skipped = 0;
  for (const m of DEFAULT_MATERIALS) {
    const existing = await db.material.findUnique({ where: { sku: m.sku } });
    if (existing) {
      skipped++;
      continue;
    }
    await db.material.create({ data: m });
    created++;
  }
  return { created, skipped };
}
