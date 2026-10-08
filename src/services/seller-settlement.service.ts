// ============================================================================
// SELLER SETTLEMENT SERVICE — Худалдагчид мөнгөө (бараа − комисс) НЭГ МӨСӨН (багцаар) олгох.
// Курьерийн оройн тооцоотой ЯГ ИЖИЛ механизм: захиалга бүрийн дүн (snapshot), нэг transaction, давхар олголтгүй.
// ============================================================================

import { prisma } from "../lib/prisma";
import {
  buildSellerSettlement,
  selectSellerPayable,
  SellerSettlementError,
  DEFAULT_PAYOUT_HOLD_DAYS,
  SellerSettlementRow,
  SellerSettlement,
} from "../lib/seller-settlement";

const PAYOUT_METHODS = ["CASH", "BANK_TRANSFER"];

// Олгох боломжтой байж болох захиалгууд (эцсийн дүрмийг lib/seller-settlement.ts тодорхойлно)
const candidateWhere = {
  sellerId: { not: null },
  sellerStatus: "READY" as any,
  deliveryAssignStatus: "DELIVERED" as any,
  sellerPayoutId: null,
  cancelledAt: null,
};

const toRow = (o: any): SellerSettlementRow => ({
  id: o.id,
  orderNumber: o.orderNumber,
  sellerStatus: o.sellerStatus ?? null,
  paymentStatus: o.paymentStatus,
  deliveryAssignStatus: o.deliveryAssignStatus,
  totalAmount: Number(o.totalAmount),
  deliveryFee: Number(o.deliveryFee ?? 0),
  urgentFee: Number(o.urgentFee ?? 0),
  commissionAmount: Number(o.commissionAmount ?? 0),
  deliveredAt: o.deliveredAt ?? null,
  cancelledAt: o.cancelledAt ?? null,
  refundedAt: o.refundedAt ?? null,
  sellerPayoutId: o.sellerPayoutId ?? null,
});

async function holdDays(): Promise<number> {
  const s = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const v = Number((s as any)?.sellerPayoutHoldDays);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PAYOUT_HOLD_DAYS;
}

export async function getSellerSettlementTotals(nowMs: number = Date.now()): Promise<Map<string, SellerSettlement>> {
  const days = await holdDays();
  const orders = await prisma.order.findMany({ where: candidateWhere as any, orderBy: { createdAt: "asc" } });
  const bySeller = new Map<string, any[]>();
  for (const o of orders as any[]) {
    if (!o.sellerId) continue;
    bySeller.set(o.sellerId, [...(bySeller.get(o.sellerId) ?? []), o]);
  }
  const out = new Map<string, SellerSettlement>();
  for (const [id, rows] of bySeller) out.set(id, buildSellerSettlement(rows.map(toRow), days, nowMs));
  return out;
}

/** Staff-ийн жагсаалт: олгох/хүлээлтэд байгаа дүнтэй худалдагч бүр. */
export async function getSellerSettlementSummary(nowMs: number = Date.now()) {
  const totals = await getSellerSettlementTotals(nowMs);
  if (totals.size === 0) return [];
  const sellers = await prisma.seller.findMany({ where: { id: { in: Array.from(totals.keys()) } } });
  return sellers
    .map((s: any) => {
      const t = totals.get(s.id)!;
      return {
        sellerId: s.id,
        name: s.name,
        phone: s.phone,
        hasBankInfo: !!s.bankAccountNumber,
        // ✅ ШИНЭ (Staff): банкны жагсаалт хуулахад (нэг дор шилжүүлэхэд) — зөвхөн Staff-ийн endpoint-д
        bankName: s.bankName ?? null,
        bankAccountNumber: s.bankAccountNumber ?? null,
        bankAccountHolder: s.bankAccountHolder ?? null,
        payableCount: t.payableCount,
        payableTotal: t.payableTotal,
        heldCount: t.heldCount,
        heldTotal: t.heldTotal,
      };
    })
    .sort((a, b) => b.payableTotal - a.payableTotal);
}

export async function getSellerUnpaid(sellerId: string, nowMs: number = Date.now()) {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new SellerSettlementError("Худалдагч олдсонгүй", 404);
  const days = await holdDays();
  const orders = await prisma.order.findMany({ where: { ...candidateWhere, sellerId } as any, orderBy: { createdAt: "asc" } });
  return {
    seller: {
      id: seller.id,
      name: seller.name,
      phone: seller.phone,
      commissionPercent: seller.commissionPercent,
      bankName: seller.bankName,
      bankAccountNumber: seller.bankAccountNumber,
      bankAccountHolder: seller.bankAccountHolder,
    },
    holdDays: days,
    ...buildSellerSettlement((orders as any[]).map(toRow), days, nowMs),
  };
}

/**
 * Сонгосон захиалгуудын мөнгийг НЭГ багцаар олгосон гэж бүртгэнэ. Бүгд нэг transaction-д: ямар нэг захиалга
 * аль хэдийн олгогдсон бол (хоёр Staff зэрэг дарсан г.м.) ӨӨР юу ч бүртгэгдэхгүй.
 */
