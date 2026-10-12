// ============================================================================
// STOCK SERVICE — энгийн барааны нөөцийн АТОМИК хасалт/нэмэлт (Product.sellStockQty)
// ----------------------------------------------------------------------------
// Дүрэм: "шалгаад дараа нь хасах" (read-then-write) ХЭЗЭЭ Ч хэрэглэхгүй. Хасалт бүр нэг
// `updateMany({ where: { id, sellStockQty: { gte: qty } }, data: { decrement } })` — нөөц хүрэхгүй бол
// count=0 болж InsufficientStockError шидэгдэнэ → дуудагчийн transaction бүхэлдээ буцна
// (order/payment/movement хоорондоо зөрөхгүй).
// Түрээс (RENTAL) энд ОРОХГҮЙ — хугацаат нөөц rental-availability.service.ts-д.
// ============================================================================

import type { Prisma } from "@prisma/client";
import { StockMovementType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { InsufficientStockError, findShortages, mergeStockLines, type StockLine } from "../lib/stock-guards";

type Db = Prisma.TransactionClient | typeof prisma;

export interface SaleItemLike {
  productId: string;
  quantity: number;
  itemType?: string;
  product?: { name?: string; usesMaterialPricing?: boolean | null } | null;
}

/** Нөөцөөс хасагдах мөрүүд: SALE, материалаар үнэлэгдэхгүй (түрээс/материал тусдаа нөөцтэй). */
export function stockLinesOf(items: SaleItemLike[]): StockLine[] {
  return mergeStockLines(
    items
      .filter((i) => (i.itemType ?? "SALE") === "SALE" && !i.product?.usesMaterialPricing)
      .map((i) => ({ productId: i.productId, quantity: i.quantity }))
  );
}

/** ШИНЭЧЛЭХГҮЙ шалгалт (checkout / нэхэмжлэл үүсгэхээс өмнө). Эцсийн хамгаалалт нь deductSaleStockInTx. */
export async function assertStockAvailable(db: Db, lines: StockLine[]): Promise<void> {
  const merged = mergeStockLines(lines);
  if (merged.length === 0) return;
  const rows = await db.product.findMany({ where: { id: { in: merged.map((l) => l.productId) } }, select: { id: true, name: true, sellStockQty: true } });
  const available: Record<string, number> = {};
  const names: Record<string, string> = {};
  for (const r of rows as any[]) {
    available[r.id] = Number(r.sellStockQty ?? 0);
    names[r.id] = r.name;
  }
  const shortages = findShortages(merged, available, names);
  if (shortages.length) throw new InsufficientStockError(shortages);
}

/** Одоо байгаа захиалгуудын (ба бүлгийн гишүүдийн) SALE мөрүүдийн нөөц хүрэх эсэх. */
export async function assertOrdersStockAvailable(db: Db, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const items = await db.orderItem.findMany({ where: { orderId: { in: orderIds }, itemType: "SALE" as any }, include: { product: true } });
  await assertStockAvailable(db, stockLinesOf(items as any));
}

/**
 * Төлбөр бүрэн орсон мөчид (ЯГ ТЭР transaction дотор) нөөцийг АТОМИК хасч, SALE_OUT хөдөлгөөн бичнэ.
 * Ижил бараа олон мөрөнд байвал нэгтгэж нэг удаа хасна. Нөөц хүрэхгүй бол InsufficientStockError.
 */
export async function deductSaleStockInTx(tx: Prisma.TransactionClient, order: { id: string; orderNumber: string; orderType: string }, items: SaleItemLike[]): Promise<void> {
  const lines = stockLinesOf(items);
  const names: Record<string, string> = {};
  for (const i of items) if (i.product?.name) names[i.productId] = i.product.name;
  for (const l of lines) {
    const r = await tx.product.updateMany({
      where: { id: l.productId, sellStockQty: { gte: l.quantity } },
      data: { sellStockQty: { decrement: l.quantity } },
    });
    if (r.count === 0) {
      const p = await tx.product.findUnique({ where: { id: l.productId }, select: { sellStockQty: true, name: true } });
      throw new InsufficientStockError([{ productId: l.productId, need: l.quantity, have: Number((p as any)?.sellStockQty ?? 0), name: names[l.productId] ?? (p as any)?.name }]);
    }
    await tx.stockMovement.create({
      data: {
        productId: l.productId,
        type: StockMovementType.SALE_OUT,
        quantity: l.quantity,
        referenceOrderId: order.id,
        note: `${order.orderType === "ONLINE" ? "Онлайн" : "Кассын"} захиалга #${order.orderNumber}`,
      },
    });
  }
}

/**
 * Гараар нөөц тохируулах/орлого авах. Сөрөг өөрчлөлт үлдэгдлээс хэтрэхгүй (атомик gte).
 * Нөөц болон StockMovement НЭГ transaction-д.
 */
export async function adjustSaleStock(productId: string, delta: number, type: StockMovementType, meta: { staffId?: string | null; note?: string | null } = {}) {
  if (!Number.isInteger(delta) || delta === 0) throw new Error("quantity нь 0-ээс ялгаатай бүхэл тоо байх ёстой");
  return prisma.$transaction(
    async (tx) => {
      const r = await tx.product.updateMany({
        where: delta < 0 ? { id: productId, sellStockQty: { gte: -delta } } : { id: productId },
        data: { sellStockQty: { increment: delta } },
      });
      if (r.count === 0) {
        const p = await tx.product.findUnique({ where: { id: productId }, select: { sellStockQty: true, name: true } });
        if (!p) throw new Error("PRODUCT_NOT_FOUND");
        throw new InsufficientStockError([{ productId, need: -delta, have: Number((p as any).sellStockQty ?? 0), name: (p as any).name }]);
      }
      const movement = await tx.stockMovement.create({
        data: { productId, type, quantity: delta, staffId: meta.staffId ?? undefined, note: meta.note ?? undefined },
      });
      const updatedProduct = await tx.product.findUnique({ where: { id: productId } });
      return { updatedProduct, movement };
    },
    { timeout: 15000 }
  );
}
