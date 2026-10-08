// ============================================================================
// PRODUCT IMAGES — Барааны ОЛОН зураг, ангиллын зураг (цэвэр логик, импорт/POS/худалдагч бүгдэд НЭГ дүрэм).
//   • Зөвшөөрөгдөх холбоос: Google Drive (→ манай image-proxy), манай proxy-ийн хаяг, ӨӨР https:// зураг
//   • Хориглох: http:// (storefront-д mixed-content), javascript:, data:, зайтай/хашилттай холбоос
//   • Түлхүүр зураг (cover) = жагсаалтын эхний зураг; давхардал арилна; хамгийн ихдээ 10
// ============================================================================

import { toDriveImageUrl } from "./drive-image";

export const MAX_PRODUCT_IMAGES = 10;

export class ImageError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "ImageError";
    this.status = status;
  }
}

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "http://localhost:4000";
const OWN_PROXY_PREFIX = `${PUBLIC_API_URL.replace(/\/+$/, "")}/api/images/`;

/**
 * Нэг холбоосыг хадгалах хэлбэрт хөрвүүлнэ; хүчингүй бол null.
 *   Google Drive холбоос / FILE_ID → манай proxy;  манай proxy-ийн хаяг → хэвээр;  бусад https → хэвээр.
 */
export function resolveImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > 500 || /[\s"'<>]/.test(t)) return null;
  if (t.startsWith(OWN_PROXY_PREFIX)) return t; // аль хэдийн манай proxy (POS-д дахин хадгалахад зураг арилахаас сэргийлнэ)
  // Өмнөх ОРЧНЫ (жишээ: localhost:4000, хуучин домэйн) proxy холбоос — бидний өөрсдийн үүсгэсэн хэлбэр тул хадгалж, засахад татгалзахгүй
  if (/^https?:\/\/[^\/\s]+\/api\/images\/[A-Za-z0-9_-]+$/i.test(t)) return t;
  const m = /^https?:\/\/([^\/?#:]+)/i.exec(t);
  if (m) {
    if (!/^https:/i.test(t)) return null; // http:// хориотой
    const host = m[1].toLowerCase();
    if (host === "drive.google.com" || host === "docs.google.com") return toDriveImageUrl(t);
    return t;
  }
  if (/^[A-Za-z0-9_-]{15,}$/.test(t)) return toDriveImageUrl(t); // Excel-д зөвхөн FILE_ID бичсэн
  return null;
}

/** Нүднүүдийн текстийг (шинэ мөр, таслал, "|", ";", зай-аар тусгаарласан) жагсаалт болгоно — давхардалгүй, дараалал хэвээр. */
export function parseImageList(cells: unknown[]): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    if (cell === null || cell === undefined) continue;
    for (const token of String(cell).split(/[\s,;|]+/)) {
      const t = token.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** POS/худалдагчийн оролт: { imageUrl?, imageUrls? } → { cover, жагсаалт }. Хүчингүй холбоос бол ALDAA (чимээгүй алдахгүй). */
export function normalizeProductImages(input: { imageUrl?: unknown; imageUrls?: unknown }): { imageUrl: string | null; imageUrls: string[] } {
  let raw: unknown[] = [];
  if (input.imageUrls !== undefined && input.imageUrls !== null) {
    if (!Array.isArray(input.imageUrls)) throw new ImageError("imageUrls нь жагсаалт байх ёстой");
    raw = input.imageUrls;
  } else if (typeof input.imageUrl === "string" && input.imageUrl.trim()) {
    raw = [input.imageUrl]; // хуучин (ганц зурагт) клиент
  }
  const list: string[] = [];
  for (const item of raw) {
    if (item === null || item === undefined || (typeof item === "string" && item.trim() === "")) continue; // хоосон мөрийг алгасна
    const resolved = resolveImageUrl(item);
    if (!resolved) throw new ImageError(`Зургийн холбоос буруу: "${String(item).slice(0, 60)}" — https:// эсвэл Google Drive холбоос байх ёстой`);
    if (!list.includes(resolved)) list.push(resolved);
  }
  if (list.length > MAX_PRODUCT_IMAGES) throw new ImageError(`Нэг бараанд хамгийн ихдээ ${MAX_PRODUCT_IMAGES} зураг оруулна`);
  return { imageUrl: list[0] ?? null, imageUrls: list };
}

/** Нийтэд харуулах жагсаалт: түлхүүр зураг ЭХЭНД, давхардалгүй (хуучин өгөгдөлд imageUrls хоосон байж болно). */
export function galleryOf(p: { imageUrl?: string | null; imageUrls?: string[] | null }): string[] {
  const out: string[] = [];
  if (p.imageUrl) out.push(p.imageUrl);
  for (const u of p.imageUrls ?? []) if (u && !out.includes(u)) out.push(u);
  return out.slice(0, MAX_PRODUCT_IMAGES);
}

/**
 * Импортын мөрөөс зургийн нүднүүдийг цуглуулна: "Image_url", "Image_url_2" … "Image_url_10" (мөн "Image_url 2", "Image_url2").
 * Толгойн нэрийн том/жижиг үсгийг үл хайхрана. Дарааллыг баганы дугаараар (Image_url эхэнд).
 */
export function imageColumnIndexes(headers: unknown[]): number[] {
  const found: Array<{ idx: number; n: number }> = [];
  headers.forEach((h, idx) => {
    const m = /^\s*image[_ ]?url(?:[_ -]?(\d{1,2}))?\s*$/i.exec(String(h ?? ""));
    if (!m) return;
    const n = m[1] ? Number(m[1]) : 1;
    if (n >= 1 && n <= MAX_PRODUCT_IMAGES) found.push({ idx, n }); // 1..10 (Image_url_11, Image_url_0 оролцохгүй)
  });
  return found.sort((a, b) => a.n - b.n || a.idx - b.idx).map((f) => f.idx);
}

/** Мөрөөс зургийн жагсаалтыг (resolve хийсэн, хүчингүйг нь тусад нь) гаргана. */
export function extractRowImages(headers: unknown[], row: unknown[]): { images: string[]; invalid: string[] } {
  const tokens = parseImageList(imageColumnIndexes(headers).map((i) => row[i]));
  const images: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    const r = resolveImageUrl(t);
    if (!r) invalid.push(t);
    else if (!images.includes(r)) images.push(r);
  }
  return { images: images.slice(0, MAX_PRODUCT_IMAGES), invalid };
}
