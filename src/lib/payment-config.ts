// ============================================================================
// PAYMENT CONFIG — QPay/SocialPay тохиргооны оношилгоо (цэвэр логик). Нууц утгыг ХЭЗЭЭ Ч харуулахгүй — зөвхөн нэр, төлөв.
// ============================================================================

import { URL } from "url"; // Node-ийн суурь модуль (глобал URL төрөл бүх tsconfig-д байх албагүй)

export interface GatewayStatus {
  configured: boolean;
  missing: string[];
}

export interface PaymentConfigReport {
  mode: "MOCK" | "REAL";
  qpay: GatewayStatus;
  socialpay: GatewayStatus;
  warnings: string[];
}

const missing = (env: Record<string, string | undefined>, keys: string[]): string[] => keys.filter((k) => !env[k] || !String(env[k]).trim());

export function describePaymentConfig(env: Record<string, string | undefined>): PaymentConfigReport {
  const isProd = env.NODE_ENV === "production";
  const mock = env.USE_MOCK_GATEWAY === "true" && !isProd; // production үед mock АСААХГҮЙ (invoice.service-тэй ижил дүрэм)
  const warnings: string[] = [];
  const qm = missing(env, ["QPAY_USERNAME", "QPAY_PASSWORD", "QPAY_INVOICE_CODE", "QPAY_CALLBACK_URL"]);
  const sm = missing(env, ["SOCIALPAY_BASE_URL", "SOCIALPAY_MERCHANT_ID", "SOCIALPAY_API_KEY", "SOCIALPAY_CALLBACK_URL"]);
  if (env.USE_MOCK_GATEWAY === "true" && isProd) warnings.push("USE_MOCK_GATEWAY=true боловч NODE_ENV=production тул mock АСААГДААГҮЙ (бодит QPay ашиглана)");
  if (!mock) {
    const cb = (env.QPAY_CALLBACK_URL || "").trim();
    if (cb) {
      let u: URL | null = null;
      try { u = new URL(cb); } catch { warnings.push("QPAY_CALLBACK_URL буруу хаяг байна"); }
      if (u) {
        if (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/.test(u.hostname)) warnings.push("QPAY_CALLBACK_URL нь дотоод хаяг (localhost/LAN) — QPay интернэтээс хандаж чадахгүй, төлбөр автоматаар баталгаажихгүй (ngrok эсвэл жинхэнэ домэйн хэрэгтэй)");
        if (u.protocol !== "https:") warnings.push("QPAY_CALLBACK_URL нь https биш — бодит QPay https шаарддаг");
        if (!u.pathname.endsWith("/api/payments/webhook/qpay")) warnings.push("QPAY_CALLBACK_URL нь /api/payments/webhook/qpay-аар төгсөх ёстой");
      }
    }
    const base = (env.QPAY_BASE_URL || "https://merchant.qpay.mn").trim();
    if (base.includes("sandbox")) warnings.push("QPAY_BASE_URL нь SANDBOX (тест) хаяг — бодит мөнгө орохгүй. Бодит ажиллуулахдаа https://merchant.qpay.mn болгоно");
  }
  return { mode: mock ? "MOCK" : "REAL", qpay: { configured: qm.length === 0, missing: qm }, socialpay: { configured: sm.length === 0, missing: sm }, warnings };
}
