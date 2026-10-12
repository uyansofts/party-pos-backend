// ============================================================================
// UNITS — хэмжих нэгжийн хөрвүүлэлт (цэвэр функц, DB-гүй)
// ----------------------------------------------------------------------------
// 1 м = 100 см, 1 м² = 10,000 см². Нэгж тодорхойгүй/дэмжигдээгүй бол ТААМАГЛАЖ хөрвүүлэхгүй — алдаа шиднэ.
// Хөрвүүлэлтийг 1/100 см-ийн бүхэл тоогоор (units) хийж, хөвөх таслалын алдаанаас сэргийлнэ.
// ============================================================================

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

export type LengthUnit = "mm" | "cm" | "m";
const CM_PER: Record<LengthUnit, number> = { mm: 0.1, cm: 1, m: 100 };

export const CM2_PER_M2 = 10_000;

export function toCm(value: number, unit: unknown): number {
  if (typeof unit !== "string" || !(unit in CM_PER)) throw new UnitError(`Урт хэмжээсийн нэгж танигдсангүй: "${String(unit)}" (mm, cm, m)`);
  if (!Number.isFinite(value)) throw new UnitError("Хэмжээ тоо байх ёстой");
  return Math.round(value * CM_PER[unit as LengthUnit] * 1e6) / 1e6;
}

export const areaCm2 = (widthCm: number, heightCm: number) => Math.round(widthCm * heightCm * 1e6) / 1e6;
export const m2ToCm2 = (m2: number) => m2 * CM2_PER_M2;
export const cm2ToM2 = (cm2: number) => cm2 / CM2_PER_M2;

/** Рулоны талбай (см²): өргөн (см) × урт (м). */
export function rollAreaCm2(widthCm: number, lengthM: number): number {
  if (!(widthCm > 0) || !(lengthM > 0)) throw new UnitError("Рулоны өргөн, урт эерэг байх ёстой");
  return areaCm2(widthCm, lengthM * 100);
}

/** Худалдан авсан үнийг см²-ийн өртөг болгоно (нийт талбай дээр). */
export function costPerCm2(price: number, totalAreaCm2: number): number {
  if (!(price >= 0) || !(totalAreaCm2 > 0)) throw new UnitError("Үнэ ≥ 0, талбай > 0 байх ёстой");
  return price / totalAreaCm2;
}

/** Margin-ийг хассан АШИГЛАХ боломжтой талбай. */
export function usableAreaCm2(widthCm: number, heightCm: number, marginCm: number): number {
  const w = widthCm - 2 * marginCm;
  const h = heightCm - 2 * marginCm;
  return w > 0 && h > 0 ? areaCm2(w, h) : 0;
}
