// ============================================================================
// CUSTOM ORDERS CONTROLLER — Тусгай захиалгын (Variation/Personalization)
// жагсаалт, хугацааны сануулга, баталгаажуулах зураг.
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { toDriveImageUrl } from "../lib/drive-image";
import { emitToStore } from "../realtime/socket";

const router = Router();

// ============================================================================
// GET /api/custom-orders — Тусгай захиалгын мөрүүдийн жагсаалт
// ----------------------------------------------------------------------------
// Хугацаа хэтэрсэн → эхэнд (улаан), дараа нь ойрхон хугацаатай, эцэст нь
// хугацаагүй мөрүүд. Захиалгын дэлгэрэнгүй, харилцагч, бараа хамт ирнэ.
// ============================================================================
router.get("/", async (req: Request, res: Response) => {
  try {
    const items = await prisma.orderItem.findMany({
      where: {
        // ⚠️ selectedVariations нь Json талбар тул Prisma-д null-шалгалт
        // хувилбараас хамааран найдваргүй байдаг тул зайлсхийв — практикт
        // тусгай захиалга бүрд customizationText эсвэл customizationDeadline
        // хоёрын аль нэг нь заавал байдаг.
        OR: [{ customizationText: { not: null } }, { customizationDeadline: { not: null } }],
        order: { paymentStatus: { not: "CANCELLED" } },
      },
      include: {
        product: { select: { name: true, personalizationLabel: true } },
        order: { select: { id: true, orderNumber: true, customer: { select: { name: true, phone: true } } } },
      },
    });

    // ✅ Эрэмбэ: 1) хугацаа хэтэрсэн (эхэнд), 2) ойрхон хугацаатай, 3) хугацаагүй (эцэст)
    const now = new Date();
    items.sort((a, b) => {
      const aDate = a.customizationDeadline;
      const bDate = b.customizationDeadline;
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.getTime() - bDate.getTime();
    });

    const result = items.map((i) => ({
      orderItemId: i.id,
      orderId: i.order.id,
      orderNumber: i.order.orderNumber,
      customerName: i.order.customer?.name ?? null,
      customerPhone: i.order.customer?.phone ?? null,
      productName: i.product.name,
      personalizationLabel: i.product.personalizationLabel,
      customizationText: i.customizationText,
      selectedVariations: i.selectedVariations,
      customizationDeadline: i.customizationDeadline,
      isOverdue: i.customizationDeadline ? i.customizationDeadline < now : false,
      customizationProofPhotoUrl: i.customizationProofPhotoUrl,
    }));

    res.json(result);
  } catch (err) {
    console.error("Тусгай захиалга татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// ============================================================================
// PATCH /api/custom-orders/:orderItemId/proof-photo — Баталгаажуулах зураг
// (Google Drive линк) нэмэх/солих.
// body: { imageUrl: string }
// ============================================================================
router.patch("/:orderItemId/proof-photo", async (req: Request, res: Response) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl заавал шаардлагатай" });

    const item = await prisma.orderItem.update({
      where: { id: req.params.orderItemId },
      data: { customizationProofPhotoUrl: toDriveImageUrl(imageUrl) },
    });
    res.json(item);
  } catch (err) {
    console.error("Баталгаажуулах зураг хадгалахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Хадгалж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: Хугацаа ойртсон (24 цагийн дотор) тусгай захиалгыг POS-д
// сануулна — order-cleanup.service.ts-ийн "throttled" загвартай ИЖИЛ
// (жинхэнэ cron биш, тодорхой GET дуудлагууд дээр даяарчлагдана).
// ============================================================================
let lastDeadlineCheckAt = 0;
const DEADLINE_CHECK_THROTTLE_MS = 60_000; // 60 секунд тутамд 1 удаа л шалгана

export async function checkUpcomingCustomizationDeadlines() {
  const now = Date.now();
  if (now - lastDeadlineCheckAt < DEADLINE_CHECK_THROTTLE_MS) return;
  lastDeadlineCheckAt = now;

  try {
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const items = await prisma.orderItem.findMany({
      where: {
        customizationDeadline: { not: null, lte: in24h },
        deadlineAlertSent: false,
        order: { paymentStatus: { not: "CANCELLED" } },
      },
      include: { product: { select: { name: true } }, order: { select: { orderNumber: true, storeId: true } } },
    });

    for (const item of items) {
      emitToStore(item.order.storeId, "customization_deadline_approaching", {
        orderItemId: item.id,
        orderNumber: item.order.orderNumber,
        productName: item.product.name,
        customizationText: item.customizationText,
        deadline: item.customizationDeadline,
      });
      await prisma.orderItem.update({ where: { id: item.id }, data: { deadlineAlertSent: true } });
    }
  } catch (err) {
    console.error("Хугацааны сануулга шалгахад алдаа гарлаа:", err);
  }
}

export default router;
