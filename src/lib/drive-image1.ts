// ============================================================================
// GOOGLE DRIVE IMAGE URL HELPER
// ----------------------------------------------------------------------------
// Google Drive-ийн энгийн "share" линк (.../file/d/FILE_ID/view?usp=sharing)
// ЗУРАГ шууд харуулахад АЖИЛЛАДАГГҮЙ — HTML preview хуудас руу чиглүүлдэг.
// Үүнийг "thumbnail" endpoint рүү хөрвүүлнэ, энэ нь hotlink-д хамгийн
// найдвартай (том файлд Google-ийн "virus scan warning" interstitial
// заримдаа гардаг uc?export=view-ээс ялгаатай).
//
// Дэмждэг оролтын форматууд:
//   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
//   https://drive.google.com/open?id=FILE_ID
//   https://drive.google.com/uc?id=FILE_ID
//   FILE_ID (зөвхөн ID өөрөө, урьдчилж боловсруулсан бол)
// ============================================================================

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
  // thumbnail формат ашиглана — Google-ийн зургийн proxy (lh3.googleusercontent.com
  // руу дотооддоо чиглүүлдэг) тул CORS/redirect асуудалгүй, Flutter Web дээр
  // хамгийн тогтвортой ажилладаг. uc?export=view-ийг эхлээд туршиж үзсэн ч
  // Flutter Web дээр CORS/interstitial асуудал гарсан тул үүнд шилжив.
  // ---------------------------------------------------------------------
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
}
