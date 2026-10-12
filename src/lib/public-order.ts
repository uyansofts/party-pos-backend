// ============================================================================
// PUBLIC ORDER VIEW — GET /api/public/orders/:id-ийн хариуг ЦагаАН ЖАГСААЛТААР (whitelist) бүтээнэ.
// Өмнө нь Order мөрийг бүхлээр нь буцааж, хүргэлт/буцаалтын OTP, комисс, курьер/худалдагчийн олголт,
// ажилтны id зэргийг ил гаргадаг байсан (захиалгын ID-г мэддэг курьер OTP-г уншиж чадах эрсдэлтэй).
// Шинэ талбар Order-т нэмэгдсэн ч АВТОМАТААР ил гарахгүй.
// ============================================================================

const pick = (o: any, keys: string[]) => {
  const out: Record<string, unknown> = {};
  if (!o) return out;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

export function toPublicOrderView(order: any) {
  return {
    ...pick(order, [
      "id", "orderNumber", "orderType", "paymentStatus", "totalAmount", "paidAmount",
      "deliveryMethod", "deliveryAddress", "deliveryFee", "serviceAmount", "neededByDate", "isUrgent", "urgentFee",
      "deliveryAssignStatus", "cancelledAt", "createdAt",
    ]),
    items: Array.isArray(order?.items)
      ? order.items.map((it: any) => ({
          ...pick(it, ["id", "itemType", "quantity", "unitPrice", "subtotal", "customizationText", "selectedVariations"]),
          product: it.product ? pick(it.product, ["name", "imageUrl", "color", "size"]) : undefined,
          rentalDetail: it.rentalDetail
            ? pick(it.rentalDetail, ["id", "startDate", "endDate", "rentalDays", "dailyRate", "rentalStatus", "depositAmount", "depositStatus", "depositType"])
            : undefined,
        }))
      : [],
  };
}
