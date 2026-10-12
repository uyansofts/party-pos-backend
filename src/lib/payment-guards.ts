// ============================================================================
// PAYMENT GUARDS — төлбөрийн аюулгүй байдлын цэвэр (DB-гүй) дүрмүүд
// ----------------------------------------------------------------------------
// Энд зөвхөн цэвэр функц байна (Prisma/сүлжээ импортлохгүй) — тиймээс тест хийхэд хялбар.
// Мөнгийг ЦЕНТЭЭР (бүхэл тоо) харьцуулна: 0.1 + 0.2 !== 0.3 төрлийн хөвөгч таслалын алдаанаас сэргийлнэ.
// ============================================================================

export const toCents = (n: number): number => Math.round(Number(n) * 100);

/** Төлбөр хүлээн авч болох захиалгын төлвүүд (PAID / CANCELLED / REFUNDED-д шинэ төлбөр хэрэгжүүлэхгүй). */
export const PAYABLE_STATUSES = ["PENDING", "PARTIALLY_PAID"] as const;

/** Төлбөрийг захиалгад хэрэгжүүлж БОЛОХГҮЙ байсан шалтгаан (мөнгө аль хэдийн орсон — Staff шалгаж буцаана). */
export type UnappliedReason = "ORDER_NOT_FOUND" | "CANCELLED" | "REFUNDED" | "ALREADY_PAID" | "NOTHING_DUE" | "INSUFFICIENT_STOCK";

export function classifyUnapplied(order: { paymentStatus: string; cancelledAt?: Date | string | null } | null | undefined): UnappliedReason {
  if (!order) return "ORDER_NOT_FOUND";
  if (order.paymentStatus === "REFUNDED") return "REFUNDED";
  if (order.paymentStatus === "CANCELLED" || order.cancelledAt) return "CANCELLED";
  if (order.paymentStatus === "PAID") return "ALREADY_PAID";
  return "NOTHING_DUE";
}

export function unappliedMessage(reason: UnappliedReason): string {
  switch (reason) {
    case "ORDER_NOT_FOUND":
      return "Захиалга олдсонгүй";
    case "CANCELLED":
      return "Цуцлагдсан захиалгад төлбөр бүртгэх боломжгүй";
    case "REFUNDED":
      return "Буцаагдсан захиалгад төлбөр бүртгэх боломжгүй";
    case "ALREADY_PAID":
      return "Энэ захиалга аль хэдийн бүрэн төлөгдсөн байна";
    case "INSUFFICIENT_STOCK":
      return "Нөөц хүрэлцэхгүй тул захиалгыг баталгаажуулах боломжгүй";
    default:
      return "Төлөх үлдэгдэл дүн алга байна";
  }
}

/** Invoice-ийн дүн хүчинтэй эсэх (эерэг, хязгаартай, 2 орны нарийвчлал). */
export function isValidMoneyAmount(amount: unknown): amount is number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
  if (amount <= 0 || amount > 1_000_000_000) return false;
  return Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

export class InvalidInvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvoiceError";
  }
}

/** ORDER_PAYMENT invoice-ийн дээд хязгаар = захиалга/сагсны үлдэгдэл + хамт төлөх барьцаа. */
export function checkOrderInvoiceAmount(amount: number, remaining: number, combinedDeposit: number): void {
  if (!isValidMoneyAmount(amount)) throw new InvalidInvoiceError("Төлбөрийн дүн буруу байна");
  if (toCents(remaining) <= 0) throw new InvalidInvoiceError("Төлөх үлдэгдэл дүн алга байна");
  const ceiling = toCents(remaining) + toCents(combinedDeposit);
  if (toCents(amount) > ceiling) {
    throw new InvalidInvoiceError(`Төлбөрийн дүн үлдэгдэл (${ceiling / 100}₮)-ээс их байж болохгүй`);
  }
}

/** DEPOSIT invoice-ийн дүн барьцааны дүнтэй ЯГ тэнцүү байх ёстой. */
export function checkDepositInvoiceAmount(amount: number, depositAmount: number): void {
  if (!isValidMoneyAmount(amount)) throw new InvalidInvoiceError("Төлбөрийн дүн буруу байна");
  if (toCents(amount) !== toCents(depositAmount)) {
    throw new InvalidInvoiceError(`Барьцааны дүн ${depositAmount}₮ байх ёстой`);
  }
}

// ---------------------------------------------------------------------------
// ТӨЛСӨН ДҮНГИЙН ШИЙДВЭР (gateway-ийн мэдээлсэн дүн vs манай нэхэмжилсэн дүн)
//   UNVERIFIABLE — дүн байхгүй / тоо биш / хязгааргүй / 0-ээс бага-тэнцүү → ХЭЗЭЭ Ч "төлөгдсөн" гэж үзэхгүй (гүйлгээ PENDING, дараа дахин шалгана)
//   UNDERPAID    — нэхэмжлэлээс БАГА → автоматаар хэрэгжүүлэхгүй (PENDING, Staff гараар шалгана)
//   EXACT        — яг тэнцүү → хэрэгжүүлнэ
//   OVERPAID     — нэхэмжлэлээс ИЛҮҮ → нэхэмжилсэн дүнгээр хэрэгжүүлнэ, илүүг refund-due болгож бүртгэнэ (мөнгийг алдахгүй, захиалгыг хэтрүүлэн төлөгдсөн болгохгүй)
// ---------------------------------------------------------------------------
export type PaidAmountVerdict =
  | { kind: "UNVERIFIABLE"; reason: "MISSING" | "INVALID" | "INVALID_INVOICE_AMOUNT" }
  | { kind: "UNDERPAID"; shortfall: number }
  | { kind: "EXACT" }
  | { kind: "OVERPAID"; excess: number };

export function assessPaidAmount(invoiced: unknown, paid: unknown): PaidAmountVerdict {
  const inv = typeof invoiced === "number" ? invoiced : Number(invoiced);
  if (!isValidMoneyAmount(inv)) return { kind: "UNVERIFIABLE", reason: "INVALID_INVOICE_AMOUNT" };
  if (paid === undefined || paid === null) return { kind: "UNVERIFIABLE", reason: "MISSING" };
  if (typeof paid !== "number" || !Number.isFinite(paid) || paid <= 0 || paid > 1_000_000_000) return { kind: "UNVERIFIABLE", reason: "INVALID" };
  const diff = toCents(paid) - toCents(inv);
  if (diff < 0) return { kind: "UNDERPAID", shortfall: -diff / 100 };
  if (diff > 0) return { kind: "OVERPAID", excess: diff / 100 };
  return { kind: "EXACT" };
}
