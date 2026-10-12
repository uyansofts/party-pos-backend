// ============================================================================
// IMAGE PROXY GUARD — Google Drive-аас ирсэн хариуг ЗӨВХӨН бодит зураг бол дамжуулна.
// Drive нь хандах эрхгүй файлд HTML (нэвтрэх хуудас, вирус шалгалтын анхааруулга) буцаадаг; үүнийг манай
// домэйнээс `text/html`-ээр дамжуулбал XSS-ийн эх үүсвэр болно. SVG/HTML хэзээ ч гаргахгүй.
// ============================================================================

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** `image/jpeg; charset=...` → "image/jpeg"; зөвшөөрөгдөөгүй/байхгүй бол null. */
export function safeImageContentType(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const ct = header.split(";")[0].trim().toLowerCase();
  return ALLOWED.has(ct) ? ct : null;
}
