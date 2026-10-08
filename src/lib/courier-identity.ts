// ============================================================================
// COURIER IDENTITY — Хүргэгчийн НИЙТЭД харагдах танилт (цэвэр логик, тестлэхэд хялбар).
//   • Нийтэд харагдах нэр = nickname (байхгүй бол бүртгэлтэй нэр)
//   • Машины дугаар — Монголын улсын дугаар (4 тоо + 2-3 кирилл үсэг), латин ижил хэлбэрийг хөрвүүлнэ
//   • Од (1..5) — шалгалт, дундаж
// ============================================================================

export interface Validation<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function courierDisplayName(c: { name: string; nickname?: string | null }): string {
  const n = typeof c.nickname === "string" ? c.nickname.trim() : "";
  return n ? n : c.name;
}

/** null/хоосон → null (арилгана). 2-24 тэмдэгт; үсэг, тоо, emoji, зай, . _ - ' зөвшөөрнө (< > @ / : зэрэг HTML/линк тэмдэгтийг хориглоно). */
export function normalizeNickname(raw: unknown): Validation<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Nickname текст байх ёстой" };
  const v = raw.trim().replace(/\s+/g, " ");
  if (v === "") return { ok: true, value: null };
  if (v.length < 2 || v.length > 24) return { ok: false, error: "Nickname 2-24 тэмдэгттэй байх ёстой" };
  if (!/^[\p{L}\p{N}\p{Extended_Pictographic} ._'’\-\u200D\uFE0F]+$/u.test(v)) {
    return { ok: false, error: "Nickname-д зөвхөн үсэг, тоо, emoji, зай болон . _ - ' тэмдэгт ашиглана (< > @ / : боломжгүй)" };
  }
  return { ok: true, value: v };
}

/** Staff-д зориулсан шошго: nickname байвал "Nickname (Жинхэнэ нэр)", үгүй бол жинхэнэ нэр. */
export function courierStaffLabel(c: { name: string; nickname?: string | null }): string {
  const n = typeof c.nickname === "string" ? c.nickname.trim() : "";
  return n && n !== c.name ? `${n} (${c.name})` : c.name;
}

const PLATE_LOOKALIKE: Record<string, string> = { A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", X: "Х", Y: "У" };

/** "1234 уба", "1234-UBA"(латин A→А г.м.) → "1234УБА". null/хоосон → null (арилгана). */
export function normalizeVehiclePlate(raw: unknown): Validation<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Машины дугаар текст байх ёстой" };
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned === "") return { ok: true, value: null };
  const mapped = Array.from(cleaned).map((ch) => PLATE_LOOKALIKE[ch] ?? ch).join("");
  if (!/^\d{4}[А-ЯЁӨҮ]{2,3}$/.test(mapped)) {
    return { ok: false, error: "Машины дугаар буруу байна — жишээ: 1234УБА (4 тоо + 2-3 кирилл үсэг)" };
  }
  return { ok: true, value: mapped };
}

/** "уб 12345678", "УБ-12345678", латин "YB12345678" → "УБ12345678". Хоосон → null (арилгана). */
export function normalizeRegisterNumber(raw: unknown): Validation<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Регистрийн дугаар текст байх ёстой" };
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned === "") return { ok: true, value: null };
  const mapped = Array.from(cleaned).map((ch) => PLATE_LOOKALIKE[ch] ?? ch).join("");
  if (!/^[А-ЯЁӨҮ]{2}\d{8}$/.test(mapped)) {
    return { ok: false, error: "Регистрийн дугаар буруу байна — жишээ: УБ12345678 (2 кирилл үсэг + 8 тоо)" };
  }
  return { ok: true, value: mapped };
}

export interface DepositHold {
  depositType: "MONEY" | "DOCUMENT";
  depositAmount: number;
  depositNote: string | null;
}

/** Барьцаа авахад: МӨНГӨ бол дүн (>0), БИЧИГ БАРИМТ бол ЯМАР бичиг баримтыг заавал бичнэ (өмнө нь хоосон үлддэг байсан). */
export function validateDepositHold(input: { depositType?: unknown; depositAmount?: unknown; depositNote?: unknown }): Validation<DepositHold> {
  const type = input.depositType;
  if (type !== "MONEY" && type !== "DOCUMENT") return { ok: false, error: "Барьцааны төрөл MONEY эсвэл DOCUMENT байх ёстой" };
  let note: string | null = null;
  if (input.depositNote !== undefined && input.depositNote !== null) {
    if (typeof input.depositNote !== "string") return { ok: false, error: "Тэмдэглэл текст байх ёстой" };
    note = input.depositNote.trim() || null;
    if (note && note.length > 200) return { ok: false, error: "Тэмдэглэл 200 тэмдэгтээс ихгүй байх ёстой" };
  }
  if (type === "DOCUMENT") {
    if (!note || note.length < 2) return { ok: false, error: "Ямар бичиг баримт барьцаалснаа бичнэ үү (жишээ: Иргэний үнэмлэх)" };
    return { ok: true, value: { depositType: "DOCUMENT", depositAmount: 0, depositNote: note } };
  }
  const amount = typeof input.depositAmount === "string" && input.depositAmount.trim() !== "" ? Number(input.depositAmount) : input.depositAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
    return { ok: false, error: "Барьцааны дүнг зөв (0-ээс их) оруулна уу" };
  }
  return { ok: true, value: { depositType: "MONEY", depositAmount: amount, depositNote: note } };
}

/** Од (1..5, бүхэл) болон тайлбар (≤200) шалгана. */
export function validateRating(stars: unknown, comment: unknown): Validation<{ stars: number; comment: string | null }> {
  const n = typeof stars === "string" && stars.trim() !== "" ? Number(stars) : stars;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
    return { ok: false, error: "Од 1-ээс 5 хүртэлх бүхэл тоо байх ёстой" };
  }
  let c: string | null = null;
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== "string") return { ok: false, error: "Тайлбар текст байх ёстой" };
    c = comment.trim() || null;
    if (c && c.length > 200) return { ok: false, error: "Тайлбар 200 тэмдэгтээс ихгүй байх ёстой" };
  }
  return { ok: true, value: { stars: n, comment: c } };
}

/** Дундажийг 1 оронтой бөөрөнхийлнө; үнэлгээгүй бол null. */
export function roundRating(avg: number | null | undefined): number | null {
  return typeof avg === "number" && Number.isFinite(avg) ? Math.round(avg * 10) / 10 : null;
}

export interface CourierStats {
  ratingAverage: number | null;
  ratingCount: number;
  completedDeliveries: number;
}

export interface CourierPublicProfile extends CourierStats {
  displayName: string;
  vehiclePlate: string | null;
}

export function buildPublicProfile(
  c: { name: string; nickname?: string | null; vehiclePlate?: string | null },
  stats?: CourierStats
): CourierPublicProfile {
  return {
    displayName: courierDisplayName(c),
    vehiclePlate: c.vehiclePlate ?? null,
    ratingAverage: stats?.ratingAverage ?? null,
    ratingCount: stats?.ratingCount ?? 0,
    completedDeliveries: stats?.completedDeliveries ?? 0,
  };
}
