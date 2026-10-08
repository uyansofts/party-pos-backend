// ============================================================================
// NIGHT HOURS — Шөнийн цагт ДЭЛГҮҮРИЙН хүргэлт гаргахгүй (курьерийн илгээмж шөнө ч явна).
// Цагийг ҮРГЭЛЖ Улаанбаатарын (UTC+8) цагаар тооцно. 22:00–08:00 мэт шөнө дундыг гатлах хугацааг дэмжинэ.
// ============================================================================

const UB_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface NightSettings {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

const hourOr = (v: unknown, fallback: number): number => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

/** ShopSettings мөрөөс (эсвэл null-аас) шөнийн тохиргоог гаргана. Анхдагч: идэвхтэй, 22:00–08:00. */
export function normalizeNightSettings(row: any): NightSettings {
  const flag = row?.nightHoldEnabled;
  return {
    enabled: flag === undefined || flag === null ? true : Boolean(flag),
    startHour: hourOr(row?.nightStartHour, 22),
    endHour: hourOr(row?.nightEndHour, 8),
  };
}

/** start == end бол шөнийн цаг байхгүй. start > end бол шөнө дундыг гатлана (22→8). */
export function isNightHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

export function isNightNow(n: NightSettings, nowMs: number = Date.now()): boolean {
  if (!n.enabled) return false;
  return isNightHour(new Date(nowMs + UB_OFFSET_MS).getUTCHours(), n.startHour, n.endHour);
}

const pad = (h: number) => String(h).padStart(2, "0");

export function nightRangeLabel(n: NightSettings): string {
  return `${pad(n.startHour)}:00–${pad(n.endHour)}:00`;
}

export function nightHoldMessage(n: NightSettings): string {
  return `Шөнийн цагт (${nightRangeLabel(n)}) дэлгүүрийн хүргэлт гаргахгүй — ${pad(n.endHour)}:00 цагаас хойш гаргана уу. (Курьерийн илгээмж шөнө ч явуулж болно.)`;
}
