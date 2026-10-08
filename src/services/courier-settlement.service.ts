import { prisma } from "../lib/prisma";
import { courierStaffLabel } from "../lib/courier-identity";
import { buildSettlement, selectPayable, SettlementError, SettlementOrderRow } from "../lib/courier-settlement";

const PAYOUT_METHODS = ["CASH", "BANK_TRANSFER"];

const eligibleWhere = {
  courierFeePaid: false,
  OR: [{ deliveryAssignStatus: "DELIVERED" as any }, { deliveryAssignStatus: "CANCELLED" as any, cancellationFee: { gt: 0 } }],
};

const toRow = (o: any): SettlementOrderRow => ({
  id: o.id,
  orderNumber: o.orderNumber,
  orderType: o.orderType,
  deliveryAssignStatus: o.deliveryAssignStatus,
  paymentStatus: o.paymentStatus,
  deliveryFee: Number(o.deliveryFee),
  serviceAmount: Number(o.serviceAmount ?? 0),
  cancellationFee: Number(o.cancellationFee ?? 0),
  courierFeePaid: !!o.courierFeePaid,
  deliveryAddress: o.deliveryAddress ?? null,
  deliveredAt: o.deliveredAt ?? null,
  cancelledAt: o.cancelledAt ?? null,
});

async function commissions() {
  const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  return { commission: settings?.courierCommissionPercent ?? 15, service: settings?.serviceCommissionPercent ?? null };
}

/** Курьер бүрийн төлөгдөөгүй хөлсний тооцоо (захиалгын жагсаалттай нь). Жагсаалтад курьер бүрийн "тооцоотой эсэх"-ийг харуулахад ашиглана. */
export async function getSettlementTotals() {
  const { commission, service } = await commissions();
  const orders = await prisma.order.findMany({ where: { courierId: { not: null }, ...eligibleWhere }, orderBy: { createdAt: "asc" } });
  const byCourier = new Map<string, any[]>();
  for (const o of orders) {
    if (!o.courierId) continue;
    byCourier.set(o.courierId, [...(byCourier.get(o.courierId) ?? []), o]);
  }
  const totals = new Map<string, ReturnType<typeof buildSettlement>>();
  for (const [id, rows] of byCourier) totals.set(id, buildSettlement(rows.map(toRow), commission, service));
  return totals;
}

/** Оройн тооцоо: төлөгдөөгүй хөлстэй курьер бүрийн нийлбэр. */
export async function getSettlementSummary() {
  const totals = await getSettlementTotals();
  if (totals.size === 0) return [];
  const couriers = await prisma.courier.findMany({ where: { id: { in: Array.from(totals.keys()) } } });
  return couriers
    .map((c) => {
      const s = totals.get(c.id)!;
      return {
        courierId: c.id,
        label: courierStaffLabel(c),
        phone: c.phone,
        hasBankInfo: !!(c.bankAccountNumber || c.bankIban),
        payableCount: s.payableCount,
        payableTotal: s.payableTotal,
        blockedCount: s.blockedCount,
        blockedTotal: s.blockedTotal,
      };
    })
    .sort((a, b) => b.payableTotal - a.payableTotal);
}

/** Нэг курьерийн төлөгдөөгүй захиалгууд + шилжүүлэх банкны мэдээлэл. */
export async function getUnpaidSettlement(courierId: string) {
  const courier = await prisma.courier.findUnique({ where: { id: courierId } });
  if (!courier) throw new SettlementError("Курьер олдсонгүй");
  const { commission, service } = await commissions();
  const orders = await prisma.order.findMany({ where: { courierId, ...eligibleWhere }, orderBy: { createdAt: "asc" } });
  return {
    courier: {
      id: courier.id,
      label: courierStaffLabel(courier),
      fullName: `${courier.name} ${courier.lastName ?? ""}`.trim(),
      phone: courier.phone,
      bankName: courier.bankName,
      bankAccountNumber: courier.bankAccountNumber,
      bankIban: courier.bankIban,
    },
    ...buildSettlement(orders.map(toRow), commission, service),
  };
}

/**
 * Сонгосон захиалгуудын хөлсийг НЭГ багцаар төлсөн гэж бүртгэнэ. Бүгд нэг transaction-д:
 * ямар нэг захиалга аль хэдийн төлөгдсөн бол (хоёр Staff зэрэг дарсан г.м.) ӨӨР юу ч бүртгэгдэхгүй.
 */
export async function payCourierBatch(courierId: string, orderIds: unknown, method: unknown, note?: unknown) {
  if (typeof method !== "string" || !PAYOUT_METHODS.includes(method)) throw new SettlementError("Төлсөн аргыг бэлнээр эсвэл дансаар гэж сонгоно уу");
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;

  const settlement = await getUnpaidSettlement(courierId);
  const selected = selectPayable(settlement, orderIds);
  const total = selected.reduce((s, i) => s + i.amount, 0);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const batch = await tx.courierPayout.create({ data: { courierId, totalAmount: total, orderCount: selected.length, method: method as any, note: cleanNote } });
    for (const item of selected) {
      const r = await tx.order.updateMany({
        where: { id: item.orderId, courierId, courierFeePaid: false },
        data: { courierFeePaid: true, courierFeePaidAt: now, courierPayoutId: batch.id, courierPayoutAmount: item.amount },
      });
      if (r.count === 0) throw new SettlementError(`#${item.orderNumber} аль хэдийн төлөгдсөн байна — жагсаалтаа шинэчлээд дахин оролдоно уу`);
    }
    return { id: batch.id, totalAmount: total, orderCount: selected.length, method, note: cleanNote };
  });
}

export async function getPayoutHistory(courierId: string, limit = 20) {
  const rows = await prisma.courierPayout.findMany({ where: { courierId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({ id: r.id, totalAmount: Number(r.totalAmount), orderCount: r.orderCount, method: r.method, note: r.note, createdAt: r.createdAt }));
}
