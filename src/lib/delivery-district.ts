// ============================================================================
// DELIVERY DISTRICT — Хүргэлтийн үнийг СЕРВЕР талд ХАТУУ тооцох (цэвэр логик).
//
// Яагаад: өмнө нь харилцагч байршлаа "Гараар" (дүүрэг/хороо) оруулбал координат байхгүй тул үнэ тооцогдохгүй,
// харин сервер клиентийн илгээсэн deliveryFee-г ИТГЭЖ авдаг байсан → хүргэлт ҮНЭГҮЙ болдог (мөн клиент
// сөрөг дүн илгээж нийт үнийг бууруулах боломжтой байсан). Одоо ONLINE захиалгад клиентийн үнийг ХЭЗЭЭ Ч
// итгэхгүй:
//   • координат (GPS/Maps)  → замын бодит зайгаар Бүс А/Б (одоогийн логик)
//   • зөвхөн дүүрэг (гараар) → Тохиргооны "дүүрэг → бүс" хүснэгтээр Бүс А/Б
//   • аль нь ч үгүй           → захиалгыг ТАТГАЛЗАНА
// ============================================================================

export const UB_DISTRICTS = ["Баянгол", "Баянзүрх", "Сонгинохайрхан", "Сүхбаатар", "Хан-Уул", "Чингэлтэй"] as const;
export type Zone = "A" | "B";

/** Анхдагч (Staff Тохиргооноос өөрчилнө): төвийн 3 дүүрэг А, бусад Б. */
export const DEFAULT_DISTRICT_ZONES: Record<string, Zone> = {
  Чингэлтэй: "A",
  Сүхбаатар: "A",
  Баянгол: "A",
  Баянзүрх: "B",
  "Хан-Уул": "B",
  Сонгинохайрхан: "B",
};

/** "баянзүрх", "Баянзүрх дүүрэг", " Хан-Уул " → каноник нэр. Мэдэгдэхгүй бол null. */
export function normalizeDistrict(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/\s*дүүрэг\s*$/u, "").replace(/\s+/g, "");
  for (const d of UB_DISTRICTS) if (d.toLowerCase() === key) return d;
  return null;
}

/** Хадгалсан JSON + анхдагчийг нэгтгэнэ; буруу дүүрэг/бүсийг чимээгүй алгасна. */
export function parseDistrictZones(stored: unknown): Record<string, Zone> {
  const out: Record<string, Zone> = { ...DEFAULT_DISTRICT_ZONES };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      const d = normalizeDistrict(k);
      if (d && (v === "A" || v === "B")) out[d] = v;
    }
  }
  return out;
}

/** Хорооны дугаар: 1..99 бүхэл ("5", 5, "05" зөв). Буруу бол null (дүүргийн анхдагч бүсийг ашиглана). */
export function normalizeKhoroo(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const t = String(raw).trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 99 ? n : null;
}

/** Хорооны давуу бүс: {"Баянзүрх":{"1":"A","5":"A"}}. Буруу дүүрэг/хороо/бүсийг чимээгүй алгасна. */
export function parseKhorooZones(stored: unknown): Record<string, Record<string, Zone>> {
  const out: Record<string, Record<string, Zone>> = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const [dk, dv] of Object.entries(stored as Record<string, unknown>)) {
    const d = normalizeDistrict(dk);
    if (!d || !dv || typeof dv !== "object" || Array.isArray(dv)) continue;
    for (const [kk, kv] of Object.entries(dv as Record<string, unknown>)) {
      const k = normalizeKhoroo(kk);
      if (k !== null && (kv === "A" || kv === "B")) (out[d] ??= {})[String(k)] = kv;
    }
  }
  return out;
}

/** Хорооны давуу бүс байвал түүнийг, үгүй бол дүүргийн анхдагч бүсийг. */
export function zoneFor(district: string, khoroo: number | null, districtZones: Record<string, Zone>, khorooZones: Record<string, Record<string, Zone>>): Zone {
  if (khoroo !== null) {
    const override = khorooZones[district]?.[String(khoroo)];
    if (override) return override;
  }
  return districtZones[district];
}

