// ============================================================================
// LIVE TRACKING — Хүргэж яваа курьерийн бодит байршлыг газрын зураг дээр харуулах
// цэвэр логик (DB, сүлжээ хэрэггүй — тест хийхэд хялбар).
//
// Хандалт: нэвтрэлтгүй газрын зургийн хуудас (/track?t=...) нь ГАРЫН ҮСЭГТЭЙ
// (HMAC) токеноор л нээгдэнэ. Токеныг зөвхөн нэвтэрсэн Staff / админ курьер /
// илгээмжийн илгээгч үүсгэнэ, 12 цагийн дараа хүчингүй болно. Токен хоёр төрөлтэй:
//   fleet — БҮХ идэвхтэй хүргэлтийн курьерийг харна (Staff, админ курьер)
//   order — ЗӨВХӨН нэг захиалгын курьерийг харна (илгээмжийн илгээгч)
// Нууцлал: курьерийн байршил ЗӨВХӨН идэвхтэй хүргэлттэй үед л харагдана.
// ============================================================================

import crypto from "crypto";
import { courierDisplayName, CourierStats } from "./courier-identity";

export type TrackingScope = { kind: "fleet" } | { kind: "order"; orderId: string };

export class TrackingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingTokenError";
  }
}

export const TRACKING_TTL_MINUTES = 12 * 60;

const b64u = (v: Uint8Array | string) => Buffer.from(v as any).toString("base64url");

function secretKey(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET тохируулаагүй байна");
  return s + "|live-tracking"; // Нэвтрэлтийн JWT-тэй ижил түлхүүр БИШ (салгасан)
}

