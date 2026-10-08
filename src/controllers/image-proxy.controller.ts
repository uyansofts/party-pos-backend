// ============================================================================
// IMAGE PROXY CONTROLLER — Google Drive CORS-ийн асуудлыг бүрмөсөн арилгана
// ----------------------------------------------------------------------------
// АРХИТЕКТУРЫН ШАЛТГААН: Google Drive нь uc?export=view/thumbnail endpoint-
// дээрээ Access-Control-Allow-Origin header буцаадаггүй тул browser доторх
// ямар ч fetch()/XMLHttpRequest (Flutter Web CanvasKit renderer үүнийг
// дотроо ашигладаг) CORS-оор БЛОКЛОГДОНО. Харин СЕРВЕР-СЕРВЕР хүсэлт
// (энэ Express route Drive руу хийдэг axios дуудлага) CORS-ийн зохицуулалтад
// огт ХАМААРАХГҮЙ (CORS бол зөвхөн browser-ийн дүрэм) — тиймээс манай
// сервер Drive-с зургийг АМЖИЛТТАЙ татаад, дараа нь Flutter руу МАНАЙ
// ӨӨРИЙН (бид бүрэн хянадаг) CORS header-тэйгээр дамжуулна.
//
// Урсгал:
//   Flutter → GET /api/images/:fileId → манай сервер
//                                          → (CORS хамаарахгүй) → Google Drive
//                                          ← зургийн байт ←
//   Flutter ← зургийн байт + манай CORS header ←
// ============================================================================

import { Router, Request, Response } from "express";
import axios from "axios";
import { UPLOADED_ID, getImageStore } from "../lib/image-upload";

const router = Router();

// Зөвхөн Google Drive-ийн ХҮЧИНТЭЙ file ID форматыг зөвшөөрнө (аюулгүй
// байдал: дурын URL-ыг дамжуулдаг "нээлттэй proxy" болохоос сэргийлнэ —
// энэ route ЗӨВХӨН Google Drive рүү, ЗӨВХӨН энэ форматтай ID-гаар хандана).
const VALID_FILE_ID = /^[a-zA-Z0-9_-]{10,100}$/;

router.get("/:fileId", async (req: Request, res: Response) => {
  const { fileId } = req.params;

  // ✅ ШИНЭ: Файлаар upload хийсэн зураг (u_ + 24 hex) — Drive биш, манай хадгалалтаас. Нэр санамсаргүй тул хэзээ ч өөрчлөгдөхгүй → удаан кэшлэнэ.
  if (UPLOADED_ID.test(fileId)) {
    try {
      const img = await getImageStore().get(fileId);
      if (!img) return res.status(404).json({ error: "Зураг олдсонгүй" });
      res.set({
        "Content-Type": img.mime, // magic bytes-аар тогтоосон (зөвхөн jpeg/png/webp) — SVG/HTML хэзээ ч гарахгүй
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "cross-origin", // storefront/портал өөр домэйнээс <img>-ээр харуулна
      });
      return res.send(img.buf);
    } catch (err) {
      console.error(`Upload зураг (${fileId}) уншихад алдаа гарлаа:`, (err as Error).message);
      return res.status(502).json({ error: "Зураг татаж чадсангүй" });
    }
  }

  if (!VALID_FILE_ID.test(fileId)) {
    return res.status(400).json({ error: "Буруу file ID" });
  }

  try {
    const driveUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

    const response = await axios.get(driveUrl, {
      responseType: "arraybuffer",
      maxRedirects: 5, // Drive заримдаа googleusercontent.com руу redirect хийдэг
      timeout: 10_000,
    });

    const contentType = response.headers["content-type"] || "image/jpeg";

    // Browser/CDN түвшинд 1 өдөр кэшлэх — Drive рүү дахин дахин хандахгүй
    res.set({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    });
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error(`Зураг (${fileId}) дамжуулахад алдаа гарлаа:`, (err as Error).message);
    res.status(502).json({ error: "Зураг татаж чадсангүй" });
  }
});

export default router;
