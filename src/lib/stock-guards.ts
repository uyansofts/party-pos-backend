// ============================================================================
// STOCK GUARDS — энгийн (SALE) барааны нөөцийн цэвэр (DB-гүй) дүрмүүд
// ----------------------------------------------------------------------------
// ⚠️ Зөвхөн БОРЛУУЛАЛТЫН нөөц (Product.sellStockQty). Түрээсийн нөөц хугацаагаар
// (rental-availability.service.ts) тооцогддог — энд ОРОХГҮЙ. Материалын нөөц (см²) ч тусдаа.
// ============================================================================

import { planBundleOrder, type BundleOrderLine, type BundleComponent } from "./bundle";

export interface StockLine {
  productId: string;
  quantity: number;
}

export interface Shortage {
  productId: string;
  need: number;
  have: number;
  name?: string;
  /** Нэгж (жишээ: "см²" — материалын нөөц). Заагаагүй бол тоо ширхэг. */
  unit?: string;
}

export class InvalidStockQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStockQuantityError";
  }
}

export class InsufficientStockError extends Error {
  readonly shortages: Shortage[];
  readonly status = 409;
  constructor(shortages: Shortage[]) {
    super(shortageMessage(shortages));
    this.name = "InsufficientStockError";
    this.shortages = shortages;
  }
}

export function shortageMessage(s: Shortage[]): string {
  return (
    "Нөөц хүрэлцэхгүй: " +
    s
      .map((x) => {
        const u = x.unit ? ` ${x.unit}` : "";
        return `${x.name ?? x.productId} (хэрэгтэй ${x.need}${u}, үлдэгдэл ${Math.max(0, x.have)}${u})`;
      })
      .join(", ")
  );
}

/**
 * Ижил бараатай мөрүүдийг НЭГТГЭЖ (нийлбэр) productId-аар эрэмбэлнэ.
 * Эрэмбэ чухал: зэрэгцээ transaction-ууд мөрүүдийг ИЖИЛ дарааллаар түгжвэл deadlock үүсэхгүй.
 */
export function mergeStockLines(lines: StockLine[]): StockLine[] {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l.productId) throw new InvalidStockQuantityError("productId шаардлагатай");
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new InvalidStockQuantityError(`Бараа ${l.productId}: тоо бүхэл ≥ 1 байх ёстой`);
    m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([productId, quantity]) => ({ productId, quantity }));
}

/** Нэгтгэсэн шаардлагыг боломжит нөөцтэй харьцуулна (сөрөг/NaN нөөц = 0). */
export function findShortages(required: StockLine[], available: Record<string, number>, names: Record<string, string> = {}): Shortage[] {
  const out: Shortage[] = [];
  for (const r of required) {
    const have = Number.isFinite(Number(available[r.productId])) ? Number(available[r.productId]) : 0;
    if (r.quantity > have) out.push({ productId: r.productId, need: r.quantity, have, name: names[r.productId] });
  }
  return out;
}

/** Багц + дан барааны мөрүүдийг НЭГ нэгтгэсэн нөөцийн шаардлага болгоно (бүрэлдэхүүн давхцвал нийлбэрлэнэ). */
export function bundleOrderToStockLines(lines: BundleOrderLine[], singles: BundleComponent[] = []): StockLine[] {
  const plan = planBundleOrder(lines, {}, singles);
  return mergeStockLines(Object.entries(plan.deductions).map(([productId, quantity]) => ({ productId, quantity: quantity as number })));
}
