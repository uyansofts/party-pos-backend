// ============================================================================
// FEATURED SLOTS — Онцлох байрлалын ЛИМИТ, ХУАНЛИ (цэвэр логик). Өдөр = Улаанбаатарын өдөр.
//   Өдөр бүр: нөөцлөгдсөн/төлөгдсөн зар + Staff хугацаагүй онцолсон бараа (baseline) ≤ лимит
//   Нөөцлөлт (APPROVED, PAYMENT_REPORTED) holdUntil хүртэл байрлал эзэлнэ; хугацаа дуусвал чөлөөлөгдөнө
// ============================================================================

const DAY = 86400_000;
const UB_MS = 8 * 3600_000;

export interface Booking {
  id: string;
  productId?: string;
  startsAt: Date | string;
  endsAt: Date | string;
  status: string;
  holdUntil?: Date | string | null;
}

const ms = (v: Date | string): number => new Date(v).getTime();
const key = (m: number): string => new Date(m + UB_MS).toISOString().slice(0, 10);

/** Энэ зар одоо байрлал эзэлж байна уу. */
export function occupies(b: Booking, now: Date): boolean {
  if (b.status === "ACTIVE") return true;
  if (b.status === "APPROVED" || b.status === "PAYMENT_REPORTED") return !b.holdUntil || ms(b.holdUntil) > now.getTime();
  return false;
}

/** Өдөр бүрийн эзэлсэн байрлал: from-оос days өдөр (өдөр i = [from + i*DAY, +DAY)). baseline = Staff хугацаагүй онцолсон бараа. */
export function usedPerDay(bookings: Booking[], fromMs: number, days: number, now: Date, baseline: number = 0): number[] {
  const out: number[] = Array.from({ length: days }, () => baseline);
  for (const b of bookings) {
    if (!occupies(b, now)) continue;
    const s = ms(b.startsAt);
    const e = ms(b.endsAt);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    for (let i = 0; i < days; i++) {
      const ds = fromMs + i * DAY;
      if (s < ds + DAY && e > ds) out[i]++;
    }
  }
  return out;
}

/** Шинэ зар [startMs, +days) цонхонд багтах уу (exceptId = өөрийгөө тооцохгүй). */
export function checkCapacity(bookings: Booking[], startMs: number, days: number, limit: number, now: Date, baseline: number = 0, exceptId?: string): { ok: boolean; fullDays: string[] } {
  const used = usedPerDay(bookings.filter((b) => b.id !== exceptId), startMs, days, now, baseline);
  const fullDays = used.map((u, i) => (u >= limit ? key(startMs + i * DAY) : "")).filter(Boolean);
  return { ok: fullDays.length === 0, fullDays };
}

/** fromMs-оос эхлээд horizon хоногийн дотор days хоногийн цонх багтах хамгийн ойрын эхлэх өдөр, эсвэл null. */
export function nextAvailableStart(bookings: Booking[], fromMs: number, days: number, limit: number, now: Date, baseline: number = 0, horizonDays: number = 60, exceptId?: string): Date | null {
  const filtered = bookings.filter((b) => b.id !== exceptId);
  const used = usedPerDay(filtered, fromMs, horizonDays + days, now, baseline);
  for (let start = 0; start <= horizonDays; start++) {
    let ok = true;
    for (let i = 0; i < days; i++) if (used[start + i] >= limit) { ok = false; break; }
    if (ok) return new Date(fromMs + start * DAY);
  }
  return null;
}

/** Нэг барааг ижил хугацаанд хоёр удаа онцлохоос сэргийлнэ (нөөцлөгдсөн/төлөгдсөн зартай давхцах эсэх). */
export function productOverlaps(bookings: Booking[], productId: string, startMs: number, endMs: number, now: Date, exceptId?: string): boolean {
  return bookings.some((b) => b.id !== exceptId && b.productId === productId && occupies(b, now) && ms(b.startsAt) < endMs && ms(b.endsAt) > startMs);
}

export interface CalendarDay {
  date: string;
  used: number;
  limit: number;
  free: number;
  bookingIds: string[];
}

/** Хуанли: өдөр бүрийн эзэлсэн/лимит ба тэр өдөр байрлал эзэлж буй зарын id-ууд. */
export function buildCalendar(bookings: Booking[], fromMs: number, days: number, limit: number, now: Date, baseline: number = 0): CalendarDay[] {
  const used = usedPerDay(bookings, fromMs, days, now, baseline);
  return used.map((u, i) => {
    const ds = fromMs + i * DAY;
    const ids = bookings.filter((b) => occupies(b, now) && ms(b.startsAt) < ds + DAY && ms(b.endsAt) > ds).map((b) => b.id);
    return { date: key(ds), used: u, limit, free: Math.max(0, limit - u), bookingIds: ids };
  });
}
