// ============================================================================
// MATERIALS CONTROLLER — /api/materials (Staff нэвтрэлттэй)
// Материалын жагсаалт, нэмэх/засах/устгах, нөөц нэмэх/тохируулах, sheet-ээс анхны
// материалуудыг оруулах. Өртөг ЗӨВХӨН энд (Staff-д) харагдана — нээлттэй
// /api/public/materials нь нэр, хавтангийн хэмжээг л буцаана.
// ============================================================================

import { Router, Request, Response } from "express";
import { MaterialMovementType, Prisma } from "@prisma/client";
import type { Material } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { toDriveImageUrl } from "../lib/drive-image";
import { requireAuth } from "../middleware/auth.middleware";
import { changeMaterialStock, seedDefaultMaterials, quoteMaterial, MaterialError, CM2_PER_M2, DEFAULT_MARKUP_PERCENT } from "../services/material.service";

const router = Router();
router.use(requireAuth);

function toDto(m: Material, shopMarkupPercent: number) {
  const markup = m.markupPercent != null ? Number(m.markupPercent) : shopMarkupPercent;
  const costPerCm2 = Number(m.costPerCm2);
  const costPerM2 = m.costPerM2 != null ? Number(m.costPerM2) : null;
  const factor = 1 + markup / 100;
  return {
    id: m.id,
    name: m.name,
    sku: m.sku,
    bulkSku: m.bulkSku,
    costPerCm2,
    costPerM2,
    bulkThresholdCm2: m.bulkThresholdCm2,
    markupPercent: m.markupPercent != null ? Number(m.markupPercent) : null,
    effectiveMarkupPercent: markup,
    sellPricePerCm2: Math.round(costPerCm2 * factor * 100) / 100,
    sellPricePerM2: Math.round((costPerM2 ?? costPerCm2 * CM2_PER_M2) * factor),
    stockCm2: m.stockCm2,
    minStockCm2: m.minStockCm2,
    isLowStock: m.stockCm2 < m.minStockCm2,
    sheetWidthCm: m.sheetWidthCm,
    sheetHeightCm: m.sheetHeightCm,
    imageUrl: m.imageUrl, // ✅ ШИНЭ — Etsy шиг swatch зураг
    note: m.note,
    isActive: m.isActive,
  };
}

/** Талбар бүрийг шалгаж Prisma-д өгөх data-г бэлтгэнэ (create үед заавал талбарууд шаардлагатай). */
function buildMaterialData(body: any, isCreate: boolean): { data?: any; error?: string } {
  const data: any = {};

  if (body.name !== undefined || isCreate) {
    const name = String(body.name ?? "").trim();
    if (!name) return { error: "Материалын нэр заавал шаардлагатай" };
    data.name = name;
  }
  if (body.sku !== undefined || isCreate) {
    const sku = String(body.sku ?? "").trim();
    if (!sku) return { error: "Код (SKU) заавал шаардлагатай" };
    data.sku = sku;
  }
  if (body.bulkSku !== undefined) {
    const bulk = String(body.bulkSku ?? "").trim();
    data.bulkSku = bulk === "" ? null : bulk;
  }
  if (body.costPerCm2 !== undefined || isCreate) {
    const n = Number(body.costPerCm2);
    if (!Number.isFinite(n) || n <= 0) return { error: "см²-ийн өртөг 0-ээс их тоо байх ёстой" };
    data.costPerCm2 = n;
  }
  if (body.costPerM2 !== undefined) {
    if (body.costPerM2 === null || body.costPerM2 === "") {
      data.costPerM2 = null;
    } else {
      const n = Number(body.costPerM2);
      if (!Number.isFinite(n) || n <= 0) return { error: "м²-ийн өртөг 0-ээс их тоо байх ёстой" };
      data.costPerM2 = n;
    }
  }
  if (body.bulkThresholdCm2 !== undefined) {
    const n = Math.round(Number(body.bulkThresholdCm2));
    if (!Number.isFinite(n) || n <= 0) return { error: "Том хэмжээний босго (см²) 0-ээс их байх ёстой" };
    data.bulkThresholdCm2 = n;
  }
  if (body.markupPercent !== undefined) {
    if (body.markupPercent === null || body.markupPercent === "") {
      data.markupPercent = null;
    } else {
      const n = Number(body.markupPercent);
      if (!Number.isFinite(n) || n < 0) return { error: "Нэмэх хувь 0 эсвэл түүнээс их байх ёстой" };
      data.markupPercent = n;
    }
  }
  if (body.minStockCm2 !== undefined) {
    const n = Math.round(Number(body.minStockCm2));
    if (!Number.isFinite(n) || n < 0) return { error: "Доод үлдэгдэл 0 эсвэл түүнээс их байх ёстой" };
    data.minStockCm2 = n;
  }
  for (const key of ["sheetWidthCm", "sheetHeightCm"] as const) {
    if (body[key] !== undefined) {
      if (body[key] === null || body[key] === "") {
        data[key] = null;
      } else {
        const n = Math.round(Number(body[key]));
        if (!Number.isFinite(n) || n <= 0) return { error: "Хавтангийн хэмжээ (см) 0-ээс их бүхэл тоо байх ёстой" };
        data[key] = n;
      }
    }
  }
  if (body.imageUrl !== undefined) { // ✅ ШИНЭ — Etsy шиг swatch зураг (Google Drive линк)
    const raw = body.imageUrl === null ? "" : String(body.imageUrl).trim();
    data.imageUrl = raw === "" ? null : toDriveImageUrl(raw);
  }
  if (body.note !== undefined) data.note = body.note === null || String(body.note).trim() === "" ? null : String(body.note).trim();
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

  return { data };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err as { code?: string }).code === "P2002";
}

