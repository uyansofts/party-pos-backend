// ============================================================================
// GOOGLE DRIVE IMAGE URL HELPER
// ----------------------------------------------------------------------------
// ✅ АРХИТЕКТУРЫН ШИЙДЭЛ (CORS-ийг бүрмөсөн арилгасан): Google Drive-ийн
// шууд линкийг БУЦААХГҮЙ, харин манай ӨӨРИЙН image-proxy.controller.ts
// endpoint рүү чиглэсэн URL үүсгэнэ. Тэр endpoint нь Drive-с зургийг
// сервер-сервер хэлбэрээр (CORS хамаарахгүй) татаад, манай ӨӨРИЙН CORS
// header-тэйгээр Flutter/Storefront руу дамжуулдаг.
//
// Дэмждэг оролтын форматууд (Excel-ийн Image_url баганад):
//   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
//   https://drive.google.com/open?id=FILE_ID
//   https://drive.google.com/uc?id=FILE_ID
//   FILE_ID (зөвхөн ID өөрөө — таны одоогийн Excel-ийн формат)
// ============================================================================

// Манай серверийн НИЙТЭД ХАРАГДАХ хаяг — Flutter/Storefront үүгээр дамжиж
// зургийг ачаална. Production-д .env-ээр өөрчилнө (жишээ:
// PUBLIC_API_URL=https://api.diyparty.mn), локал хөгжүүлэлтэд анхдагчаар
// localhost:4000 ашиглана (Flutter-ийн kApiBaseUrl-тэй ЯГ ТААРАХ ёстой).
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "http://localhost:4000";

export function toDriveImageUrl(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  let fileId: string | null = null;

  // Формат 1: /file/d/FILE_ID/...
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  // Формат 2: ?id=FILE_ID эсвэл &id=FILE_ID
  if (!fileId) {
    const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) fileId = idMatch[1];
  }

  // Формат 3: оролт нь аль хэдийн ГАНЦХАН FILE_ID (URL биш) — таны Excel-ийн
  // Image_url багана яг ЭНЭ хэлбэртэй (зөвхөн ID) байгаа тул голчлон энэ
  // мөрөөр танигдана.
  if (!fileId && /^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) {
    fileId = trimmed;
  }

  if (!fileId) {
    console.warn(`⚠️  Google Drive линкээс FILE_ID гаргаж чадсангүй: ${trimmed}`);
    return null;
  }

  // ---------------------------------------------------------------------
  // ⚠️ Google Drive-ийн URL-ыг ШУУД БИШ, манай proxy-гоор дамжуулна.
  // ---------------------------------------------------------------------
  return `${PUBLIC_API_URL}/api/images/${fileId}`;
}
