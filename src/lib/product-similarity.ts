// ============================================================================
// PRODUCT SIMILARITY — "Төстэй бараа" санал болгох оноо (цэвэр логик).
//   Ижил ангилал, ойролцоо ангилал, ижил худалдагч, ижил төрөл (түрээс/борлуулах), ойролцоо үнэ, өнгө/хэмжээ, үнэлгээ.
// ============================================================================

export interface SimProduct {
  id: string;
  name: string;
  categoryId: string | null;
  sellerId: string | null;
  isRental: boolean;
  sellPrice: number;
  rentalPricePerDay: number;
  color: string | null;
  size: string | null;
  inStock: boolean;
  ratingAvg?: number | null;
  ratingCount?: number;
}

const priceOf = (p: SimProduct) => (p.isRental ? p.rentalPricePerDay : p.sellPrice) || 0;
export const groupKey = (p: Pick<SimProduct, "sellerId" | "name">) => `${p.sellerId ?? ""}::${p.name}`;

export function similarityScore(base: SimProduct, c: SimProduct, parentOf: Map<string, string | null>): number {
  let score = 0;
  if (base.categoryId && c.categoryId) {
    if (base.categoryId === c.categoryId) score += 4;
    else if (parentOf.get(base.categoryId) && parentOf.get(base.categoryId) === parentOf.get(c.categoryId)) score += 2; // ах дүү ангилал
    else if (parentOf.get(c.categoryId) === base.categoryId || parentOf.get(base.categoryId) === c.categoryId) score += 2.5; // эцэг/хүүхэд
  }
  if (base.sellerId && base.sellerId === c.sellerId) score += 1;
  score += base.isRental === c.isRental ? 1 : -1;
  const pa = priceOf(base);
  const pb = priceOf(c);
  if (pa > 0 && pb > 0) {
    const ratio = Math.max(pa, pb) / Math.min(pa, pb);
    score += Math.max(0, Math.min(1, 1 - Math.log(ratio) / Math.log(4))) * 2; // 4 дахин ялгаатай бол 0
  }
  if (base.color && c.color && base.color.toLowerCase() === c.color.toLowerCase()) score += 0.5;
  if (base.size && c.size && base.size.toLowerCase() === c.size.toLowerCase()) score += 0.3;
  if ((c.ratingCount ?? 0) >= 2 && (c.ratingAvg ?? 0) >= 4) score += 0.5;
  return score;
}

/**
 * Хамгийн төстэй N бараа: өөрөө болон ИЖИЛ БҮЛГИЙН (худалдагч + нэр) хувилбар орохгүй, дууссан орохгүй,
 * бүлэг бүрээс ХАМГИЙН ОНОО ӨНДӨР ГАНЦ хувилбар. Оноо MIN_SCORE-оос бага бол санал болгохгүй (хамааралгүй бараа биш).
 */
export const MIN_SIMILAR_SCORE = 2;

export function rankSimilar(base: SimProduct, candidates: SimProduct[], parentOf: Map<string, string | null>, limit = 8): SimProduct[] {
  const baseKey = groupKey(base);
  const best = new Map<string, { p: SimProduct; score: number; i: number }>();
  candidates.forEach((c, i) => {
    if (c.id === base.id || !c.inStock || groupKey(c) === baseKey) return;
    const score = similarityScore(base, c, parentOf);
    if (score < MIN_SIMILAR_SCORE) return;
    const k = groupKey(c);
    const cur = best.get(k);
    if (!cur || score > cur.score) best.set(k, { p: c, score, i });
  });
  return [...best.values()].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, Math.max(0, limit)).map((x) => x.p);
}
