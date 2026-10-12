// ============================================================================
// REFUND POLICY — төлөгдсөн захиалгын буцаалтын цэвэр (DB-гүй) дүрэм
// ----------------------------------------------------------------------------
// Бизнесийн дүрэм:
//   1) ХАЙЧЛАГДАХ (материалаар үнэлэгдсэн: materialId байгаа) бараа төлөгдсөн бол мөнгийг БУЦААХГҮЙ, материалын нөөц НЭМЭХГҮЙ.
//   2) БУСАД бараа (энгийн SALE, түрээс) буцаагдана; энгийн SALE барааны нөөц сэргэнэ (олгогдсон мөрөөс бусад).
//   3) Холимог захиалга: ЗӨВХӨН хайчлагдах бус мөрүүдийн subtotal буцаагдана. Хүргэлт/яаралтай нэмэгдэл БУЦААГДАХГҮЙ.
//      Захиалга PAID хэвээр үлдэнэ (хайчлагдах барааны мөнгө хэвээр). Буцаасан мөр бүр `refundedAt`-аар тэмдэглэгдэнэ.
//   4) Хайчлагдах бараагүй захиалга: БҮХЭЛД нь буцаана (REFUNDED, төлсөн бүх дүн — одоогийн зан төлөв).
// ⚠️ Нөөц нэмэх нь хасалтын (stock.service stockLinesOf) яг эсрэг: SALE, материалаар үнэлэгдэхгүй.
// ============================================================================

import { toCents } from "./payment-guards";

export interface RefundItem {
  id: string;
  itemType: string;
  subtotal: unknown;
  quantity: number;
  productId: string;
  materialId?: string | null;
  isIssued?: boolean | null;
  refundedAt?: Date | string | null;
  product?: { name?: string | null; usesMaterialPricing?: boolean | null } | null;
}

export interface RestockLine {
  productId: string;
  quantity: number;
}

export type RefundPlan =
  | {
      kind: "full" | "partial";
      refundItemIds: string[];
      restockLines: RestockLine[];
      /** partial: Σ буцаах мөрүүдийн subtotal (₮). full: энд мөрүүдийн нийлбэр; бодит буцаах дүн = төлсөн дүн (дуудагч тооцно). */
      itemsRefundAmount: number;
      /** Хайчлагдах мөрүүдийн нийлбэр — буцаагдахгүй, хэвээр үлдэнэ. */
      keptAmount: number;
      keptItemIds: string[];
    }
  | { kind: "none"; error: string };

/** Хайчлагдах мөр: материалаар үнэлэгдсэн (хуучин мөрөнд materialId байхгүй ч бараа нь материалын үнэлгээтэй бол АЮУЛГҮЙ талаар хайчлагдах гэж үзнэ). */
export function isCutItem(i: RefundItem): boolean {
  return !!i.materialId || !!i.product?.usesMaterialPricing;
}

const sumCents = (items: RefundItem[]) => items.reduce((s, i) => s + toCents(Number(i.subtotal)), 0);

export function planOrderRefund(items: RefundItem[]): RefundPlan {
  const cut = items.filter(isCutItem);
  const open = items.filter((i) => !isCutItem(i) && !i.refundedAt);

  if (open.length === 0) {
    return {
      kind: "none",
      error: cut.length > 0
        ? "Буцаах боломжтой мөр алга: хайчлагдах барааны мөнгийг буцаахгүй (үлдсэн мөрүүд аль хэдийн буцаагдсан эсвэл зөвхөн хайчлагдах бараатай)"
        : "Буцаах боломжтой мөр алга: бүх мөр аль хэдийн буцаагдсан байна",
    };
  }

  // Ижил барааны мөрүүдийг нэгтгэнэ, productId-аар эрэмбэлнэ (зэрэгцээ transaction-ууд ижил дарааллаар түгжинэ → deadlock-гүй)
  const byProduct = new Map<string, number>();
  for (const i of open) {
    if (i.itemType === "SALE" && !i.isIssued) byProduct.set(i.productId, (byProduct.get(i.productId) ?? 0) + i.quantity);
  }
  const restockLines = Array.from(byProduct.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, quantity]) => ({ productId, quantity }));

  return {
    kind: cut.length === 0 ? "full" : "partial",
    refundItemIds: open.map((i) => i.id),
    restockLines,
    itemsRefundAmount: sumCents(open) / 100,
    keptAmount: sumCents(cut) / 100,
    keptItemIds: cut.map((i) => i.id),
  };
}
