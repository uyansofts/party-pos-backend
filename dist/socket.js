"use strict";
// ============================================================================
// REALTIME / SOCKET.IO CORE (TypeScript)
// ============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.getIO = getIO;
exports.emitToStore = emitToStore;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
let ioInstance = null;
function initSocket(httpServer) {
    ioInstance = new socket_io_1.Server(httpServer, {
        cors: {
            origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
            methods: ["GET", "POST"],
        },
    });
    // -------- Auth middleware: зөвхөн баталгаажсан кассын апп холбогдоно --------
    ioInstance.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token)
                return next(new Error("AUTH_TOKEN_MISSING"));
            const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            socket.data.staffId = payload.staffId;
            socket.data.storeId = payload.storeId || "default";
            next();
        }
        catch (err) {
            next(new Error("AUTH_INVALID"));
        }
    });
    ioInstance.on("connection", (socket) => {
        const room = `pos::${socket.data.storeId}`;
        socket.join(room);
        console.log(`[socket] ПОС холбогдлоо: staffId=${socket.data.staffId}, room=${room}`);
        socket.on("disconnect", (reason) => {
            console.log(`[socket] ПОС салгалаа: staffId=${socket.data.staffId}, шалтгаан=${reason}`);
        });
    });
    return ioInstance;
}
function getIO() {
    if (!ioInstance) {
        throw new Error("Socket.io хараахан эхлээгүй байна — initSocket(server)-ийг эхлээд дуудна уу");
    }
    return ioInstance;
}
/**
 * Тодорхой дэлгүүрийн бүх кассанд event илгээх туслах функц.
 * Realtime мэдэгдэл амжилтгүй болсон нь захиалгын процессыг ЗОГСООХ
 * шалтгаан БОЛОХГҮЙ тул try-catch-аар бүрэн хамгаалав.
 */
function emitToStore(storeId, eventName, payload) {
    try {
        const io = getIO();
        io.to(`pos::${storeId}`).emit(eventName, payload);
    }
    catch (err) {
        console.error(`[socket] "${eventName}" event илгээхэд алдаа гарлаа:`, err.message);
    }
}
//# sourceMappingURL=socket.js.map