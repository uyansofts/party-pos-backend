// ============================================================================
// REALTIME / SOCKET.IO CORE (TypeScript)
// ============================================================================

import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import type { PosSocketAuthPayload } from "../types/payment.types";

let ioInstance: SocketIOServer | null = null;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  ioInstance = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
      methods: ["GET", "POST"],
    },
  });

  // -------- Auth middleware: ПОС кассын апп БОЛОН Курьерийн апп хоёуланг зөвшөөрнө --------
  // ✅ ШИНЭ: socket.handshake.auth.clientType === "courier" эсэхийг шалгаад,
  // тохирох JWT (Staff эсвэл Courier) төрлөөр баталгаажуулна — 2 систем
  // тусдаа токентой ч НЭГ Л socket.io сервер дээр найдвартай зэрэг ажиллана.
  ioInstance.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error("AUTH_TOKEN_MISSING"));

      const clientType = socket.handshake.auth?.clientType as string | undefined;

      if (clientType === "courier") {
        const payload = jwt.verify(token, process.env.JWT_SECRET as string) as { type: string; courierId: string };
        if (payload.type !== "courier") return next(new Error("AUTH_INVALID"));
        socket.data.clientType = "courier";
        socket.data.courierId = payload.courierId;
      } else {
        const payload = jwt.verify(token, process.env.JWT_SECRET as string) as PosSocketAuthPayload;
        socket.data.clientType = "pos";
        socket.data.staffId = payload.staffId;
        socket.data.storeId = payload.storeId || "default";
      }
      next();
    } catch (err) {
      next(new Error("AUTH_INVALID"));
    }
  });

  ioInstance.on("connection", (socket) => {
    if (socket.data.clientType === "courier") {
      // ✅ ШИНЭ: Бүх хүргэгч НЭГ "couriers" room-д нэгддэг (дэлгүүр олон
      // байхгүй бяцхан бизнест storeId-аар ялгах шаардлагагүй) — broadcast
      // хийхэд бүгдэд нэг дор хүрнэ.
      socket.join("couriers");
      socket.join(`courier::${socket.data.courierId}`); // Тухайн хүргэгчид ЗӨВХӨН чиглэсэн event-д ашиглана
      console.log(`[socket] Хүргэгч холбогдлоо: courierId=${socket.data.courierId}`);

      socket.on("disconnect", (reason) => {
        console.log(`[socket] Хүргэгч салгалаа: courierId=${socket.data.courierId}, шалтгаан=${reason}`);
      });
      return;
    }

    const room = `pos::${socket.data.storeId}`;
    socket.join(room);
    console.log(`[socket] ПОС холбогдлоо: staffId=${socket.data.staffId}, room=${room}`);

    socket.on("disconnect", (reason) => {
      console.log(`[socket] ПОС салгалаа: staffId=${socket.data.staffId}, шалтгаан=${reason}`);
    });
  });

  return ioInstance;
}

export function getIO(): SocketIOServer {
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
export function emitToStore<T>(storeId: string, eventName: string, payload: T): void {
  try {
    const io = getIO();
    io.to(`pos::${storeId}`).emit(eventName, payload);
  } catch (err) {
    console.error(`[socket] "${eventName}" event илгээхэд алдаа гарлаа:`, (err as Error).message);
  }
}

/** ✅ ШИНЭ: Бүх идэвхтэй холбогдсон хүргэгчид (broadcast) event илгээнэ. */
export function emitToAllCouriers<T>(eventName: string, payload: T, exceptCourierIds?: string | string[]): void {
  try {
    const io = getIO();
    // ✅ ШИНЭ: Курьерийн ӨӨРИЙН илгээмжийг илгээгчид нь БУЦААЖ мэдэгдэхгүй (өөрийн
    // илгээмжийг өөрөө авах боломжгүй) — тухайн курьерийн өрөөг хасна.
    const exceptRooms = ([] as string[]).concat(exceptCourierIds ?? []).filter(Boolean).map((id) => `courier::${id}`);
    const target = exceptRooms.length > 0 ? io.to("couriers").except(exceptRooms) : io.to("couriers");
    target.emit(eventName, payload);
  } catch (err) {
    console.error(`[socket] Хүргэгчдэд "${eventName}" илгээхэд алдаа гарлаа:`, (err as Error).message);
  }
}

/** ✅ ШИНЭ: ЗӨВХӨН тодорхой нэг хүргэгчид (жишээ нь Staff гараар оноосон) event илгээнэ. */
export function emitToCourier<T>(courierId: string, eventName: string, payload: T): void {
  try {
    const io = getIO();
    io.to(`courier::${courierId}`).emit(eventName, payload);
  } catch (err) {
    console.error(`[socket] Хүргэгч ${courierId}-д "${eventName}" илгээхэд алдаа гарлаа:`, (err as Error).message);
  }
}
