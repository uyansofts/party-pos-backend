"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_1 = require("./realtime/socket");
const payment_controller_1 = __importDefault(require("./controllers/payment.controller"));
const rental_controller_1 = __importDefault(require("./controllers/rental.controller"));
const product_controller_1 = __importDefault(require("./controllers/product.controller"));
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use("/api/payments", payment_controller_1.default);
app.use("/api/rentals", rental_controller_1.default);
app.use("/api/products", product_controller_1.default);
// -------- Глобал error handler (сүүлчийн хамгаалалт) --------
app.use((err, _req, res, _next) => {
    console.error("Барьцгүй алдаа:", err);
    res.status(500).json({ error: "Серверийн алдаа гарлаа" });
});
const httpServer = http_1.default.createServer(app);
// Socket.io-г http сервер дээр эхлүүлнэ (app.listen биш!)
(0, socket_1.initSocket)(httpServer);
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
//# sourceMappingURL=server.js.map