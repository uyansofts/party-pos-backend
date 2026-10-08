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
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
  })
);
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
  skip: (req) => req.path === "/materials/quote", // ✅ ШИНЭ — материалын урьдчилсан үнэ тусдаа (илүү өндөр) хязгаартай
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});
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