export interface ZoneFees {
  saleZoneAFee: number;
  saleZoneBFee: number;
  rentalZoneAFee: number;
  rentalZoneBFee: number;
}

export function districtFee(
  district: unknown,
  storedZones: unknown,
  fees: ZoneFees,
  hasRental: boolean,
  khoroo?: unknown,
  storedKhorooZones?: unknown
): { ok: boolean; zone?: Zone; fee?: number; district?: string; khoroo?: number | null; error?: string } {
  const d = normalizeDistrict(district);
  if (!d) return { ok: false, error: "Дүүрэг танигдсангүй — жагсаалтаас сонгоно уу (алслагдсан дүүрэгт орон нутгийн хүргэлтийг сонгоно)" };
  const k = normalizeKhoroo(khoroo);
  const zone = zoneFor(d, k, parseDistrictZones(storedZones), parseKhorooZones(storedKhorooZones));
  const fee = hasRental ? (zone === "A" ? fees.rentalZoneAFee : fees.rentalZoneBFee) : zone === "A" ? fees.saleZoneAFee : fees.saleZoneBFee;
  return { ok: true, zone, fee: Number(fee), district: d, khoroo: k };
}

export class DeliveryFeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryFeeError";
  }
}

export type FeeSource = "AUTO" | "DISTRICT" | "LOCAL" | "CLIENT" | "NONE";

export interface DeliveryFeeInput {
  orderType: string; // "ONLINE" (харилцагч) эсвэл "POS" (Staff — итгэмжит)
  method: string;
  clientFee: unknown;
  lat?: number | null;
  lng?: number | null;
  district?: unknown;
  khoroo?: unknown; // Хорооны дугаар — дүүргийн бүсийг хороогоор нарийвчилна (заавал биш)
  hasRental: boolean;
  settings: (ZoneFees & { localTransportFee: number; districtZones: unknown; khorooZones?: unknown }) | null;
  autoFee: () => Promise<{ fee: number } | null>; // координатаар (замын зай) тооцох
}

export async function resolveDeliveryFee(i: DeliveryFeeInput): Promise<{ fee: number; source: FeeSource }> {
  const raw = i.clientFee === null || i.clientFee === undefined ? 0 : Number(i.clientFee);
  if (!Number.isFinite(raw) || raw < 0 || raw > 10_000_000) throw new DeliveryFeeError("Хүргэлтийн төлбөр буруу байна");
  const online = i.orderType === "ONLINE";
  const hasCoords = i.lat != null && i.lng != null;

  if (i.method === "DELIVERY") {
    if (hasCoords) {
      const auto = await i.autoFee();
      if (auto) return { fee: auto.fee, source: "AUTO" };
    }
    if (online) {
      const hasDistrict = i.district !== undefined && i.district !== null && String(i.district).trim() !== "";
      if (hasDistrict && i.settings) {
        const d = districtFee(i.district, i.settings.districtZones, i.settings, i.hasRental, i.khoroo, i.settings.khorooZones);
        if (!d.ok) throw new DeliveryFeeError(d.error!);
        return { fee: d.fee!, source: "DISTRICT" };
      }
      if (hasCoords) return { fee: raw, source: "CLIENT" }; // Дэлгүүрийн байршил тохируулаагүй (хуучин зан төлөв)
      throw new DeliveryFeeError("Хүргэлтийн байршлыг (газрын зураг/GPS эсвэл дүүрэг) заавал оруулна уу");
    }
    return { fee: raw, source: "CLIENT" };
  }

  if (online) {
    if (i.method === "LOCAL_TRANSPORT" && i.settings) return { fee: Number(i.settings.localTransportFee), source: "LOCAL" };
    return { fee: 0, source: "NONE" }; // PICKUP, POST, UB_CAB — үнэгүй; клиентийн дүнг ТООХГҮЙ
  }
  return { fee: raw, source: "CLIENT" }; // POS: Staff-ийн оруулсан дүн
}
