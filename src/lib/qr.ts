// ============================================================================
// QR — QPay-ийн QR зургийг хөтөч дээр харуулах хэлбэрт оруулна (цэвэр логик).
//   QPay V2 `qr_image`-ийг ЦЭВЭР base64 (PNG) буцаадаг — "data:" угтваргүй. <img src="...">-д шууд хийвэл зураг ХАРАГДАХГҮЙ.
// ============================================================================

const MAX_QR_LEN = 200_000; // ердийн QPay QR ~10-30KB; хэт том/буруу утгыг татгалзана

/** QR зургийн src: data:/http(s) хэвээр; цэвэр base64 → "data:image/png;base64,..."; хоосон/буруу → null (клиент QR текстийг харуулна). */
export function toQrImageSrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_QR_LEN) return null;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length >= 64) return `data:image/png;base64,${compact}`; // цэвэр base64
  return null;
}
