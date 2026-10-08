// ============================================================================
// SELLER ORDER ITEMS — Худалдагчид захиалгын барааг БҮРЭН ойлгомжтойгоор харуулах (цэвэр логик).
// Худалдагч захиалгыг хийхэд: ямар өнгө/хэмжээ, ямар сонголт, ямар бичвэр, ямар материал/хэмжээ, нэмэлт үйлчилгээ,
// ХЭЗЭЭ хэрэгтэй гэдгийг мэдэх ёстой. ⚠️ Харилцагчийн утас, хаяг, төлбөрийн мэдээлэл ЭНД ОРОХГҮЙ.
// ============================================================================

const MAX_LINES = 20;
const MAX_LEN = 200;

function clean(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  return t ? t.slice(0, MAX_LEN) : null;
}

/** Улаанбаатарын өдөр (UTC+8) "YYYY-MM-DD". Буруу огноо → null. */
export function ubDay(d: unknown): string | null {
  if (d === null || d === undefined || d === "") return null;
  const t = new Date(d as any).getTime();
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 10) : null;
}

/** Нэг барааны мөрийн дэлгэрэнгүй (хүн уншихад): сонголтууд, бичвэр, хувийн талбарууд, материал, үйлчилгээ, хэрэгтэй өдөр. */
export function sellerItemDetails(i: any): string[] {
  const out: string[] = [];
  const sv = i?.selectedVariations;
  if (sv && typeof sv === "object" && !Array.isArray(sv)) {
    for (const [k, v] of Object.entries(sv).slice(0, 10)) {
      const key = clean(k);
      const val = clean(v);
      if (key && val) out.push(`${key}: ${val}`);
    }
  }
  const text = clean(i?.customizationText);
  if (text) out.push(`Бичвэр: ${text}`);
  if (Array.isArray(i?.customFieldValues)) {
    for (const f of i.customFieldValues.slice(0, 10)) {
      const label = clean(f?.label);
      const value = clean(f?.value);
      const unit = clean(f?.unit);
      if (label && value) out.push(`${label}: ${value}${unit ? " " + unit : ""}`);
    }
  }
  const mat = clean(i?.materialNameSnapshot);
  if (mat) {
    const w = Number(i?.widthCm);
    const h = Number(i?.heightCm);
    out.push(`Материал: ${mat}${w > 0 && h > 0 ? ` (${w}×${h} см)` : ""}`);
  }
  if (i?.serviceRequested) out.push(`Нэмэлт үйлчилгээ: ${clean(i?.serviceLabelSnapshot) ?? "шаардлагатай"}`);
  const day = ubDay(i?.customizationDeadline);
  if (day) out.push(`Хэрэгтэй өдөр: ${day}`);
  return out.slice(0, MAX_LINES);
}

/** Барааны өнгө/хэмжээ (сонгосон хувилбар): "Өнгө: Улаан · Хэмжээ: M" эсвэл null. */
export function sellerItemVariant(product: any): string | null {
  const parts: string[] = [];
  const color = clean(product?.color);
  const size = clean(product?.size);
  if (color) parts.push(`Өнгө: ${color}`);
  if (size) parts.push(`Хэмжээ: ${size}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Худалдагчид (портал) болон Staff-д харуулах барааны мөр. ЗӨВХӨН зөвшөөрсөн талбар. */
export function sellerItemView(i: any) {
  return {
    name: clean(i?.product?.name) ?? "Бараа",
    variant: sellerItemVariant(i?.product),
    quantity: Number(i?.quantity) || 0,
    unitPrice: Number(i?.unitPrice) || 0,
    subtotal: Number(i?.subtotal) || 0,
    details: sellerItemDetails(i),
  };
}
