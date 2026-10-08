import { prisma } from "../lib/prisma";
import { getCourierStats } from "./courier-stats.service";
import { ACTIVE_TRACKING_STATUSES, buildLiveSnapshot, TrackingScope, TrackingTokenError, ShopInfo, tileConfigFromEnv } from "../lib/live-tracking";

const courierSelect = { id: true, name: true, nickname: true, vehiclePlate: true, currentLatitude: true, currentLongitude: true, currentLocationUpdatedAt: true };

/** Токены хүрээнд тохирох байршлын snapshot. fleet — бүх идэвхтэй хүргэлт; order — зөвхөн тэр захиалга. */
export async function fetchLiveSnapshot(scope: TrackingScope, nowMs: number = Date.now()) {
  const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const shop: ShopInfo | null = settings
    ? { address: settings.shopAddress ?? null, latitude: settings.shopLatitude ?? null, longitude: settings.shopLongitude ?? null }
    : null;

  if (scope.kind === "fleet") {
    const rows = await prisma.order.findMany({
      where: { deliveryAssignStatus: { in: ACTIVE_TRACKING_STATUSES as any }, courierId: { not: null } },
      include: { courier: { select: courierSelect } },
    });
    const stats = await getCourierStats((rows as any[]).map((r) => r.courier?.id).filter(Boolean));
    return { scope: "fleet" as const, finished: false, tiles: tileConfigFromEnv(process.env), ...buildLiveSnapshot(rows as any, shop, nowMs, { includeRealName: true, stats }) };
  }

  const order = await prisma.order.findUnique({
    where: { id: scope.orderId },
    include: { courier: { select: courierSelect } },
  });
  if (!order) throw new TrackingTokenError("Захиалга олдсонгүй");
  const finished = !ACTIVE_TRACKING_STATUSES.includes(order.deliveryAssignStatus);
  return {
    scope: "order" as const,
    orderNumber: order.orderNumber,
    status: order.deliveryAssignStatus,
    finished,
    tiles: tileConfigFromEnv(process.env),
    ...buildLiveSnapshot([order] as any, shop, nowMs, { includeRealName: false, stats: await getCourierStats([(order as any).courier?.id].filter(Boolean)) }),
  };
}
