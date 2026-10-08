// ============================================================================
// DELIVERY ZONE UTILS — Дэлгүүрийн байршлаас (shopLatitude/shopLongitude)
// харилцагчийн хүргэлтийн цэг хүртэлх ЗАМЫН БОДИТ ЗАЙГААР (Google Routes
// API) А/Б бүсийг АВТОМАТААР, ХАТУУ тодорхойлно.
// ----------------------------------------------------------------------------
// ✅ ЗАСВАР: Шулуун зай (Haversine) нь гол/уул/тойрог замыг тооцдоггүй тул
// бодит байдлаас хол байсан. Одоо Google Routes API (Compute Route Matrix)
// ашиглаж, ЖОЛООЧИЙН ЗАМЫН ЗАЙГААР тооцно. Google API амжилтгүй болвол
// (сүлжээ тасрах, quota дуусах г.м.) Haversine рүү АЮУЛГҮЙ буцна (fallback)
// — хэзээ ч захиалга бүхэлдээ бүтэлгүйтэхгүй.
// ----------------------------------------------------------------------------
// Дүрэм: Дэлгүүрийн тохиргоо дахь "zoneAAutoRadiusKm" радиусын ДОТОР бол
// Бүс А, ГАДНА бол Бүс Б (одоо "радиус" гэдэг нь ЗАМЫН км-ээр хэмжигдэнэ).
// ============================================================================

import axios from "axios";

/**
 * Хоёр координатын хоорондох ШУЛУУН зайг километрээр тооцно (Haversine
 * томъёо) — Google Routes API амжилтгүй болсон үед л ашиглагдана (fallback).
 */
export function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Дэлхийн радиус (км)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * ✅ ШИНЭ: Google Routes API (Compute Route Matrix)-аар ЖОЛООЧИЙН ЗАМЫН
 * (машины) бодит зайг тооцно. Амжилтгүй бол null буцаана (дуудагч тал
 * Haversine руу шилжинэ).
 */
export async function computeRoadDistanceKm(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<number | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null; // Key тохируулаагүй бол шууд Haversine рүү

  try {
    const response = await axios.post(
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      {
        origins: [{ waypoint: { location: { latLng: { latitude: originLat, longitude: originLng } } } }],
        destinations: [{ waypoint: { location: { latLng: { latitude: destLat, longitude: destLng } } } }],
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE", // Урсгал тооцохгүй — хямд "Basic" зэрэглэлд байлгана
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition",
        },
        timeout: 8000, // 8 секундэд хариу ирэхгүй бол Haversine рүү шилжинэ
      }
    );

    const results = response.data as Array<{ distanceMeters?: number; condition?: string }>;
    const match = results.find((r) => r.condition === "ROUTE_EXISTS" && r.distanceMeters != null);
    if (!match || match.distanceMeters == null) return null;

    return match.distanceMeters / 1000; // метрээс километр рүү
  } catch (err) {
    console.error("Routes API дуудахад алдаа гарлаа:", err);
    return null; // Fallback — Haversine ашиглагдана
  }
}

export interface ZoneFeeSettings {
  shopLatitude: number | null;
  shopLongitude: number | null;
  zoneAAutoRadiusKm: number;
  saleZoneAFee: number;
  saleZoneBFee: number;
  rentalZoneAFee: number;
  rentalZoneBFee: number;
  localTransportFee: number;
}

/**
 * Дэлгүүрийн байршлаас хүргэлтийн цэг хүртэлх ЗАМЫН БОДИТ зайг (эсвэл
 * амжилтгүй бол шулуун зайг) тооцож, тохирох хүргэлтийн төлбөрийг
 * (Бүс А/Б) АВТОМАТААР сонгоно.
 * ----------------------------------------------------------------------------
 * - Дэлгүүрийн байршил тохируулаагүй бол null буцаана (дуудагч тал
 *   client-ийн илгээсэн дүнг хэрэглэнэ — хуучин зан төлөвтэй нийцнэ).
 * - hasRental=true бол rentalZoneA/BFee, эсвэл saleZoneA/BFee ашиглана.
 */
export async function computeAutoDeliveryFee(
  deliveryLat: number,
  deliveryLng: number,
  hasRental: boolean,
  settings: ZoneFeeSettings
): Promise<{ fee: number; zone: "A" | "B"; distanceKm: number; source: "road" | "straight" } | null> {
  if (settings.shopLatitude == null || settings.shopLongitude == null) {
    return null; // Дэлгүүрийн байршил тохируулаагүй — автоматаар тооцох боломжгүй
  }

  // ✅ ЗАСВАР: Эхлээд ЗАМЫН БОДИТ зайг (Google Routes API) оролдоно.
  let distanceKm = await computeRoadDistanceKm(settings.shopLatitude, settings.shopLongitude, deliveryLat, deliveryLng);
  let source: "road" | "straight" = "road";

  if (distanceKm == null) {
    // Fallback — Google API амжилтгүй бол шулуун зай ашиглана
    distanceKm = haversineDistanceKm(settings.shopLatitude, settings.shopLongitude, deliveryLat, deliveryLng);
    source = "straight";
  }

  const isZoneA = distanceKm <= settings.zoneAAutoRadiusKm;
  const zone: "A" | "B" = isZoneA ? "A" : "B";

  const fee = hasRental
    ? isZoneA
      ? settings.rentalZoneAFee
      : settings.rentalZoneBFee
    : isZoneA
    ? settings.saleZoneAFee
    : settings.saleZoneBFee;

  return { fee, zone, distanceKm, source };
}
