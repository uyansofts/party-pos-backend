// ============================================================================
// PRODUCT CONTROLLER (TypeScript)
// ----------------------------------------------------------------------------
// Бүтээгдэхүүн үүсгэх/засах, гар урлалын орц (CraftRecipe) болон хөдөлмөрийн
// зардал (CraftLaborCost) нэмэх, мөн нөөц гараар тохируулах (тооллого,
// орлого зэрэг) API-уудыг агуулна.
// ============================================================================

import { Router, Request, Response } from "express";
import { StockMovementType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { normalizeCustomFieldDefs, CustomFieldError, type CustomFieldDef } from "../lib/custom-fields";
import { normalizeServiceOption, ServiceOptionError, type ServiceOption } from "../lib/service-option";
import { recalculateCostPrice } from "../services/product-cost.service";
import { requireAuth } from "../middleware/auth.middleware";
import { generateSku } from "../lib/sku";
import { ImageError, normalizeProductImages, resolveImageUrl } from "../lib/product-images";
import { parseFeatured } from "../lib/public-product";
import { isFeaturedNow } from "../lib/featured";
import { PricingError, planSaleChange } from "../lib/pricing"; // ✅ ШИНЭ — хямдрал // ✅ ШИНЭ — Онцлох бараа // ✅ ШИНЭ — олон зураг

const router = Router();
router.use(requireAuth); // Энэ router-ийн БҮХ route Staff нэвтрэлт шаардана

// ============================================================================
// POST /api/products — Бүтээгдэхүүн үүсгэх
// ----------------------------------------------------------------------------
// ✅ SKU автоматаар үүсгэх: sku талбарыг хоосон орхивол (undefined/""),
// сервер `generateSku()`-ээр АВТОМАТААР үүсгэнэ. Санамсаргүй давхцал
// (@unique зөрчил, P2002) гарвал ЯГ 1 УДАА дахин оролдоно — хоёр дахь
// удаа ч давхцах магадлал астрономийн хэмжээгээр бага тул үүнээс цааш
// оролдохгүй.
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
      imageUrl,
      imageUrls, // ✅ ШИНЭ — олон зураг (түлхүүр = эхнийх)
      publicDescription, // ✅ ШИНЭ — харилцагчид харагдах тайлбар
      isFeatured, // ✅ ШИНЭ — нүүр хуудасны "Онцлох"
      featuredOrder,
      salePrice, // ХУУЧИН (₮) — одоо хувь ашиглана; зөвхөн null/хоосон зөвшөөрнө
      salePercent, // ✅ ШИНЭ — хямдралын ХУВЬ 1-70 (null = цуцлах); үнийг сервер тооцно
      saleStartsAt, // "YYYY-MM-DD"
      saleEndsAt, // "YYYY-MM-DD"
      categoryId,
      color,
      size,
      usesMaterialPricing, // ✅ ШИНЭ
      customFields, // ✅ ШИНЭ
      serviceEnabled, // ✅ ШИНЭ
      serviceLabel,
      serviceFee,
      serviceRequiresCourierDelivery, // ✅ ШИНЭ
      allowedMaterialIds, // ✅ ШИНЭ — Энэ бараанд зөвшөөрөгдсөн материалын id-ууд (хоосон/өгөөгүй бол БҮХ идэвхтэй материал)
      sellerId, // ✅ ШИНЭ — Худалдагчийн бараа (хоосон = манай өөрийн бараа)
    } = req.body;

    let customFieldDefs: CustomFieldDef[] = [];
    let serviceOption: ServiceOption;
    try {
      customFieldDefs = normalizeCustomFieldDefs(customFields);
      serviceOption = normalizeServiceOption({ serviceEnabled, serviceLabel, serviceFee });
    } catch (e) {
      if (e instanceof CustomFieldError || e instanceof ServiceOptionError) return res.status(400).json({ error: e.message });
      throw e;
    }

    if (!name) {
      return res.status(400).json({ error: "name заавал шаардлагатай" });
    }

    // ✅ ШИНЭ: Худалдагч сонгосон бол оршин байгаа эсэхийг шалгана
    if (sellerId) {
      const seller = await prisma.seller.findUnique({ where: { id: String(sellerId) }, select: { id: true } });
      if (!seller) return res.status(400).json({ error: "Сонгосон худалдагч олдсонгүй" });
    }

    const finalSku: string = sku && sku.trim() !== "" ? sku.trim() : generateSku();

    // ✅ ЗАСВАР: Excel import-той АДИЛ логик — кассчин Google Drive линк
    // (ямар ч формат) эсвэл зөвхөн file ID-г л оруулбал, автоматаар манай
    // Image Proxy URL болгож хөрвүүлнэ (CORS-ийн асуудлаас зайлсхийнэ).
    // ✅ ШИНЭ: олон зураг — буруу холбоос бол ТОДОРХОЙ алдаа (чимээгүй зураг алдахгүй)
    let images: { imageUrl: string | null; imageUrls: string[] };
    try {
      images = normalizeProductImages({ imageUrl, imageUrls });
    } catch (e) {
      if (e instanceof ImageError) return res.status(400).json({ error: e.message });
      throw e;
    }
    if (publicDescription !== undefined && publicDescription !== null && (typeof publicDescription !== "string" || publicDescription.length > 2000)) {
      return res.status(400).json({ error: "Нийтэд харагдах тайлбар 2000 тэмдэгтээс ихгүй байх ёстой" });
    }
    let featuredPatch: { isFeatured?: boolean; featuredOrder?: number | null };
    try {
      featuredPatch = parseFeatured(isFeatured, featuredOrder);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    // ✅ ШИНЭ: Хямдрал = ХУВЬ + эхлэх/дуусах өдөр (энгийн борлуулах бараанд л). Хуучин ₮-ийн salePrice-ийг хүлээж авахгүй.
    let salePatch: Record<string, unknown> | null = null;
    if (salePrice !== undefined && salePrice !== null && salePrice !== "") return res.status(400).json({ error: "Хямдралыг ХУВЬ (salePercent) болон эхлэх/дуусах өдрөөр зарлана" });
    if (salePercent !== undefined) {
      try {
        salePatch = planSaleChange(null, { sellPrice: sellPrice !== undefined && sellPrice !== null && sellPrice !== "" ? Number(sellPrice) : null, priceOptional: isRental === true || usesMaterialPricing === true, sale: { percent: salePercent, starts: saleStartsAt, ends: saleEndsAt } });
      } catch (e) {
        if (e instanceof PricingError) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    }

    const createData = {
      name,
      sku: finalSku,
      description,
      sellPrice,
      rentalPricePerDay,
      depositAmount,
      isRental: Boolean(isRental),
      isCraft: Boolean(isCraft),
      sellStockQty: sellStockQty ?? 0,
      imageUrl: images.imageUrl,
      imageUrls: images.imageUrls,
      publicDescription: typeof publicDescription === "string" && publicDescription.trim() ? publicDescription.trim() : null,
      ...featuredPatch, // ✅ ШИНЭ — isFeatured / featuredOrder
      ...(salePatch ?? {}), // ✅ ШИНЭ — salePercent, salePrice, saleStartsAt, saleEndsAt, priceChangedAt
      categoryId,
      sellerId: sellerId ? String(sellerId) : null, // ✅ ШИНЭ
      color,
      size,
      rentalStockQty: rentalStockQty ?? null,
      minStockAlert: minStockAlert ?? 3,
      usesMaterialPricing: Boolean(usesMaterialPricing), // ✅ ШИНЭ
      customFields: customFieldDefs as any, // ✅ ШИНЭ — Хувийн мэдээллийн талбарууд
      ...serviceOption, // ✅ ШИНЭ — Нэмэлт үйлчилгээ (serviceEnabled/serviceLabel/serviceFee)
      // ✅ ШИНЭ: Идэвхтэй бол ЗӨВХӨН манай курьер (жишээ: газар дээр угсрах арк);
      // унтраасан бол ямар ч аргаар авч болно (жишээ: бэлдээд өгдөг бөмбөлгөн чимэглэл)
      serviceRequiresCourierDelivery: serviceRequiresCourierDelivery === undefined ? true : Boolean(serviceRequiresCourierDelivery),
      ...(usesMaterialPricing ? { isCustomizable: true } : {}), // Материалаар үнэлэх бол ЗААВАЛ тусгай захиалга
      // ✅ ШИНЭ: Энэ бараанд зөвшөөрөгдсөн материалууд (сонгоогүй бол БҮХ идэвхтэй материал зөвшөөрнө)
      ...(Array.isArray(allowedMaterialIds) && allowedMaterialIds.length > 0
        ? { allowedMaterials: { connect: allowedMaterialIds.map((id: string) => ({ id })) } }
        : {}),
    };

    let product;
    try {
      product = await prisma.product.create({ data: createData });
    } catch (err) {
      // SKU автоматаар үүсгэсэн үед л (хэрэглэгч гараар бичээгүй үед л)
      // давхцлыг чимээгүй дахин оролдоно — гараар бичсэн SKU давхцвал
      // хэрэглэгчид ЯГ ТЭР алдааг харуулах ёстой (доор catch хэсэгт очно).
      const isUniqueViolation = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      const wasAutoGenerated = !sku || sku.trim() === "";
      if (isUniqueViolation && wasAutoGenerated) {
        createData.sku = generateSku();
        product = await prisma.product.create({ data: createData });
      } else {
        throw err;
      }
    }

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
      include: {
        category: true, // Flutter талд ангиллын нэрийг шууд харуулахад
        variationGroups: { include: { values: { orderBy: { sortOrder: "asc" } } }, orderBy: { sortOrder: "asc" } }, // ✅ ШИНЭ
        allowedMaterials: { select: { id: true, name: true, imageUrl: true } }, // ✅ ШИНЭ
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
        allowedMaterials: { select: { id: true, name: true, imageUrl: true } }, // ✅ ШИНЭ
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
// 3.1 ГАР УРЛАЛЫН ОРЦ (BOM) УСТГАХ
//    DELETE /api/products/:id/materials/:recipeId
// ============================================================================
router.delete("/:id/materials/:recipeId", async (req: Request, res: Response) => {
  try {
    const { id: productId, recipeId } = req.params;

    const recipe = await prisma.craftRecipe.findUnique({ where: { id: recipeId } });
    if (!recipe || recipe.productId !== productId) {
      return res.status(404).json({ error: "Орц олдсонгүй" });
    }

    await prisma.craftRecipe.delete({ where: { id: recipeId } });
    const newCostPrice = await recalculateCostPrice(productId);

    res.json({ success: true, newCostPrice });
  } catch (err) {
    console.error("Орц устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Орц устгаж чадсангүй" });
  }
});

// ============================================================================
// 3.2 ГАР УРЛАЛЫН ОРЦ (BOM) ТОО ХЭМЖЭЭ ЗАСАХ
//    PUT /api/products/:id/materials/:recipeId
//    body: { quantity }
// ============================================================================
router.put("/:id/materials/:recipeId", async (req: Request, res: Response) => {
  try {
    const { id: productId, recipeId } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: "quantity 0-ээс их байх ёстой" });
    }

    const recipe = await prisma.craftRecipe.findUnique({ where: { id: recipeId } });
    if (!recipe || recipe.productId !== productId) {
      return res.status(404).json({ error: "Орц олдсонгүй" });
    }

    await prisma.craftRecipe.update({ where: { id: recipeId }, data: { quantity } });
    const newCostPrice = await recalculateCostPrice(productId);

    res.json({ success: true, newCostPrice });
  } catch (err) {
    console.error("Орц засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Орц засаж чадсангүй" });
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
    }, { timeout: 15000 });

    res.json(result);
  } catch (err) {
    console.error("Нөөц тохируулахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Нөөц тохируулж чадсангүй" });
  }
});