export async function paySellerBatch(sellerId: string, orderIds: unknown, method: unknown, note?: unknown, nowMs: number = Date.now()) {
  if (typeof method !== "string" || !PAYOUT_METHODS.includes(method)) throw new SellerSettlementError("Төлсөн аргыг бэлнээр эсвэл дансаар гэж сонгоно уу");
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;

  const settlement = await getSellerUnpaid(sellerId, nowMs);
  const selected = selectSellerPayable(settlement, orderIds);
  const total = Math.round(selected.reduce((s, i) => s + i.net, 0) * 100) / 100;

  return prisma.$transaction(async (tx) => {
    const batch = await tx.sellerPayout.create({ data: { sellerId, totalAmount: total, orderCount: selected.length, method: method as any, note: cleanNote } });
    for (const item of selected) {
      const r = await tx.order.updateMany({
        where: { id: item.orderId, sellerId, sellerPayoutId: null },
        data: { sellerPayoutId: batch.id, sellerPayoutAmount: item.net },
      });
      if (r.count === 0) throw new SellerSettlementError(`#${item.orderNumber} аль хэдийн олгогдсон байна — жагсаалтаа шинэчлээд дахин оролдоно уу`, 409);
    }
    return { id: batch.id, totalAmount: total, orderCount: selected.length, method, note: cleanNote };
  });
}

/**
 * ✅ ШИНЭ: БҮХ худалдагчид ОЛГОХ БОЛОМЖТОЙ (хүлээлтийн хугацаа дууссан) мөнгийг нэг дор олгосон гэж бүртгэнэ (курьерийн оройн тооцоо шиг).
 * Худалдагч бүр өөрийн атомик багц (paySellerBatch): нэгний алдаа бусдыг тасалдуулахгүй. Дахин дарвал аль хэдийн олгогдсон тул юу ч давхар бүртгэгдэхгүй.
 * Дансаар олгохдоо банкны мэдээлэлгүй худалдагчийг АЛГАСНА (шилжүүлэх газаргүй мөнгийг "олгосон" гэж тэмдэглэхгүй).
 * ⚠️ Энэ нь зөвхөн БҮРТГЭЛ — Staff мөнгийг бодитоор шилжүүлсний дараа дарна.
 */
export async function payAllSellers(method: unknown, note?: unknown, nowMs: number = Date.now()) {
  if (typeof method !== "string" || !PAYOUT_METHODS.includes(method)) throw new SellerSettlementError("Төлсөн аргыг бэлнээр эсвэл дансаар гэж сонгоно уу");
  const paid: Array<{ sellerId: string; name: string; amount: number; orderCount: number; payoutId: string }> = [];
  const skipped: Array<{ sellerId: string; name: string; reason: string }> = [];
  const failed: Array<{ sellerId: string; name: string; reason: string }> = [];
  for (const row of await getSellerSettlementSummary(nowMs)) {
    if (row.payableCount <= 0) continue;
    if (method === "BANK_TRANSFER" && !row.hasBankInfo) {
      skipped.push({ sellerId: row.sellerId, name: row.name, reason: "Банкны мэдээлэл байхгүй" });
      continue;
    }
    try {
      const unpaid = await getSellerUnpaid(row.sellerId, nowMs);
      const ids = unpaid.items.filter((i) => i.released).map((i) => i.orderId);
      if (ids.length === 0) continue;
      const r = await paySellerBatch(row.sellerId, ids, method, note, nowMs);
      paid.push({ sellerId: row.sellerId, name: row.name, amount: r.totalAmount, orderCount: r.orderCount, payoutId: r.id });
    } catch (err: any) {
      failed.push({ sellerId: row.sellerId, name: row.name, reason: err instanceof SellerSettlementError ? err.message : "Бүртгэж чадсангүй" });
      if (!(err instanceof SellerSettlementError)) console.error(`Худалдагч (${row.sellerId}) нэг дор олгоход алдаа гарлаа:`, err);
    }
  }
  const total = Math.round(paid.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
  return { paid, skipped, failed, total };
}

export async function getSellerPayoutHistory(sellerId: string, limit = 20) {
  const rows = await prisma.sellerPayout.findMany({ where: { sellerId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r: any) => ({ id: r.id, totalAmount: Number(r.totalAmount), orderCount: r.orderCount, method: r.method, note: r.note, createdAt: r.createdAt }));
}

/** Худалдагчийн портал: олгогдох, хүлээлтэд байгаа, өмнө олгосон мөнгө (бусдын мэдээлэл, дотоод талбар ГАРАХГҮЙ). */
export async function getSellerEarnings(sellerId: string, nowMs: number = Date.now()) {
  const s = await getSellerUnpaid(sellerId, nowMs);
  return {
    holdDays: s.holdDays,
    payable: { count: s.payableCount, total: s.payableTotal },
    held: {
      count: s.heldCount,
      total: s.heldTotal,
      items: s.items.filter((i) => !i.released).map((i) => ({ orderNumber: i.orderNumber, net: i.net, releaseAt: i.releaseAt })),
    },
    history: await getSellerPayoutHistory(sellerId, 20),
  };
}