export function signTrackingToken(scope: TrackingScope, ttlMinutes: number = TRACKING_TTL_MINUTES, nowMs: number = Date.now()): string {
  const payload = {
    t: "tracking",
    s: scope.kind,
    o: scope.kind === "order" ? scope.orderId : undefined,
    exp: Math.floor(nowMs / 1000) + Math.round(ttlMinutes * 60),
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", secretKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyTrackingToken(token: string, nowMs: number = Date.now()): TrackingScope {
  const bad = () => new TrackingTokenError("Холбоос буруу байна");
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad();

  const expected = crypto.createHmac("sha256", secretKey()).update(parts[0]).digest();
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw bad();

  let payload: { t?: string; s?: string; o?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (payload.t !== "tracking") throw bad();
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
    throw new TrackingTokenError("Холбоосын хугацаа дууссан байна — шинээр үүсгэнэ үү");
  }
  if (payload.s === "fleet") return { kind: "fleet" };
  if (payload.s === "order" && typeof payload.o === "string" && payload.o) return { kind: "order", orderId: payload.o };
  throw bad();
}

// ---------------------------------------------------------------------------
// Илгээмжийн илгээгч өөрийн илгээмжийг хянах эрх
// ---------------------------------------------------------------------------
export function checkErrandTrackingAccess(
  o: { orderType: string; requestingCourierId: string | null; deliveryAssignStatus: string },
  courierId: string
): { ok: boolean; reason?: string } {
  if (o.orderType !== "COURIER_ERRAND" || o.requestingCourierId !== courierId) {
    return { ok: false, reason: "Энэ илгээмжийг зөвхөн илгээгч нь хянах боломжтой" };
  }
  if (o.deliveryAssignStatus !== "ASSIGNED" && o.deliveryAssignStatus !== "PICKED_UP") {
    return { ok: false, reason: "Курьер илгээмжийг авсны дараа, хүргэж дуустал л байршил харагдана" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Байршлын snapshot (газрын зургийн хуудас 5 сек тутам авна)
// ---------------------------------------------------------------------------
export const ACTIVE_TRACKING_STATUSES = ["ASSIGNED", "PICKED_UP", "GIVEN", "RETURN_PICKED_UP"];
/** GIVEN (түрээс өгсөн, буцаах хүртэл хэдэн хоног) үед курьер үнэхээр хөдөлгөөнтэй л бол харуулна. */
const GIVEN_MAX_AGE_SECONDS = 600;

export interface ShopInfo {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface TrackedOrderRow {
  id: string;
  orderNumber: string;
  orderType: string;
  deliveryAssignStatus: string;
  deliveryAddress: string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  pickupAddress: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  courier: {
    id: string;
    name: string;
    nickname?: string | null;
    vehiclePlate?: string | null;
    currentLatitude: number | null;
    currentLongitude: number | null;
    currentLocationUpdatedAt: Date | string | null;
  } | null;
}

export interface SnapshotOptions {
  /** true бол бүртгэлтэй (жинхэнэ) нэр орно — зөвхөн Staff/админ (fleet). Илгээгч/харилцагчид ЗӨВХӨН nickname харагдана. */
  includeRealName?: boolean;
  stats?: Map<string, CourierStats>;
}

export function buildLiveSnapshot(rows: TrackedOrderRow[], shop: ShopInfo | null, nowMs: number = Date.now(), opts: SnapshotOptions = {}) {
  const byCourier = new Map<string, any>();

  for (const o of rows) {
    if (!o.courier) continue;
    if (!ACTIVE_TRACKING_STATUSES.includes(o.deliveryAssignStatus)) continue;

    const updatedMs = o.courier.currentLocationUpdatedAt ? new Date(o.courier.currentLocationUpdatedAt).getTime() : null;
    const ageSeconds = updatedMs != null ? Math.max(0, Math.round((nowMs - updatedMs) / 1000)) : null;
    if (o.deliveryAssignStatus === "GIVEN" && (ageSeconds == null || ageSeconds > GIVEN_MAX_AGE_SECONDS)) continue;

    let entry = byCourier.get(o.courier.id);
    if (!entry) {
      const hasLocation = o.courier.currentLatitude != null && o.courier.currentLongitude != null && updatedMs != null;
      const stat = opts.stats?.get(o.courier.id);
      entry = {
        courierId: o.courier.id,
        displayName: courierDisplayName(o.courier), // Нийтэд харагдах нэр (nickname)
        ...(opts.includeRealName ? { name: o.courier.name } : {}),
        vehiclePlate: o.courier.vehiclePlate ?? null,
        ratingAverage: stat?.ratingAverage ?? null,
        ratingCount: stat?.ratingCount ?? 0,
        completedDeliveries: stat?.completedDeliveries ?? 0,
        latitude: hasLocation ? o.courier.currentLatitude : null,
        longitude: hasLocation ? o.courier.currentLongitude : null,
        updatedAt: updatedMs != null ? new Date(updatedMs).toISOString() : null,
        ageSeconds,
        deliveries: [],
      };
      byCourier.set(o.courier.id, entry);
    }

    const isErrand = o.orderType === "COURIER_ERRAND";
    entry.deliveries.push({
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.deliveryAssignStatus,
      isErrand,
      // Энгийн (дэлгүүрийн бараа) хүргэлтийн авах цэг ҮРГЭЛЖ "Дэлгүүр"; илгээмжийнх — илгээгчийн бичсэн хаяг
      pickup: {
        label: isErrand ? "Авах цэг" : "Дэлгүүр",
        address: isErrand ? o.pickupAddress : shop?.address ?? null,
        latitude: isErrand ? o.pickupLatitude : shop?.latitude ?? null,
        longitude: isErrand ? o.pickupLongitude : shop?.longitude ?? null,
      },
      destination: { address: o.deliveryAddress, latitude: o.deliveryLatitude, longitude: o.deliveryLongitude },
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    shop: shop ? { name: "Дэлгүүр", ...shop } : null,
    couriers: Array.from(byCourier.values()),
  };
}

// ---------------------------------------------------------------------------
// Газрын зургийн tile тохиргоо. Анхдагч — OpenStreetMap; ихэвчлэн гэнэт ачаалал
// ихсэх/блоклогдох эрсдэлтэй тул .env-д MAP_TILE_URL өгч арилжааны үйлчилгээ
// (MapTiler, Stadia, Mapbox г.м.) руу КОД ӨӨРЧИЛӨХГҮЙ шилжиж болно.
// ---------------------------------------------------------------------------
export interface TileConfig {
  urlTemplate: string;
  attribution: string;
  maxZoom: number;
}

const OSM_TILES: TileConfig = {
  urlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
};

export function tileConfigFromEnv(env: Record<string, string | undefined>): TileConfig {
  const url = (env.MAP_TILE_URL ?? "").trim();
  if (!url) return { ...OSM_TILES };
  const valid = /^https:\/\//.test(url) && url.includes("{z}") && url.includes("{x}") && url.includes("{y}");
  if (!valid) {
    console.warn("MAP_TILE_URL буруу (https:// ба {z}/{x}/{y} шаардлагатай) — OpenStreetMap ашиглана");
    return { ...OSM_TILES };
  }
  const maxZoom = Number(env.MAP_TILE_MAX_ZOOM);
  return {
    urlTemplate: url,
    attribution: (env.MAP_TILE_ATTRIBUTION ?? "").trim() || "© Map data providers",
    maxZoom: Number.isFinite(maxZoom) && maxZoom >= 1 && maxZoom <= 22 ? Math.round(maxZoom) : 19,
  };
}