// ============================================================================
// PUT /:id — Бүтээгдэхүүн засах
// ----------------------------------------------------------------------------
// Ирсэн талбар бүрийг л шинэчилнэ (undefined утгыг Prisma алгасдаг тул
// хэсэгчилсэн засвар (partial update) аюулгүй ажиллана).
// ============================================================================
router.put("/:id", async (req: Request, res: Response) => {
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
      imageUrl,
      imageUrls, // ✅ ШИНЭ
      publicDescription, // ✅ ШИНЭ
      isFeatured, // ✅ ШИНЭ
      featuredOrder,
      salePrice, // хуучин (₮) — зөвхөн null/хоосон зөвшөөрнө
      salePercent, // ✅ ШИНЭ — хямдралын хувь
      saleStartsAt,
      saleEndsAt,
      categoryId,
      sellerId, // ✅ ШИНЭ — худалдагч (null/"" = манай өөрийн бараа болгох)
      isActive,
      color,
      size,
      // ✅ ШИНЭ
      isCustomizable,
      personalizationEnabled,
      personalizationLabel,
      personalizationMaxLength,
      personalizationRequired,
      usesMaterialPricing, // ✅ ШИНЭ
      customFields, // ✅ ШИНЭ
      serviceEnabled, // ✅ ШИНЭ
      serviceLabel,
      serviceFee,
      serviceRequiresCourierDelivery, // ✅ ШИНЭ
      allowedMaterialIds, // ✅ ШИНЭ — Энэ бараанд зөвшөөрөгдсөн материалын id-ууд (хоосон/өгөөгүй бол БҮХ идэвхтэй материал)
    } = req.body;

    let customFieldDefs: CustomFieldDef[] = [];
    let serviceOption: ServiceOption | null = null;
    try {
      customFieldDefs = normalizeCustomFieldDefs(customFields);
      if (serviceEnabled !== undefined) serviceOption = normalizeServiceOption({ serviceEnabled, serviceLabel, serviceFee });
    } catch (e) {
      if (e instanceof CustomFieldError || e instanceof ServiceOptionError) return res.status(400).json({ error: e.message });
      throw e;
    }

    // ✅ ШИНЭ: Зураг өөрчилж байвал (олон зураг, эсвэл хуучин ганц imageUrl) шалгаж, түлхүүр зураг = эхнийх болгоно
    let imagePatch: { imageUrl: string | null; imageUrls: string[] } | null = null;
    if (imageUrl !== undefined || imageUrls !== undefined) {
      try {
        imagePatch = normalizeProductImages({ imageUrl, imageUrls });
      } catch (e) {
        if (e instanceof ImageError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    if (publicDescription !== undefined && publicDescription !== null && (typeof publicDescription !== "string" || publicDescription.length > 2000)) {
      return res.status(400).json({ error: "Нийтэд харагдах тайлбар 2000 тэмдэгтээс ихгүй байх ёстой" });
    }
    let featuredPatch: { isFeatured?: boolean; featuredOrder?: number | null; featuredUntil?: Date | null };
    try {
      featuredPatch = parseFeatured(isFeatured, featuredOrder);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    // ✅ ШИНЭ: POS маягт `isFeatured`-ийг ХАДГАЛАХ БҮРТ илгээдэг. Худалдагчийн ТӨЛБӨРТЭЙ онцлох байрлалыг (featuredUntil) санамсаргүй
    // хугацаагүй болгохгүй: аль хэдийн онцлох байгаа бол дуусах хугацаа хэвээр; Staff шинээр онцолбол хугацаагүй; болиулбал арилна.
    if (featuredPatch.isFeatured !== undefined) {
      const curFeat = await prisma.product.findUnique({ where: { id: req.params.id }, select: { isFeatured: true, featuredUntil: true } });
      const wasNow = curFeat ? isFeaturedNow(curFeat) : false;
      if (featuredPatch.isFeatured === true) {
        if (!wasNow) featuredPatch.featuredUntil = null;
      } else {
        featuredPatch.featuredUntil = null;
      }
    }
    // ✅ ШИНЭ: Үнэ + хямдрал: НЭГ дүрэм (хувь, огноо, 14 хоног тогтвортой, хямдралтай үед үнэ түгжих). POS маягт өөрчлөгдөөгүй хямдралыг дахин илгээсэн ч дахин шалгахгүй.
    let salePatch: Record<string, unknown> | null = null;
    if (salePrice !== undefined && salePrice !== null && salePrice !== "") return res.status(400).json({ error: "Хямдралыг ХУВЬ (salePercent) болон эхлэх/дуусах өдрөөр зарлана" });
    if (salePercent !== undefined || (sellPrice !== undefined && sellPrice !== null && sellPrice !== "") || (rentalPricePerDay !== undefined && rentalPricePerDay !== null && rentalPricePerDay !== "")) {
      const cur = await prisma.product.findUnique({ where: { id: req.params.id }, select: { sellPrice: true, rentalPricePerDay: true, priceChangedAt: true, salePercent: true, salePrice: true, saleStartsAt: true, saleEndsAt: true, isRental: true, usesMaterialPricing: true } });
      if (!cur) return res.status(404).json({ error: "Бараа олдсонгүй" });
      try {
        salePatch = planSaleChange(cur as any, {
          sellPrice: sellPrice !== undefined && sellPrice !== null && sellPrice !== "" ? Number(sellPrice) : undefined,
          rentalPrice: rentalPricePerDay !== undefined && rentalPricePerDay !== null && rentalPricePerDay !== "" ? Number(rentalPricePerDay) : undefined,
          priceOptional: (isRental ?? cur.isRental) === true || (usesMaterialPricing ?? cur.usesMaterialPricing) === true,
          sale: salePercent !== undefined ? { percent: salePercent, starts: saleStartsAt, ends: saleEndsAt } : undefined,
        });
      } catch (e) {
        if (e instanceof PricingError) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    }

    // ✅ ШИНЭ: Худалдагч өөрчилж байвал оршин байгаа эсэхийг шалгана
    if (sellerId) {
      const seller = await prisma.seller.findUnique({ where: { id: String(sellerId) }, select: { id: true } });
      if (!seller) return res.status(400).json({ error: "Сонгосон худалдагч олдсонгүй" });
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(sku !== undefined && { sku }),
        ...(description !== undefined && { description }),
        ...(sellPrice !== undefined && { sellPrice }),
        ...(rentalPricePerDay !== undefined && { rentalPricePerDay }),
        ...(depositAmount !== undefined && { depositAmount }),
        ...(isRental !== undefined && { isRental: Boolean(isRental) }),
        ...(isCraft !== undefined && { isCraft: Boolean(isCraft) }),
        ...(sellStockQty !== undefined && { sellStockQty }),
        ...(rentalStockQty !== undefined && { rentalStockQty }),
        ...(minStockAlert !== undefined && { minStockAlert }),
        ...(imagePatch ?? {}), // ✅ ШИНЭ — imageUrl (түлхүүр) + imageUrls (олон зураг)
        ...featuredPatch, // ✅ ШИНЭ — isFeatured / featuredOrder
        ...(salePatch ?? {}), // ✅ ШИНЭ — salePercent, salePrice, saleStartsAt, saleEndsAt, priceChangedAt
        ...(publicDescription !== undefined && { publicDescription: typeof publicDescription === "string" && publicDescription.trim() ? publicDescription.trim() : null }),
        ...(categoryId !== undefined && { categoryId }),
        ...(sellerId !== undefined && { sellerId: sellerId ? String(sellerId) : null }), // ✅ ШИНЭ
        // ✅ ШИНЭ: Staff идэвхгүй болговол худалдагч порталаас дахин асааж чадахгүй (staffLocked); Staff идэвхжүүлбэл түгжээ арилна
        ...(isActive !== undefined && { isActive: Boolean(isActive), staffLocked: !Boolean(isActive) }),
        ...(color !== undefined && { color }),
        ...(size !== undefined && { size }),
        // ✅ ШИНЭ: Тусгай захиалгын тохиргоо
        ...(isCustomizable !== undefined && { isCustomizable: Boolean(isCustomizable) }),
        ...(personalizationEnabled !== undefined && { personalizationEnabled: Boolean(personalizationEnabled) }),
        ...(personalizationLabel !== undefined && { personalizationLabel }),
        ...(personalizationMaxLength !== undefined && { personalizationMaxLength }),
        ...(personalizationRequired !== undefined && { personalizationRequired: Boolean(personalizationRequired) }),
        // ✅ ШИНЭ: Материал + хэмжээгээр (талбайгаар) үнэлэх; асаавал тусгай захиалга ч автоматаар идэвхжинэ
        ...(usesMaterialPricing !== undefined && {
          usesMaterialPricing: Boolean(usesMaterialPricing),
          ...(usesMaterialPricing ? { isCustomizable: true } : {}),
        }),
        // ✅ ШИНЭ: Хувийн мэдээллийн талбарууд (өгөгдвөл; хоосон жагсаалт өгвөл цэвэрлэнэ)
        ...(customFields !== undefined && { customFields: customFieldDefs as any }),
        ...(serviceOption !== null && serviceOption), // ✅ ШИНЭ — Нэмэлт үйлчилгээ
        // ✅ ШИНЭ: Энэ бараанд зөвшөөрөгдсөн материалууд — "set" ашиглаж ХУУЧИН
        // холбоосыг БҮХЭЛД нь ШИНЭЭР сонгосноор солино (зөвхөн нэмэхгүй, хасалт ч тусгагдана).
        ...(Array.isArray(allowedMaterialIds) && {
          allowedMaterials: { set: allowedMaterialIds.map((id: string) => ({ id })) },
        }),
        ...(serviceRequiresCourierDelivery !== undefined && { serviceRequiresCourierDelivery: Boolean(serviceRequiresCourierDelivery) }), // ✅ ШИНЭ
      },
    });

    res.json(product);
  } catch (err) {
    console.error("Бүтээгдэхүүн засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Бүтээгдэхүүн засаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: ТУСГАЙ ЗАХИАЛГЫН VARIATION БҮЛЭГ УДИРДАХ (Материал/Өнгө/Хэмжээ)
// ============================================================================

// Бүтээгдэхүүний БҮХ variation бүлгийг (утгуудын хамт) авах
router.get("/:id/variations", async (req: Request, res: Response) => {
  try {
    const groups = await prisma.productVariationGroup.findMany({
      where: { productId: req.params.id },
      include: { values: { orderBy: { sortOrder: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });
    res.json(groups);
  } catch (err) {
    console.error("Variation татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

// Шинэ бүлэг (жишээ: "Материал") + утгуудыг НЭГ дор үүсгэх
// body: { name: "Материал", required: true, values: [{ value: "Хуулга", priceAdjustment: 0 }, ...] }
router.post("/:id/variations", async (req: Request, res: Response) => {
  try {
    const { name, required, allowMultiple, imageUrl, values } = req.body; // ✅ ШИНЭ — allowMultiple, imageUrl (бүлгийн ерөнхий жишээ зураг)
    if (!name || !Array.isArray(values) || values.length === 0) {
      return res.status(400).json({ error: "name болон values (дор хаяж 1) заавал шаардлагатай" });
    }

    const group = await prisma.productVariationGroup.create({
      data: {
        productId: req.params.id,
        name,
        required: required ?? true,
        allowMultiple: Boolean(allowMultiple), // ✅ ШИНЭ
        imageUrl: imageUrl ? resolveImageUrl(imageUrl) : null, // ✅ ШИНЭ
        values: {
          create: values.map((v: any, i: number) => ({
            value: v.value,
            priceAdjustment: v.priceAdjustment || 0,
            imageUrl: v.imageUrl ? resolveImageUrl(v.imageUrl) : null, // ✅ ШИНЭ — Etsy шиг swatch зураг
            sortOrder: i,
          })),
        },
      },
      include: { values: true },
    });

    res.status(201).json(group);
  } catch (err) {
    console.error("Variation бүлэг үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Үүсгэж чадсангүй" });
  }
});

// Variation бүлэг устгах (доторх утгууд Cascade-аар устна)
router.delete("/variations/:groupId", async (req: Request, res: Response) => {
  try {
    await prisma.productVariationGroup.delete({ where: { id: req.params.groupId } });
    res.json({ success: true });
  } catch (err) {
    console.error("Variation бүлэг устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Устгаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Variation бүлгийн НЭР/заавал эсэхийг засах
router.patch("/variations/:groupId", async (req: Request, res: Response) => {
  try {
    const { name, required, allowMultiple, imageUrl } = req.body; // ✅ ШИНЭ — allowMultiple, imageUrl
    const group = await prisma.productVariationGroup.update({
      where: { id: req.params.groupId },
      data: {
        ...(name !== undefined && { name }),
        ...(required !== undefined && { required }),
        ...(allowMultiple !== undefined && { allowMultiple: Boolean(allowMultiple) }), // ✅ ШИНЭ
        // ✅ ШИНЭ: Бүлгийн ерөнхий жишээ зураг (жишээ: 15 фонтыг нэг дор харуулсан хүснэгт)
        ...(imageUrl !== undefined && { imageUrl: imageUrl ? resolveImageUrl(imageUrl) : null }),
      },
    });
    res.json(group);
  } catch (err) {
    console.error("Variation бүлэг засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Засаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Тухайн бүлэгт шинэ УТГА (нэг мөр) нэмэх
router.post("/variations/:groupId/values", async (req: Request, res: Response) => {
  try {
    const { value, priceAdjustment, imageUrl } = req.body; // ✅ ШИНЭ — imageUrl
    if (!value) return res.status(400).json({ error: "value заавал шаардлагатай" });

    const count = await prisma.productVariationValue.count({ where: { groupId: req.params.groupId } });
    const created = await prisma.productVariationValue.create({
      data: {
        groupId: req.params.groupId,
        value,
        priceAdjustment: priceAdjustment || 0,
        imageUrl: imageUrl ? resolveImageUrl(imageUrl) : null, // ✅ ШИНЭ
        sortOrder: count,
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("Variation утга нэмэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэмж чадсангүй" });
  }
});

// ✅ ШИНЭ: Тухайн НЭГ утгыг засах (жишээ нь нэр эсвэл нэмэлт үнэ)
router.patch("/variations/values/:valueId", async (req: Request, res: Response) => {
  try {
    const { value, priceAdjustment, imageUrl } = req.body; // ✅ ШИНЭ — imageUrl
    const updated = await prisma.productVariationValue.update({
      where: { id: req.params.valueId },
      data: {
        ...(value !== undefined && { value }),
        ...(priceAdjustment !== undefined && { priceAdjustment }),
        ...(imageUrl !== undefined && { imageUrl: imageUrl ? resolveImageUrl(imageUrl) : null }), // ✅ ШИНЭ
      },
    });
    res.json(updated);
  } catch (err) {
    console.error("Variation утга засахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Засаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Тухайн НЭГ утгыг устгах (бусад утгууд хэвээр үлдэнэ)
router.delete("/variations/values/:valueId", async (req: Request, res: Response) => {
  try {
    await prisma.productVariationValue.delete({ where: { id: req.params.valueId } });
    res.json({ success: true });
  } catch (err) {
    console.error("Variation утга устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Устгаж чадсангүй" });
  }
});

export default router;
