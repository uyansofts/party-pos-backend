// ============================================================================
// DELIVERY BOUNDARY UTILS — "Дэлгүүрийн хүргэлт"-ийн бүсийг ДУРЫН ТООНЫ
// цэгээс (DeliveryBoundaryPoint) тооцоолсон ОЛОН БУЛАНТ (polygon)
// хэлбэрээр шалгана.
// ----------------------------------------------------------------------------
// ✅ ЗАСВАР 2: Төв цэгээс өнцгөөр АВТОМАТААР эрэмблэх арга (angular sort)
// зөвхөн ГҮДГЭР (convex) хэлбэрт л зөв ажилладаг байсан. Бодит тойргийн
// зам (жишээ нь Улаанбаатарын тойрог) ХОТГОР-ГҮДГЭР (concave) олон
// хэсэгтэй тул автомат эрэмбэ БУРУУ (өөртэйгээ огтлолцсон) полигон
// гаргадаг байсан. Одоо АВТОМАТ ЭРЭМБИЙГ БҮРМӨСӨН ХАССАН — staff
// ӨӨРИЙНХӨӨ НЭМСЭН ДАРААЛАЛААР (тойргоор жолоодож явахдаа дараалан
// бөглөх шиг) полигон болгоно. POS дээр дараалал өөрчлөх (дээш/доош)
// боломжтой.
// ============================================================================

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Өгөгдсөн цэгүүдийг ЯГ ӨГӨГДСӨН ДАРААЛАЛААР нь полигон болгоно —
 * ямар ч автомат дахин эрэмблэлт хийхгүй. Дуудагч тал (backend controller)
 * цэгүүдийг ЗӨВ ГЕОГРАФИЙН дараалалтай (жишээ нь тойргоор дараалан)
 * ирүүлэх ёстой.
 */
export function computeDeliveryPolygon(points: LatLng[]): LatLng[] | null {
  if (points.length < 3) {
    return null; // 3-аас цөөн цэгээр хаалттай дүрс (полигон) үүсгэх боломжгүй
  }
  return points;
}

/**
 * Стандарт "ray casting" алгоритм — өгөгдсөн цэг polygon-ы дотор эсэхийг
 * шалгана (координатаас хэвтээ шугам татаад, polygon-ийн ирмэгүүдийг
 * хэдэн удаа гаталж байгааг тоолж, сондгой удаа бол дотор гэж үздэг).
 */
export function isWithinDeliveryPolygon(lat: number, lng: number, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat;
    const yi = polygon[i].lng;
    const xj = polygon[j].lat;
    const yj = polygon[j].lng;

    const intersects = yi > lng !== yj > lng && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
