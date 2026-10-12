// ============================================================================
// SERVER ENTRYPOINT (TypeScript)
// ----------------------------------------------------------------------------
// ЧУХАЛ: Socket.io нь Express app дээр биш, RAW http.Server дээр суурилдаг
// тул express app-аа http.createServer()-т ХАВСАРГАЖ, ТҮҮН дээрээ
// initSocket() дуудна.
//
// package.json-д шаардлагатай dependency-үүд:
//   express, cors, dotenv, axios, jsonwebtoken, socket.io, @prisma/client
// dev dependency-үүд:
//   typescript, ts-node-dev, @types/express, @types/node, @types/jsonwebtoken, prisma
// ============================================================================

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import http from "http";
import { initSocket } from "./realtime/socket";
import { parseAllowedOrigins } from "./lib/cors-origins";

import paymentRoutes from "./controllers/payment.controller";
import rentalRoutes from "./controllers/rental.controller";
import productRoutes from "./controllers/product.controller";
import sellerRoutes from "./controllers/seller.controller"; // ✅ ШИНЭ — Etsy шиг marketplace: худалдагч
import sellerOrderRoutes from "./controllers/seller-order.controller"; // ✅ ШИНЭ — худалдагчийн захиалга (Staff)
import { startSellerOrderExpiryJob } from "./services/seller-order.service";
import sellerPortalRoutes from "./controllers/seller-portal.controller"; // ✅ ШИНЭ — худалдагчийн портал (seller.html)
import uploadRoutes from "./controllers/upload.controller"; // ✅ ШИНЭ — зураг файлаар оруулах (Staff)
import reviewRoutes from "./controllers/review.controller"; // ✅ ШИНЭ — үнэлгээ хянах (Staff)
import dashboardRoutes from "./controllers/dashboard.controller"; // ✅ ШИНЭ — POS-ын хяналтын самбар
import featuredRoutes from "./controllers/featured.controller"; // ✅ ШИНЭ — онцлох байрлалын багц, зар (Staff)
import { startFeaturedExpiryJob } from "./services/featured.service";
import { describePaymentConfig } from "./lib/payment-config";
import orderRoutes from "./controllers/order.controller";
import authRoutes from "./controllers/auth.controller";
import customerRoutes from "./controllers/customer.controller";
import categoryRoutes from "./controllers/category.controller";
import publicRoutes from "./controllers/public.controller";
import { customerTrackingRouter } from "./controllers/customer-tracking.controller"; // ✅ ШИНЭ — storefront захиалгын хяналт
import imageProxyRoutes from "./controllers/image-proxy.controller";
import settingsRoutes from "./controllers/settings.controller";
import mapsRoutes from "./controllers/maps.controller";
import courierAuthRoutes from "./controllers/courier-auth.controller";
import customOrdersRoutes from "./controllers/custom-orders.controller";
import materialsRoutes from "./controllers/materials.controller"; // ✅ ШИНЭ
import productionRoutes from "./controllers/production.controller"; // ✅ ШИНЭ — зүсэлтийн тооцоолуур / nesting / багцын тоо (Staff нэвтрэлттэй)
import { staffCourierRouter, courierSelfRouter } from "./controllers/courier.controller";
import { trackingRouter } from "./controllers/tracking.controller"; // ✅ ШИНЭ — бодит цагийн байршлын газрын зураг
import { initPushNotifications } from "./lib/push-notifications";
import { startDeliveryAlertWatcher } from "./services/delivery-watcher.service";

const app = express();

