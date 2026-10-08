// ============================================================================
// TIMEZONE UTILS — Улаанбаатарын (UTC+8) цагийг СЕРВЕРИЙН СИСТЕМИЙН цагийн
// бүсээс ҮЛ ХАМААРАН найдвартай тооцоход ашиглана.
// ----------------------------------------------------------------------------
// Монгол улс 2017 оноос хойш зуны цагийн шилжилтгүй, ТОГТМОЛ UTC+8 тул
// найдвартай, энгийн тогтмол offset ашиглаж болно (IANA timezone db хэрэггүй).
// ⚠️ Хэрэв Монгол улс ирээдүйд DST-г дахин нэвтрүүлбэл энэ файлыг шинэчлэх
// шаардлагатай болно.
// ============================================================================

export const ULAANBAATAR_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Одоогийн мөчийг УБ-ын "wall clock" Date болгож буцаана (зөвхөн Y/M/D/H/M/S уншихад ашиглана). */
export function nowInUlaanbaatar(): Date {
  return new Date(Date.now() + ULAANBAATAR_OFFSET_MS);
}

/**
 * УБ-ын өнөөдрийн 00:00 цагт харгалзах БОДИТ (UTC) Date-ийг буцаана —
 * DB-ийн UTC огноотой шууд харьцуулахад ашиглана.
 */
export function startOfTodayInUlaanbaatar(): Date {
  const ub = nowInUlaanbaatar();
  const y = ub.getUTCFullYear();
  const m = ub.getUTCMonth();
  const d = ub.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - ULAANBAATAR_OFFSET_MS);
}
