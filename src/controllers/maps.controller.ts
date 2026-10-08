// ============================================================================
// MAPS CONTROLLER — Google Maps линкийг задлаж (Lat/Lng) координат гаргаж
// авна. Богино холбоос (maps.app.goo.gl, goo.gl/maps) бол СЕРВЕР ТАЛ дээр
// redirect-ийг дагаж бодит URL-ийг олно (browser CORS-оос болж клиент
// талд боломжгүй байсан).
// ----------------------------------------------------------------------------
// ✅ ЗАСВАР: Google Maps-ийн линкийн формат олон янз (@lat,lng, q=, ll=,
// !3d!4d, зарим тохиолдолд урвуу !1d!2d, эсвэл ЗӨВХӨН хуудасны HTML
// доторх JS өгөгдөлд л координат байдаг) тул ганцхан regex хангалтгүй
// байсан — олон pattern дараалан оролдож, олдохгүй бол ХУУДАСНЫ БҮХ
// HTML-ээс ч хайдаг болгосон. Монголын бүсийн (lat 41-52, lng 87-120)
// боломжит утгыг л зөвшөөрч, санамсаргүй тоо таарахаас сэргийлнэ.
// ============================================================================

import { Router, Request, Response } from "express";
import axios from "axios";

const router = Router();

// Монгол улсын бүсийн ойролцоо хязгаар — үүнээс гадуурх "координат шиг"
// тоог (жишээ нь zoom level, ID гэх мэт) буруу таньж авахаас сэргийлнэ.
const MN_LAT_RANGE: [number, number] = [41, 52];
const MN_LNG_RANGE: [number, number] = [87, 120];

function isPlausibleMnCoord(lat: number, lng: number): boolean {
  return lat >= MN_LAT_RANGE[0] && lat <= MN_LAT_RANGE[1] && lng >= MN_LNG_RANGE[0] && lng <= MN_LNG_RANGE[1];
}

/**
 * Богино холбоос (maps.app.goo.gl/goo.gl/maps) бол redirect-ийг дагаж
 * бодит (урт) URL БОЛОН хуудасны HTML-ийг буцаана.
 */
async function fetchResolvedPage(url: string): Promise<{ finalUrl: string; html: string | null }> {
  try {
    const response = await axios.get(url, {
      maxRedirects: 8,
      validateStatus: () => true,
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    const finalUrl = (response.request as any)?.res?.responseUrl || url;
    const html = typeof response.data === "string" ? response.data : null;
    return { finalUrl, html };
  } catch (err) {
    console.error("Maps линк татахад алдаа гарлаа:", err);
    return { finalUrl: url, html: null };
  }
}

/** Өгөгдсөн текст (URL эсвэл HTML) дотроос Lat/Lng координатыг ялгаж авна. */
function extractLatLng(text: string): { latitude: number; longitude: number } | null {
  // ✅ ЗАСВАР: "Газрын нэртэй" (place) линкэд @lat,lng нь зөвхөн ЗУРГИЙН
  // ХАРАГДАХ ТӨВ (заримдаа бодит байршлаас хазайдаг) байдаг бол !3d!4d
  // нь ЯГ БОДИТ pin-ий координат (илүү нарийвчлалтай) тул ЭНЭ Л эхэлж
  // шалгагдана.
  const patterns = [
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/, // !3dLAT!4dLNG — ГАЗРЫН БОДИТ pin (хамгийн нарийвчлалтай)
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, // .../@47.12,106.12,15z/... — зургийн харагдах төв (fallback)
    /[?&](?:q|ll|daddr|saddr)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, // ?q=47.12,106.12
    /\/search\/(-?\d{1,3}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/, // ✅ ШИНЭ — .../maps/search/47.12,+106.12 (шууд координатаар "хайлт")
    /!1d(-?\d{1,3}\.\d+)!2d(-?\d{1,3}\.\d+)/, // !1dLNG!2dLAT (зарим үед урвуу) — доор эргүүлнэ
    /"latitude":(-?\d{1,3}\.\d+),"longitude":(-?\d{1,3}\.\d+)/, // JSON өгөгдөл доторх
    /center=(-?\d{1,3}\.\d+)%2C(-?\d{1,3}\.\d+)/, // URL-encode хийсэн центр цэг
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (!match) continue;

    let lat = parseFloat(match[1]);
    let lng = parseFloat(match[2]);

    // "!1d!2d" pattern нь ихэвчлэн (lng, lat) дарааллаар ирдэг тул эргүүлнэ
    if (i === 4) [lat, lng] = [lng, lat]; // ✅ ЗАСВАР — !1d!2d pattern индекс 4 болсон (шинэ /search/ pattern 3 болсон тул)

    if (isPlausibleMnCoord(lat, lng)) {
      return { latitude: lat, longitude: lng };
    }
    // Монголын бүсэд тохирохгүй бол дараагийн pattern-ийг оролдоно (буруу таарал)
  }

  return null;
}

// ============================================================================
// POST /api/maps/resolve — Google Maps линкээс координат гаргаж авна
// body: { url: string }
// ============================================================================
router.post("/resolve", async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: "url заавал шаардлагатай" });
    }

    // 1. Эхлээд өгөгдсөн URL дотроос шууд хайна (богино холбоос биш бол хурдан олдоно)
    let coords = extractLatLng(url);

    // 2. Олдоогүй бол redirect-ийг дагаад бодит URL-аас дахин хайна
    let finalUrl = url;
    let html: string | null = null;
    if (!coords) {
      const resolved = await fetchResolvedPage(url);
      finalUrl = resolved.finalUrl;
      html = resolved.html;
      coords = extractLatLng(finalUrl);
    }

    // 3. URL-аас олдоогүй бол хуудасны БҮХ HTML-аас хайна (зарим үед
    //    координат зөвхөн хуудасны JS өгөгдөлд байдаг, URL-д байдаггүй)
    if (!coords && html) {
      coords = extractLatLng(html);
    }

    if (!coords) {
      return res.json({
        success: false,
        error:
          "Энэ линкээс координат олж чадсангүй. Google Maps дээрээ БАЙРШЛЫГ ТЭМДЭГ (pin) болгож дараад дахин 'Хуваалцах' хийж үзнэ үү, эсвэл 'Гараар оруулах' сонголтыг ашиглана уу.",
      });
    }

    res.json({ success: true, latitude: coords.latitude, longitude: coords.longitude });
  } catch (err) {
    console.error("Maps линк задлахад алдаа гарлаа:", err);
    res.status(500).json({ success: false, error: "Линк задлаж чадсангүй" });
  }
});

export default router;
