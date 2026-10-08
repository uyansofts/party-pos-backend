// Монгол утасны дугаар (8 оронтой, 6-9-өөр эхэлнэ — Storefront-той ижил дүрэм).
// "+976 9911-2233", "976 99112233", "(99) 11 22 33" зэрэг бичлэгийг "99112233" болгоно.
// Буруу бол null.
export function normalizeMongolianPhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  // Зөвхөн тоо, зай, + - ( ) . тэмдэгт зөвшөөрнө — үсэг/бусад тэмдэгттэй текстээс тоо сугалж авахгүй (өгөгдөл бохирдохоос сэргийлнэ)
  if (!/^[\d\s+\-().]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  if (digits.startsWith("00976")) digits = digits.slice(5);
  else if (digits.startsWith("976") && digits.length === 11) digits = digits.slice(3);
  return /^[6-9]\d{7}$/.test(digits) ? digits : null;
}
