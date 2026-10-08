// ============================================================================
// PRODUCT CONTROLLER (TypeScript)
// ----------------------------------------------------------------------------
// Бүтээгдэхүүн үүсгэх/засах, гар урлалын орц (CraftRecipe) болон хөдөлмөрийн
// зардал (CraftLaborCost) нэмэх, мөн нөөц гараар тохируулах (тооллого,
// орлого зэрэг) API-уудыг агуулна.
// ============================================================================

import { Router, Request, Response } from "express";
import { PrismaClient, StockMovementType } from "@prisma/client";
import { recalculateCostPrice } from "../services/product-cost.service";
import { requireAuth } from "../middleware/auth.middleware";

const prisma = new PrismaClient();
const router = Router();
router.use(requireAuth); // Энэ router-ийн БҮХ route Staff нэвтрэлт шаардана

// ============================================================================
// 1. БҮТЭЭГДЭХҮҮН ҮҮСГЭХ
//    POST /api/products
// ============================================================================
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      name,
      sku,
      description,
      sellPrice,
      rentalPricePerDay,
      depositAmount,
      isRental,
      isCraft,
      sellStockQty,
      rentalStockQty,
      minStockAlert,
    } = req.body;

    if (!name || !sku) {
      return res.status(400).json({ error: "name болон sku заавал шаардлагатай" });
    }

    const product = await prisma.product.create({
      data: {
        name,
        sku,
        description,
        sellPrice,
        rentalPricePerDay,
        depositAmount,
        isRental: Boolean(isRental),
        isCraft: Boolean(isCraft),
        sellStockQty: sellStockQty ?? 0,
        rentalStockQty: rentalStockQty ?? null,
        minStockAlert: minStockAlert ?? 3,
      },
    });

    res.status(201).json(product);
  } catch (err) {
    console.error("Бүтээгдэхүүн үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Бүтээгдэхүүн үүсгэж чадсангүй" });
  }
});

// ============================================================================
// 2. ЖАГСААЛТ / ДЭЛГЭРЭНГҮЙ
// ============================================================================
router.get("/", async (req: Request, res: Response) => {
  try {
    const { isRental, isCraft } = req.query;

    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(isRental !== undefined ? { isRental: isRental === "true" } : {}),
        ...(isCraft !== undefined ? { isCraft: isCraft === "true" } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(products);
  } catch (err) {
    console.error("Жагсаалт татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Жагсаалт татаж чадсангүй" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        materialsUsed: { include: { material: true } },
        laborCosts: true,
        stockMovements: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });

    if (!product) return res.status(404).json({ error: "Бүтээгдэхүүн олдсонгүй" });
    res.json(product);
  } catch (err) {
    console.error("Дэлгэрэнгүй татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Дэлгэрэнгүй мэдээлэл татаж чадсангүй" });
  }
});

// ============================================================================
// 3. ГАР УРЛАЛЫН ОРЦ (BOM) НЭМЭХ
//    POST /api/products/:id/materials
//    body: { materialId, quantity }
// ----------------------------------------------------------------------------
// unitCostSnapshot-ыг СЕРВЕР ТАЛ автоматаар material.costPrice/sellPrice-с
// авч "хөлдөөнө" — клиент талаас дамжуулахгүй (үнийг найдвартай эх сурвалж
// сервер дээр байлгах зарчим).
// ============================================================================
router.post("/:id/materials", async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const { materialId, quantity } = req.body;

    if (!materialId || !quantity) {
      return res.status(400).json({ error: "materialId болон quantity заавал шаардлагатай" });
    }

    const material = await prisma.product.findUnique({ where: { id: materialId } });
    if (!material) return res.status(404).json({ error: "Материал (Product) олдсонгүй" });

    // Материалын өртгийг costPrice-с, байхгүй бол sellPrice-с авна
    const unitCostSnapshot = Number(material.costPrice) || Number(material.sellPrice ?? 0);

    const recipe = await prisma.craftRecipe.create({
      data: { productId, materialId, quantity, unitCostSnapshot },
    });

    const newCostPrice = await recalculateCostPrice(productId);

    res.status(201).json({ recipe, newCostPrice });
  } catch (err) {
    console.error("Орц нэмэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Орц нэмж чадсангүй" });
  }
});

// ============================================================================
// 4. ХӨДӨЛМӨРИЙН ЗАРДАЛ НЭМЭХ
//    POST /api/products/:id/labor-costs
//    body: { description, basis: "HOURLY"|"FIXED", hours?, hourlyRate?, fixedAmount? }
// ============================================================================
router.post("/:id/labor-costs", async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const { description, basis, hours, hourlyRate, fixedAmount } = req.body;

    if (!description || !basis) {
      return res.status(400).json({ error: "description болон basis заавал шаардлагатай" });
    }

    const totalCost =
      basis === "HOURLY" ? Number(hours ?? 0) * Number(hourlyRate ?? 0) : Number(fixedAmount ?? 0);

    if (totalCost <= 0) {
      return res.status(400).json({ error: "Тооцоолсон зардал 0-с их байх ёстой" });
    }

    const laborCost = await prisma.craftLaborCost.create({
      data: { productId, description, basis, hours, hourlyRate, fixedAmount, totalCost },
    });

    const newCostPrice = await recalculateCostPrice(productId);

    res.status(201).json({ laborCost, newCostPrice });
  } catch (err) {
    console.error("Хөдөлмөрийн зардал нэмэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Хөдөлмөрийн зардал нэмж чадсангүй" });
  }
});

// ============================================================================
// 5. НӨӨЦ ГАРААР ТОХИРУУЛАХ (Тооллого, орлого)
//    POST /api/products/:id/stock-adjustment
//    body: { type: "PURCHASE_IN"|"ADJUSTMENT", quantity, staffId?, note? }
// ----------------------------------------------------------------------------
// ЧУХАЛ: Product.sellStockQty өөрчлөлт БОЛОН StockMovement бичилтийг НЭГ
// ТРАНЗАКЦИД хийнэ — аль нэг нь амжилтгүй бол хоёул буцна (нөөц болон
// түүх зөрөхгүй байх баталгаа).
// ============================================================================
router.post("/:id/stock-adjustment", async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const { type, quantity, staffId, note } = req.body as {
      type: StockMovementType;
      quantity: number;
      staffId?: string;
      note?: string;
    };

    if (!type || typeof quantity !== "number") {
      return res.status(400).json({ error: "type болон quantity заавал шаардлагатай" });
    }

    // ADJUSTMENT үед quantity сөрөг тоо байж болно (тооллогоор дутсан);
    // PURCHASE_IN үед эерэг байх ёстой.
    if (type === StockMovementType.PURCHASE_IN && quantity <= 0) {
      return res.status(400).json({ error: "PURCHASE_IN quantity эерэг тоо байх ёстой" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.product.update({
        where: { id: productId },
        data: { sellStockQty: { increment: quantity } },
      });

      const movement = await tx.stockMovement.create({
        data: { productId, type, quantity, staffId, note },
      });

      return { updatedProduct, movement };
    });

    res.json(result);
  } catch (err) {
    console.error("Нөөц тохируулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Нөөц тохируулж чадсангүй" });
  }
});

export default router;
