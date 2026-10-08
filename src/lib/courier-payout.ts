// ============================================================================
// COURIER PAYOUT — Курьерт очих ЦЭВЭР дүнг (дэлгүүрийн хувийг хассан) нэг л газарт
// тооцно. Өмнө нь хоёр газар (offer, курьерийн жагсаалт) тусдаа тооцдог байсан.
// ----------------------------------------------------------------------------
//   Хүргэлтийн төлбөр   × (1 − хүргэлтийн хувь/100)
//   Чимэглэлийн ажил    × (1 − чимэглэлийн хувь/100)
// Чимэглэлийн хувь тохируулаагүй (null) бол хүргэлтийн хувьтай АДИЛ.
// Хоёр хэсгийг тус тусад нь бүхэлд бөөрөнхийлдөг тул нийлбэр яг таарна.
// ============================================================================

export interface CourierPayoutBreakdown {
  deliveryGross: number; // Харилцагчаас авсан хүргэлтийн төлбөр
  serviceGross: number; // Харилцагчаас авсан чимэглэлийн төлбөр
  deliveryPayout: number; // Курьерт очих хүргэлтийн хэсэг
  servicePayout: number; // Курьерт очих чимэглэлийн хэсэг
  totalPayout: number; // Нийт (курьерт харагдах, банкаар шилжүүлэх дүн)
  deliveryCommissionPercent: number;
  serviceCommissionPercent: number;
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

export function computeCourierPayout(
  amounts: { deliveryFee: number; serviceAmount: number },
  deliveryCommissionPercent: number,
  serviceCommissionPercent?: number | null
): CourierPayoutBreakdown {
  const deliveryPercent = clampPercent(deliveryCommissionPercent);
  const servicePercent = serviceCommissionPercent == null ? deliveryPercent : clampPercent(serviceCommissionPercent);

  const deliveryGross = Number.isFinite(amounts.deliveryFee) ? amounts.deliveryFee : 0;
  const serviceGross = Number.isFinite(amounts.serviceAmount) ? amounts.serviceAmount : 0;

  const deliveryPayout = Math.round(deliveryGross * (1 - deliveryPercent / 100));
  const servicePayout = Math.round(serviceGross * (1 - servicePercent / 100));

  return {
    deliveryGross,
    serviceGross,
    deliveryPayout,
    servicePayout,
    totalPayout: deliveryPayout + servicePayout,
    deliveryCommissionPercent: deliveryPercent,
    serviceCommissionPercent: servicePercent,
  };
}
