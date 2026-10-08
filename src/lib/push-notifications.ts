// ============================================================================
// PUSH NOTIFICATIONS (FCM) — App хаалттай үед ч хүргэгчид мэдэгдэл очно.
// ----------------------------------------------------------------------------
// ⚠️ ЗААВАЛ ХИЙХ ГАДААД АЛХАМ (Танд өөрт хэрэгтэй):
// 1. https://console.firebase.google.com дээр шинэ Firebase төсөл үүсгэ
// 2. Project Settings → Service Accounts → "Generate new private key"
//    дараад JSON файлыг татаж авна
// 3. Тэр JSON-ий агуулгыг .env файлдаа FIREBASE_SERVICE_ACCOUNT_JSON
//    хувьсагчид (нэг мөр болгож) хадгална
// 4. Flutter курьер апп-даа firebase_messaging package нэмээд
//    (courier_app/README.md-д дэлгэрэнгүй заавар байгаа)
//
// Дээрх тохиргоог хийтэл энэ модуль АЮУЛГҮЙ SKIP хийж, зөвхөн Socket.io
// realtime мэдэгдэл (апп нээлттэй үед) ажиллана — систем БҮХЭЛДЭЭ зогсохгүй.
// ============================================================================

import * as admin from "firebase-admin";
import { prisma } from "./prisma";

let firebaseApp: admin.app.App | null = null;
let initAttempted = false;

function getFirebaseApp(): admin.app.App | null {
  if (initAttempted) return firebaseApp;
  initAttempted = true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.log("[push] FIREBASE_SERVICE_ACCOUNT_JSON тохируулаагүй тул push notification идэвхгүй (Socket.io л ажиллана)");
    return null;
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("[push] Firebase Admin SDK амжилттай эхэллээ");
    return firebaseApp;
  } catch (err) {
    console.error("[push] FIREBASE_SERVICE_ACCOUNT_JSON задлахад алдаа гарлаа:", err);
    return null;
  }
}

/**
 * ✅ ШИНЭ: Сервер ЭХЛЭХ мөчид ШУУД шалгаж, лог хэвлэнэ (server.ts-с
 * дуудна) — өмнө нь "lazy" (эхний push мэдэгдэл илгээх үед л) эхэлдэг
 * байсан тул тохиргоог шалгахын тулд ЗААВАЛ жинхэнэ захиалга үүсгэх
 * шаардлагатай байсан. Одоо серверээ ажиллуулмагц шууд харагдана.
 */
export function initPushNotifications(): void {
  getFirebaseApp();
}

/** Тодорхой нэг хүргэгчийн БҮХ бүртгэлтэй төхөөрөмжид push илгээнэ. */
export async function sendPushToCourier(courierId: string, title: string, body: string, data?: Record<string, string>) {
  const app = getFirebaseApp();
  if (!app) return; // Тохируулаагүй бол чимээгүй skip (Socket.io л ажиллана)

  try {
    const tokens = await prisma.courierDeviceToken.findMany({ where: { courierId }, select: { fcmToken: true } });
    if (tokens.length === 0) return;

    const response = await app.messaging().sendEachForMulticast({
      tokens: tokens.map((t) => t.fcmToken),
      notification: { title, body },
      data: data || {},
    });

    // Хүчингүй болсон (устгагдсан апп-тай) token-уудыг цэвэрлэнэ
    const invalidTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === "messaging/registration-token-not-registered")) {
        invalidTokens.push(tokens[i].fcmToken);
      }
    });
    if (invalidTokens.length > 0) {
      await prisma.courierDeviceToken.deleteMany({ where: { fcmToken: { in: invalidTokens } } });
    }
  } catch (err) {
    console.error(`[push] courierId=${courierId}-д push илгээхэд алдаа гарлаа:`, err);
  }
}

/** БҮХ идэвхтэй хүргэгчдэд push илгээнэ (broadcast). */
export async function sendPushToAllCouriers(title: string, body: string, data?: Record<string, string>, exceptCourierIds?: string | string[]) {
  const app = getFirebaseApp();
  if (!app) return;

  try {
    const tokens = await prisma.courierDeviceToken.findMany({
      // ✅ ШИНЭ: exceptCourierId (илгээмж илгээгч) өөрт нь мэдэгдэл явуулахгүй
      where: { courier: { isActive: true }, ...(([] as string[]).concat(exceptCourierIds ?? []).filter(Boolean).length > 0 ? { courierId: { notIn: ([] as string[]).concat(exceptCourierIds ?? []).filter(Boolean) } } : {}) },
      select: { fcmToken: true },
    });
    if (tokens.length === 0) return;

    // FCM нэг удаад дээд тал нь 500 token авдаг тул хэсэглэнэ
    const chunkSize = 500;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      await app.messaging().sendEachForMulticast({
        tokens: chunk.map((t) => t.fcmToken),
        notification: { title, body },
        data: data || {},
      });
    }
  } catch (err) {
    console.error("[push] Бүх хүргэгчдэд broadcast push илгээхэд алдаа гарлаа:", err);
  }
}
