// ============================================================================
// TEST HARNESS — бодит сервисүүдийг (order-payment, gateway-settlement, invoice, order) санах ойн fake Prisma дээр ажиллуулна.
//   - `lib/prisma`, `realtime/socket`, gateway (qpay/socialpay), featured/delivery/material-ийн хүнд хамаарлыг сольно.
//   - `@prisma/client` generate хийгдсэн бол БОДИТ enum-ийг ашиглана; байхгүй бол ижил нэртэй string enum-оор орлуулна.
// ⚠️ Сервисийг ЗААВАЛ `load()`-оор (require) оруулна — hook суусны ДАРАА.
// ============================================================================

import Module from "module";
import path from "path";
import { FakeDb } from "./fake-prisma";

export const db = new FakeDb();
export const events: Array<{ event: string; payload: any }> = [];
export const promotionCalls: Array<{ promotionId: string; amount: number; provider: string }> = [];
export const behavior = { promotionFails: 0, realMaterial: false };

export interface FakeGateway {
  checkPayment: (invoiceId: string) => Promise<{ isPaid: boolean; raw: unknown; paidAmount?: number }>;
  createInvoice: (p: any) => Promise<{ invoiceId: string; qrText: string | null; qrImageUrl: string | null }>;
}
let invSeq = 0;
const makeGateway = (): FakeGateway => ({
  // Бодит gateway шиг: нэхэмжилсэн дүнг "яг төлсөн" гэж мэдээлнэ (дүн шалгалт UNVERIFIABLE болохоос сэргийлнэ). Тест хэрэгтэй бол дарж бичнэ.
  checkPayment: async (invoiceId) => {
    const row = db.all("gatewayTransaction").find((r: any) => r.invoiceId === invoiceId);
    return { isPaid: true, raw: { invoiceId, ok: true }, paidAmount: row ? Number(row.amount) : undefined };
  },
  createInvoice: async () => ({ invoiceId: `INV-${++invSeq}`, qrText: "qr", qrImageUrl: null }),
});
export const gateways: Record<"QPAY" | "SOCIALPAY", FakeGateway> = { QPAY: makeGateway(), SOCIALPAY: makeGateway() };

const noop = () => undefined;
const noopProxy = (extra: Record<string, unknown> = {}) =>
  new Proxy(extra, { get: (t, k: string) => (k in t ? (t as any)[k] : k === "__esModule" ? false : class { constructor(..._a: any[]) {} }) });

const enumProxy = () => new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : String(k)) });

let installed = false;
export function install() {
  if (installed) return;
  installed = true;
  let hasPrismaClient = true;
  let hasAxios = true;
  try {
    require.resolve("@prisma/client");
  } catch {
    hasPrismaClient = false;
  }
  try {
    require.resolve("axios"); // node_modules байхгүй орчинд (сүлжээгүй sandbox) л орлуулна
  } catch {
    hasAxios = false;
  }
  // ⚠️ Бодит @prisma/client import хийгдэх үедээ төслийн .env-г өөрөө ачаалж USE_MOCK_GATEWAY=true-г буцааж тавьдаг.
  // Тиймээс ЭХЛЭЭД ачаалчихаад, ДАРАА нь устгана — тест үргэлж хуурамч (stub) gateway-тэй, хөгжүүлэгчийн .env/shell-ээс үл хамаарна.
  if (hasPrismaClient) {
    try {
      require("@prisma/client");
    } catch {
      /* generate хийгдээгүй бол enum-ийн Proxy ашиглана */
    }
  }
  delete process.env.USE_MOCK_GATEWAY;
  const M: any = Module;
  const orig = M._load;
  const src = path.resolve(__dirname, "../../src");
  M._load = function (request: string, parent: any, ...rest: any[]) {
    if (request === "axios" && !hasAxios) return { default: { get: noop, post: noop }, get: noop, post: noop };
    if (request === "@prisma/client" && !hasPrismaClient) return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : enumProxy()) });
    if (request.startsWith(".")) {
      const abs = path.resolve(path.dirname(parent?.filename ?? ""), request);
      if (abs.startsWith(src)) {
        const rel = path.relative(src, abs).replace(/\\/g, "/");
        switch (rel) {
          case "lib/prisma":
            return { prisma: db.client() };
          case "realtime/socket":
            return {
              emitToStore: (_s: string, event: string, payload: any) => events.push({ event, payload }),
              // Курьерийн broadcast/хувийн мэдэгдэл — delivery-assignment тестэд бүртгэнэ (бодит socket байхгүй)
              emitToAllCouriers: (event: string, payload: any, except?: string[]) => events.push({ event, payload: { ...payload, __except: except } }),
              emitToCourier: (courierId: string, event: string, payload: any) => events.push({ event, payload: { ...payload, __to: courierId } }),
            };
          case "lib/push-notifications":
            return noopProxy({ sendPushToAllCouriers: async () => undefined, sendPushToCourier: async () => undefined });
          case "services/delivery-assignment.service":
            // load()-оор ШУУД ачаалбал (ownership тест) бодит сервис; бусад сервисийн хамаарал болбол stub.
            if (parent?.filename === __filename) break;
            return { offerDeliveryToAllCouriers: async () => undefined };
          case "services/featured.service":
            return {
              applyPromotionPayment: async (promotionId: string, amount: number, provider: string) => {
                promotionCalls.push({ promotionId, amount, provider });
                if (behavior.promotionFails > 0) {
                  behavior.promotionFails--;
                  throw new Error("PROMO_FAIL");
                }
                return { activated: true };
              },
            };
          case "services/auth.service":
            // JWT-г биш, role/ownership логикийг турших тул токен = "staff:<id>" гэж хялбарчилсан.
            return {
              verifyStaffToken: (t: string) => {
                if (!t.startsWith("staff:")) throw new Error("bad token");
                return { staffId: t.slice(6), role: "CASHIER", storeId: "default" };
              },
              generateStaffToken: (x: any) => `staff:${x.staffId}`,
            };
          case "services/qpay.service":
            return { qpayService: gateways.QPAY };
          case "services/socialpay.service":
            return { socialpayService: gateways.SOCIALPAY };
          case "services/material.service":
            // behavior.realMaterial=true (load() ХИЙХЭЭС ӨМНӨ тавина) бол БОДИТ сервис — нөөцийн дүрмийг турших тест.
            if (behavior.realMaterial) break;
            return noopProxy({
              consumeMaterialsForOrder: async () => [],
              assertMaterialsAvailable: async () => undefined,
              assertOrdersMaterialsAvailable: async () => undefined,
              MaterialError: class extends Error {},
              quoteMaterial: noop,
            });
          case "services/rental-availability.service":
            return noopProxy({ reserveRentalWithinTx: noop, RentalUnavailableError: class extends Error {} });
        }
      }
    }
    return orig.call(this, request, parent, ...rest);
  };
}