// ---------------------------------------------------------------------------
// CORS: Flutter Web (localhost:PORT өөр), онлайн дэлгүүрийн frontend
// зэрэг ӨӨР ORIGIN-с ирэх REST хүсэлтийг зөвшөөрнө. ALLOWED_ORIGINS-г .env-д
// тааруулж болно (тайлбарыг доор харна уу); байхгүй бол хөгжүүлэлтэд ЯМАРЧ
// origin-ийг зөвшөөрнө ("*").
// ---------------------------------------------------------------------------
// ✅ ЗАСВАР: reverse proxy (Render/Fly/nginx...)-ийн ард ажиллаж байвал TRUST_PROXY=1 тавина — эс бөгөөс БҮХ хэрэглэгч proxy-ийн
// ИЖИЛ IP-тэй харагдаж, rate-limit нэгдсэн нэг хувин болно (100 хүсэлт/15 мин БҮХ хэрэглэгчид нийлээд). Тохируулаагүй бол өмнөх үйлдэл хэвээр.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY.trim();
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp);
}
const corsOrigin = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
if (corsOrigin === "*" && process.env.NODE_ENV === "production") {
  console.warn("⚠️  ALLOWED_ORIGINS тохируулаагүй — production дээр ямар ч origin-д CORS нээлттэй байна. .env-д ALLOWED_ORIGINS=https://таны-домэйн тавина уу.");
}
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "6mb" })); // ✅ Хүргэлтийн баталгаажуулах зураг (base64) багтахын тулд

app.use("/api/auth", authRoutes); // НЭЭЛТТЭЙ — нэвтрэхийн өмнө JWT байхгүй тул
app.use("/api/payments", paymentRoutes);
app.use("/api/rentals", rentalRoutes);
app.use("/api/products", productRoutes);
app.use("/api/sellers", sellerRoutes); // ✅ ШИНЭ — Staff худалдагч удирдах
app.use("/api/uploads", uploadRoutes); // ✅ ШИНЭ — зураг upload (Staff, raw bytes)
app.use("/api/reviews", reviewRoutes); // ✅ ШИНЭ — үнэлгээ хяналт (Staff)
app.use("/api/dashboard", dashboardRoutes); // ✅ ШИНЭ — хяналтын самбар (Staff)
app.use("/api/featured", featuredRoutes); // ✅ ШИНЭ — онцлох байрлал (Staff)
app.use("/api/seller-portal", sellerPortalRoutes); // ✅ ШИНЭ — худалдагчийн өөрийн портал (өөрийн JWT, өөрийн rate-limit)
app.use("/api/seller-orders", sellerOrderRoutes); // ✅ ШИНЭ — худалдагчийн захиалга: зөвшөөрөх/бэлэн/татгалзах
app.use("/api/orders", orderRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/categories", categoryRoutes);

// ---------------------------------------------------------------------------
// /api/public/*: Staff эрхгүй, гаднын ХЭН Ч хандах боломжтой тул rate-limit
// заавал тавина (15 минутанд IP тутамд дээд тал нь 100 хүсэлт) — спам
// захиалга, DDoS-ийн эрсдэлээс хамгаална.
// ---------------------------------------------------------------------------
const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // /materials/quote — тусдаа (илүү өндөр) хязгаартай. /payments/status — storefront 3 сек тутам асууна (15 мин-д ~300) тул
  // нийтлэг 100/15мин хязгаарт 5 минутын дотор хүрч төлбөрийн төлөв харагдахаа болино → доорх тусдаа хязгаартай.
  skip: (req) => req.path === "/materials/quote" || req.path.startsWith("/payments/status/"),
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});
const paymentStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // минутад 60 (3 сек тутмын polling = 20/мин, олон таб/төхөөрөмжид ч хангалттай)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});
app.use("/api/public/payments/status", paymentStatusLimiter);

