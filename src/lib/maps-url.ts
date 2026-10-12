// ============================================================================
// MAPS URL GUARD — /api/maps/resolve нь нэвтрэлтгүй тул сервер талаас хүсэлт явуулахдаа ЗӨВХӨН Google-ийн
// газрын зургийн хаяг руу (https, нууц үг/порт-гүй) явна. Redirect бүрийг гараар дагаж, HOP БҮРД дахин шалгана
// (Google-ийн redirect-ээр дотоод сүлжээ/metadata руу гаргахгүй) — SSRF-ээс хамгаална.
// ============================================================================

import { URL } from "url"; // Node-ийн суурь модуль (gateway-webhook.ts-тэй ижил — глобал URL төрөл бүх tsconfig-д байх албагүй)

const HOST_ALLOWED = [
  /^maps\.app\.goo\.gl$/,
  /^goo\.gl$/,
  /^(?:[a-z0-9-]+\.)*google\.(?:com|mn|com\.mn)$/,
];

export const MAPS_MAX_HOPS = 6;

export function isAllowedMapsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  return HOST_ALLOWED.some((re) => re.test(host));
}

export interface MapsFetchResult {
  status: number;
  location?: string;
  body?: string | null;
}
export type MapsFetcher = (url: string) => Promise<MapsFetchResult>;

/**
 * Redirect-ийг гараар дагаж хуудсыг татна. Зөвшөөрөгдөөгүй хаяг тохиолдвол ТАТАХГҮЙ зогсоно.
 * fetcher нь redirect-ийг АВТОМАТААР дагах ёсгүй (maxRedirects: 0).
 */
export async function resolveMapsPage(startUrl: string, fetcher: MapsFetcher): Promise<{ finalUrl: string; html: string | null; blocked: boolean }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAPS_MAX_HOPS; hop++) {
    if (!isAllowedMapsUrl(current)) return { finalUrl: current, html: null, blocked: true };
    const r = await fetcher(current);
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next: string;
      try {
        next = new URL(r.location, current).toString();
      } catch {
        return { finalUrl: current, html: null, blocked: true };
      }
      current = next;
      continue;
    }
    return { finalUrl: current, html: typeof r.body === "string" ? r.body : null, blocked: false };
  }
  return { finalUrl: current, html: null, blocked: true }; // хэт олон redirect
}