export function load<T = any>(rel: string): T {
  install();
  return require(path.resolve(__dirname, "../../src", rel)) as T;
}

export function reset() {
  for (const k of Object.keys(db.committed)) db.committed[k].clear();
  db.log.length = 0;
  events.length = 0;
  promotionCalls.length = 0;
  behavior.promotionFails = 0;
  gateways.QPAY = Object.assign(gateways.QPAY, makeGateway());
  gateways.SOCIALPAY = Object.assign(gateways.SOCIALPAY, makeGateway());
}

// ---------------------------------------------------------------------------
// SEED helper-үүд
// ---------------------------------------------------------------------------
export function seedProduct(id: string, sellStockQty = 10) {
  return db.seed("product", { id, name: `Бараа ${id}`, sellStockQty, usesMaterialPricing: false });
}

export function seedOrder(o: {
  id: string;
  total: number;
  paid?: number;
  status?: string;
  groupId?: string | null;
  cancelledAt?: Date | null;
  qty?: number;
  productId?: string;
  createdAt?: Date;
}) {
  const productId = o.productId ?? `p-${o.id}`;
  if (!db.get("product", productId)) seedProduct(productId);
  const item = {
    id: `item-${o.id}`,
    orderId: o.id,
    productId,
    itemType: "SALE",
    quantity: o.qty ?? 2,
    materialId: null,
    areaCm2: null,
    product: { id: productId, name: `Бараа ${productId}`, usesMaterialPricing: false },
  };
  db.seed("orderItem", item);
  return db.seed("order", {
    id: o.id,
    orderNumber: `N-${o.id}`,
    orderType: "POS",
    storeId: "default",
    paymentStatus: o.status ?? "PENDING",
    totalAmount: o.total,
    paidAmount: o.paid ?? 0,
    cancelledAt: o.cancelledAt ?? null,
    refundDueAmount: 0,
    refundedAt: null,
    orderGroupId: o.groupId ?? null,
    sellerId: null,
    sellerStatus: null,
    customerId: null,
    customer: null,
    deliveryAssignStatus: "UNASSIGNED",
    createdAt: o.createdAt ?? new Date(),
    items: [item],
  });
}

let gtxSeq = 0;
export function seedGatewayTx(o: {
  id?: string;
  orderId?: string | null;
  amount: number;
  purpose?: string;
  provider?: "QPAY" | "SOCIALPAY";
  status?: string;
  rentalDetailId?: string;
  promotionId?: string;
  combinedDepositRentalIds?: string[];
  createdAt?: Date;
}) {
  const n = ++gtxSeq;
  return db.seed("gatewayTransaction", {
    id: o.id ?? `gtx-${n}`,
    provider: o.provider ?? "QPAY",
    purpose: o.purpose ?? "ORDER_PAYMENT",
    invoiceId: `INVOICE-${n}`,
    senderInvoiceNo: `S-${n}`,
    amount: o.amount,
    status: o.status ?? "PENDING",
    orderId: o.orderId ?? null,
    rentalDetailId: o.rentalDetailId ?? null,
    promotionId: o.promotionId ?? null,
    combinedDepositRentalIds: o.combinedDepositRentalIds ?? [],
    rawCallback: null,
    paidAt: null,
    createdAt: o.createdAt ?? new Date(),
  });
}

export const sumPayments = (orderId: string) =>
  db.all("payment").filter((p) => p.orderId === orderId && p.type === "SALE_PAYMENT").reduce((s, p) => s + Number(p.amount), 0);
export const paymentCount = (orderId: string) => db.all("payment").filter((p) => p.orderId === orderId).length;
export const stockMovements = (productId: string) => db.all("stockMovement").filter((m) => m.productId === productId);