// /api/maps/resolve нэвтрэлтгүй, гадагш HTTP хүсэлт явуулдаг тул тусдаа хатуу хязгаар (минутад 20).
app.use("/api/maps", rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." } }));
app.use("/api/public/order-tracking", customerTrackingRouter); // ✅ ШИНЭ — өөрийн rate-limit-тэй, токентой
app.use("/api/public", publicApiLimiter, publicRoutes);

// ---------------------------------------------------------------------------
// /api/images/:fileId — Google Drive-ийн зургийг манай сервэрээр дамжуулж,
// CORS-ийн асуудлыг бүрмөсөн арилгана. Public (auth шаардахгүй) — Каталог,
// Storefront хоёул зураг харуулах ёстой тул.
// ---------------------------------------------------------------------------
app.use("/api/images", imageProxyRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/maps", mapsRoutes);
app.use("/api/courier-auth", courierAuthRoutes); // Нээлттэй (нэвтрэх endpoint)
app.use("/api/custom-orders", customOrdersRoutes); // ✅ ШИНЭ
app.use("/api/materials", materialsRoutes); // ✅ ШИНЭ — Материал (Staff нэвтрэлттэй)
app.use("/api/production", productionRoutes); // ✅ ШИНЭ — Cricut/лазер тооцоолуур, nesting, SVG экспорт (Staff нэвтрэлттэй, DB-д бичихгүй)
app.use("/api/couriers", staffCourierRouter); // Staff-д зориулсан удирдлага
app.use("/api/courier", courierSelfRouter); // Курьер өөрөө ашиглана
app.use("/", trackingRouter); // ✅ ШИНЭ — /track (хуудас), /api/track/data (токентой)

// -------- Глобал error handler (сүүлчийн хамгаалалт) --------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Барьцгүй алдаа:", err);
  res.status(500).json({ error: "Серверийн алдаа гарлаа" });
});

const httpServer = http.createServer(app);

// Socket.io-г http сервер дээр эхлүүлнэ (app.listen биш!)
initSocket(httpServer);

// ✅ ШИНЭ: Firebase-ийг ЭНД шууд шалгаж, лог хэвлэнэ — тохиргоог шалгахын
// тулд жинхэнэ захиалга үүсгэх шаардлагагүй болно.
initPushNotifications();
startDeliveryAlertWatcher(); // ✅ ШИНЭ — Хүргэлтийн хяналт (удаан хүлээлт, түрээсийн сануулга)
startSellerOrderExpiryJob(); // ✅ ШИНЭ — Худалдагч хугацаандаа зөвшөөрөөгүй захиалгыг автоматаар цуцална
startFeaturedExpiryJob(); // ✅ ШИНЭ — Төлбөртэй онцлох байрлалын хугацаа дуусахад автоматаар унтраана
// ✅ ШИНЭ: Төлбөрийн (QPay) тохиргооны оношилгоо — эхлэхэд терминалд харуулна (нууц утгыг харуулахгүй)
{
  const pc = describePaymentConfig(process.env);
  console.log(`💳 Төлбөр: ${pc.mode === "MOCK" ? "MOCK горим (хуурамч, зөвхөн тест)" : "БОДИТ"} | QPay: ${pc.qpay.configured ? "тохирсон ✅" : "ДУТУУ ❌ — " + pc.qpay.missing.join(", ")}`);
  for (const w of pc.warnings) console.warn(`⚠️  ${w}`);
}

// JWT_SECRET нь ажилтан/курьер/худалдагчийн токен БОЛОН харилцагчийн хяналтын токены гарын үсгийн ГАНЦ түлхүүр.
// Байхгүй бол нэвтрэлт, захиалгын токен бүгд унана; богино бол таамаглах боломжтой болно — эхлэхэд анхааруулна.
{
  const js = process.env.JWT_SECRET;
  if (!js) console.error("❌ JWT_SECRET тохируулаагүй байна — нэвтрэлт болон захиалгын хяналтын токен ажиллахгүй (.env-д санамсаргүй 32+ тэмдэгт тавина уу)");
  else if (js.length < 32) console.warn("⚠️  JWT_SECRET 32 тэмдэгтээс богино байна — санамсаргүй урт утга (жишээ нь `openssl rand -hex 32`) ашиглана уу");
}

const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, () => {
  console.log(`Сервер ${PORT} порт дээр ажиллаж эхэллээ (REST + WebSocket)`);
});

// -------- Хүлээгдээгүй алдааг барьж, процессыг гэнэт унагаахгүй байх --------
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
