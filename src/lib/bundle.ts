// ============================================================================
// BUNDLE — багцын боломжит тоо, нөөц хасалтын төлөвлөгөө (цэвэр логик, DB-гүй)
// ----------------------------------------------------------------------------
// Жишээ: 2 шаар (20), 1 малгай (10), 1 лаа (15) → max = min(⌊20/2⌋, ⌊10/1⌋, ⌊15/1⌋) = 10.
// Нөөцийг бүрэлдэхүүн бараа бүрээр хасна: багц × qtyPerBundle. Нэг бараа олон багцад орсон бол зэрэг захиалгын нөөцийг
// planBundleOrder-д нэг л нөөцийн зураглалаар (shared stock) тооцно — давхар тоолохгүй.
// ⚠️ Энэ нь зөвхөн тооцооллын цөм. DB model (Bundle/BundleItem) болон POS/checkout холболт хараахан хийгдээгүй.
// ============================================================================

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export interface BundleComponent {
  productId: string;
  quantity: number; // нэг багцад орох ширхэг (бүхэл ≥ 1)
}

export interface BundleAvailability {
  max: number;
  limitingProductIds: string[];
}

function validateComponents(components: BundleComponent[]) {
  if (!Array.isArray(components) || components.length === 0) throw new BundleError("Багц дор хаяж нэг бүрэлдэхүүнтэй байх ёстой");
  const seen = new Set<string>();
  for (const c of components) {
    if (!c.productId) throw new BundleError("Бүрэлдэхүүн бүрт productId шаардлагатай");
    if (seen.has(c.productId)) throw new BundleError(`Бүрэлдэхүүн давхардсан: ${c.productId}`);
    seen.add(c.productId);
    if (!Number.isInteger(c.quantity) || c.quantity < 1) throw new BundleError(`Бүрэлдэхүүн ${c.productId}: тоо бүхэл ≥ 1 байх ёстой`);
  }
}

/** stock: productId → боломжит нөөц (сөрөг/NaN бол 0). Нөөцийн мэдээлэлгүй бүрэлдэхүүн → 0. */
export function bundleAvailability(components: BundleComponent[], stock: Record<string, number>): BundleAvailability {
  validateComponents(components);
  let max = Infinity;
  let limiting: string[] = [];
  for (const c of components) {
    const s = Number(stock[c.productId]);
    const can = Number.isFinite(s) && s > 0 ? Math.floor(s / c.quantity) : 0;
    if (can < max) {
      max = can;
      limiting = [c.productId];
    } else if (can === max) limiting.push(c.productId);
  }
  return { max: Number.isFinite(max) ? max : 0, limitingProductIds: limiting };
}

export interface BundleOrderLine {
  bundleId: string;
  components: BundleComponent[];
  quantity: number; // захиалсан багцын тоо
}

/**
 * Нэг захиалгын бүх багц (+ дан барааны мөр) хамт нөөцөд хүрэх эсэхийг ШИНЭЧЛЭХГҮЙ шалгаж, хасах ширхгийн төлөвлөгөө гаргана.
 * Нэг бараа хэд хэдэн багцад орсон ч нийт шаардлагыг нийлүүлж нэг нөөцтэй харьцуулна.
 */
export function planBundleOrder(lines: BundleOrderLine[], stock: Record<string, number>, singles: BundleComponent[] = []) {
  const need = new Map<string, number>();
  for (const l of lines) {
    validateComponents(l.components);
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new BundleError(`Багц ${l.bundleId}: тоо бүхэл ≥ 1 байх ёстой`);
    for (const c of l.components) need.set(c.productId, (need.get(c.productId) ?? 0) + c.quantity * l.quantity);
  }
  for (const s of singles) {
    if (!Number.isInteger(s.quantity) || s.quantity < 1) throw new BundleError(`Бараа ${s.productId}: тоо бүхэл ≥ 1 байх ёстой`);
    need.set(s.productId, (need.get(s.productId) ?? 0) + s.quantity);
  }
  const shortages: Array<{ productId: string; need: number; have: number }> = [];
  for (const [productId, n] of need) {
    const have = Number.isFinite(Number(stock[productId])) ? Math.max(0, Number(stock[productId])) : 0;
    if (n > have) shortages.push({ productId, need: n, have });
  }
  return { ok: shortages.length === 0, deductions: Object.fromEntries(need), shortages };
}
