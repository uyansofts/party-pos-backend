// ============================================================================
// UPLOAD QUOTA — Худалдагч нэг өдөрт хэдэн зураг оруулахыг хязгаарлана (диск/Storage дүүргэхээс сэргийлнэ).
// Санах ойд (сервер дахин асахад тэглэгдэнэ — хамгаалалт, нягтлан бодох бүртгэл БИШ). Өдөр = UTC.
// ============================================================================

export class DailyQuota {
  private readonly counts = new Map<string, { day: string; n: number }>();
  constructor(private readonly limit: number) {}
  private day(nowMs: number) {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
  /** Нэг ашиглалт бүртгэнэ. Хязгаар хэтэрсэн бол false (бүртгэхгүй). */
  consume(key: string, nowMs: number = Date.now()): boolean {
    const d = this.day(nowMs);
    const cur = this.counts.get(key);
    if (!cur || cur.day !== d) {
      this.counts.set(key, { day: d, n: 1 });
      this.prune(d);
      return true;
    }
    if (cur.n >= this.limit) return false;
    cur.n++;
    return true;
  }
  /** Амжилтгүй upload-ыг буцаан тооцохгүй байхын тулд (шалгалтад унасан файл квот идэхгүй). */
  refund(key: string, nowMs: number = Date.now()) {
    const cur = this.counts.get(key);
    if (cur && cur.day === this.day(nowMs) && cur.n > 0) cur.n--;
  }
  remaining(key: string, nowMs: number = Date.now()): number {
    const cur = this.counts.get(key);
    return !cur || cur.day !== this.day(nowMs) ? this.limit : Math.max(0, this.limit - cur.n);
  }
  private prune(today: string) {
    if (this.counts.size < 500) return;
    for (const [k, v] of this.counts) if (v.day !== today) this.counts.delete(k);
  }
}
