// ALLOWED_ORIGINS="https://a.mn, https://b.mn" → ["https://a.mn","https://b.mn"] (хоосон зай/хоосон мөр цэвэрлэнэ).
// Тохируулаагүй/хоосон бол "*" (өмнөх үйлдэл хэвээр — хөгжүүлэлтэд). Production-д тохируулахыг server.ts анхааруулна.
export function parseAllowedOrigins(env: string | undefined): string | string[] {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : "*";
}
