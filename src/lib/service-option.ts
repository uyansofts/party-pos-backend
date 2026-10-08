// ============================================================================
// SERVICE OPTION — Барааны "Нэмэлт үйлчилгээ" (жишээ: "Бөмбөлгөн чимэглэлийг биднээр
// хийлгэх"). НЭГ удаагийн төлбөртэй (түрээсийн хоногоор үржихгүй). Сонговол захиалга
// зөвхөн манай курьерийн хүргэлтээр явж, курьерт "чимэглэлтэй" ажил болж очно.
// ============================================================================

export class ServiceOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceOptionError";
  }
}

export interface ServiceOption {
  serviceEnabled: boolean;
  serviceLabel: string | null;
  serviceFee: number | null;
}

/** Staff-ийн илгээсэн утгыг шалгаж цэвэрлэнэ. Идэвхгүй бол нэр, үнийг null болгоно. */
export function normalizeServiceOption(input: { serviceEnabled?: unknown; serviceLabel?: unknown; serviceFee?: unknown }): ServiceOption {
  if (!input.serviceEnabled) return { serviceEnabled: false, serviceLabel: null, serviceFee: null };

  const label = String(input.serviceLabel ?? "").trim();
  if (!label) throw new ServiceOptionError("Нэмэлт үйлчилгээний нэрийг оруулна уу (жишээ: Бөмбөлгөн чимэглэлийг биднээр хийлгэх)");
  if (label.length > 80) throw new ServiceOptionError("Нэмэлт үйлчилгээний нэр 80 тэмдэгтээс ихгүй байх ёстой");

  const fee = Number(input.serviceFee);
  if (input.serviceFee === undefined || input.serviceFee === null || input.serviceFee === "" || !Number.isFinite(fee) || fee < 0 || fee > 100_000_000) {
    throw new ServiceOptionError("Нэмэлт үйлчилгээний үнэ 0 эсвэл түүнээс их тоо байх ёстой");
  }

  return { serviceEnabled: true, serviceLabel: label, serviceFee: Math.round(fee) };
}