// ---------------------------------------------------------------------------
// GET /api/materials
// ---------------------------------------------------------------------------
router.get("/", async (_req: Request, res: Response) => {
  try {
    const [materials, settings] = await Promise.all([
      prisma.material.findMany({ orderBy: { name: "asc" } }),
      prisma.shopSettings.findUnique({ where: { id: "default" } }),
    ]);
    const shopMarkup = settings?.materialMarkupPercent ?? DEFAULT_MARKUP_PERCENT;
    res.json(materials.map((m) => toDto(m, shopMarkup)));
  } catch (err) {
    console.error("Материалын жагсаалт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Материалын жагсаалт татаж чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/materials/quote — POS-д урьдчилан үнэ харуулна (нэвтэрсэн Staff тул
// нээлттэй API-ийн хүсэлтийн хязгаарт орохгүй). body: { materialId, widthCm, heightCm }
// ---------------------------------------------------------------------------
router.post("/quote", async (req: Request, res: Response) => {
  try {
    const { materialId, widthCm, heightCm } = req.body;
    const q = await quoteMaterial(materialId, widthCm, heightCm);
    res.json({ areaCm2: q.areaCm2, widthCm: q.widthCm, heightCm: q.heightCm, price: q.quote.price });
  } catch (err) {
    if (err instanceof MaterialError) return res.status(400).json({ error: err.message });
    console.error("Материалын үнэ тооцоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Үнэ тооцож чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/materials/seed-defaults — Sheet-ээс авсан анхны 4 материалыг оруулна
// (аль хэдийн байгаа SKU-г дарж бичихгүй).
// ---------------------------------------------------------------------------
router.post("/seed-defaults", async (_req: Request, res: Response) => {
  try {
    res.json(await seedDefaultMaterials());
  } catch (err) {
    console.error("Анхны материал оруулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Анхны материалыг оруулж чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/materials — Шинэ материал (body.stockCm2 өгвөл анхны үлдэгдэл болно)
// ---------------------------------------------------------------------------
router.post("/", async (req: Request, res: Response) => {
  try {
    const { data, error } = buildMaterialData(req.body, true);
    if (error) return res.status(400).json({ error });

    const initialStock = Math.max(0, Math.round(Number(req.body.stockCm2) || 0));
    const material = await prisma.$transaction(async (tx) => {
      const created = await tx.material.create({ data });
      if (initialStock > 0) {
        await changeMaterialStock(tx, created.id, initialStock, MaterialMovementType.ADJUSTMENT, { note: "Анхны үлдэгдэл" });
      }
      return tx.material.findUniqueOrThrow({ where: { id: created.id } });
    });

    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    res.status(201).json(toDto(material, settings?.materialMarkupPercent ?? DEFAULT_MARKUP_PERCENT));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "Энэ код (SKU) аль хэдийн бүртгэгдсэн байна" });
    console.error("Материал үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Материал үүсгэж чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/materials/:id
// ---------------------------------------------------------------------------
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { data, error } = buildMaterialData(req.body, false);
    if (error) return res.status(400).json({ error });

    const material = await prisma.material.update({ where: { id: req.params.id }, data });
    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    res.json(toDto(material, settings?.materialMarkupPercent ?? DEFAULT_MARKUP_PERCENT));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "Энэ код (SKU) аль хэдийн бүртгэгдсэн байна" });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Материал олдсонгүй" });
    }
    console.error("Материал засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Материал засаж чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/materials/:id — Захиалгад ашиглагдсан бол устгахгүй, идэвхгүй болгоно
// ---------------------------------------------------------------------------
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const usedCount = await prisma.orderItem.count({ where: { materialId: req.params.id } });
    if (usedCount > 0) {
      await prisma.material.update({ where: { id: req.params.id }, data: { isActive: false } });
      return res.json({ deactivated: true, message: "Захиалгад ашиглагдсан тул устгахгүй, идэвхгүй болголоо" });
    }
    await prisma.$transaction([
      prisma.materialMovement.deleteMany({ where: { materialId: req.params.id } }),
      prisma.material.delete({ where: { id: req.params.id } }),
    ]);
    res.json({ deleted: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Материал олдсонгүй" });
    }
    console.error("Материал устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Материал устгаж чадсангүй" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/materials/:id/stock — Нөөц нэмэх (ADD) эсвэл тооллогоор тохируулах (SET)
// body: { quantity: number, unit: "CM2" | "M2", mode: "ADD" | "SET", note?: string }
// ---------------------------------------------------------------------------
router.post("/:id/stock", async (req: Request, res: Response) => {
  try {
    const { quantity, unit, mode, note } = req.body;
    const q = Number(quantity);
    if (!Number.isFinite(q)) return res.status(400).json({ error: "Хэмжээг зөв оруулна уу" });
    if (unit !== "CM2" && unit !== "M2") return res.status(400).json({ error: "unit нь CM2 эсвэл M2 байх ёстой" });
    if (mode !== "ADD" && mode !== "SET") return res.status(400).json({ error: "mode нь ADD эсвэл SET байх ёстой" });

    const cm2 = Math.round(unit === "M2" ? q * CM2_PER_M2 : q);
    if (mode === "ADD" && cm2 <= 0) return res.status(400).json({ error: "Нэмэх хэмжээ 0-ээс их байх ёстой" });
    if (mode === "SET" && cm2 < 0) return res.status(400).json({ error: "Үлдэгдэл сөрөг байж болохгүй" });

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.material.findUnique({ where: { id: req.params.id } });
      if (!current) return null;
      const delta = mode === "ADD" ? cm2 : cm2 - current.stockCm2;
      if (delta === 0) return current;
      return changeMaterialStock(tx, current.id, delta, mode === "ADD" ? MaterialMovementType.PURCHASE_IN : MaterialMovementType.ADJUSTMENT, {
        note: note ? String(note) : mode === "ADD" ? "Худалдан авалт" : "Тооллогоор тохируулсан",
      });
    });
    if (!updated) return res.status(404).json({ error: "Материал олдсонгүй" });

    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    res.json(toDto(updated, settings?.materialMarkupPercent ?? DEFAULT_MARKUP_PERCENT));
  } catch (err) {
    console.error("Материалын нөөц өөрчлөхөд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нөөц өөрчилж чадсангүй" });
  }
});

export default router;
