// ============================================================================
// PUBLIC CONTROLLER — Гаднын худалдан авагчдад зориулсан e-commerce API
// ----------------------------------------------------------------------------
// ⚠️ ЭНЭ router-т requireAuth ХЭЗЭЭ Ч БҮҮ НЭМ — гаднын хэрэглэгч Staff
// эрхгүй тул JWT байхгүй. Үүний оронд аюулгүй байдлыг өөр аргаар хангана:
//
//   1. Зөвхөн НИЙТЭД ЗОРИУЛСАН талбаруудыг л буцаана (costPrice, minStockAlert
//      мэт дотоод мэдээлэл орохгүй)
//   2. Order/GatewayTransaction-ийн UUID өөрөө "нууц токен" шиг үүрэг
//      гүйцэтгэнэ (30+ тэмдэгттэй санамсаргүй ID таамаглах боломжгүй тул
//      захиалгынхаа ЗӨВХӨН өөрийн ID-гаар л статусаа шалгаж чадна)
//   3. server.ts дээр энэ бүхэл router-т rate-limit тавьсан (спам/халдлагаас
//      хамгаална)
//   4. Захиалга үүсгэх, төлбөр эхлүүлэх зэрэг БҮХ БИЗНЕС ЛОГИК (үнэ
//      тооцоолол, rental боломж шалгалт) ижил order.service.ts/
//      rental-availability.service.ts-ээр дамждаг тул Staff болон Public
//      хоёр өөр дүрэм баримталдаггүй — АЮУЛГҮЙ БАЙДЛЫН ЦОГЦ НЭГ Л ЦЭГТ
//      (service давхарга) байрладаг.
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { checkout, cancelOrder, CheckoutValidationError, OrderCancellationError } from "../services/order.service";
import { checkoutCart } from "../services/marketplace-checkout.service"; // ✅ ШИНЭ — сагсыг худалдагчаар хуваана
import { getGroupRemaining } from "../services/order-payment.service"; // ✅ ШИНЭ
import { signCustomerToken } from "../lib/customer-tracking";
import { publicProductSellerFilter, normalizeSlug } from "../lib/seller"; // ✅ ШИНЭ
import { galleryOf } from "../lib/product-images"; // ✅ ШИНЭ — барааны олон зураг
import { PUBLIC_PRODUCT_INCLUDE, toPublicProduct } from "../lib/public-product"; // ✅ ШИНЭ
import { getRatingMap, listPublicReviews } from "../services/review.service"; // ✅ ШИНЭ
import { getHomeSections } from "../services/home.service";
import { getSimilarProducts, SimilarError } from "../services/similar.service";
import { ReviewError } from "../lib/reviews";
import { buildCategoryCards } from "../lib/category-cards"; // ✅ ШИНЭ — ангиллын зураг, барааны тоо
import { getPublicSeller, SellerError } from "../services/seller.service";
import rateLimit from "express-rate-limit";
import { quoteMaterial, MaterialError } from "../services/material.service";
import { parseStoredCustomFieldDefs } from "../lib/custom-fields";

// ✅ ШИНЭ: Хэмжээ бичих бүрд үнэ шинэчлэгддэг тул нийтлэг 15мин/100 хязгаар хурдан дуусна —
// үнэ тооцоход минутад 60 хүсэлт (нэг IP-с) зөвшөөрнө.
const materialQuoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Хэт олон хүсэлт илгээгдлээ. Түр хүлээгээд дахин оролдоно уу." },
});
import { RentalUnavailableError, checkAvailability } from "../services/rental-availability.service";
import { createGatewayInvoice, InvalidProviderError } from "../services/invoice.service";
import { markDepositHeldManually, RentalLifecycleError } from "../services/deposit.service";
import { GatewayProvider, GatewayPurpose, PaymentMethod } from "@prisma/client";
import { emitToStore } from "../realtime/socket";
import { expireStaleOnlineOrders } from "../services/order-cleanup.service";

const router = Router();

// ============================================================================
// GET /api/public/categories — Ангиллын мод (нийтэд)
// ============================================================================
router.get("/categories", async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
    // ✅ ШИНЭ (Etsy шиг): ангилал бүрт зураг (өөрийн эсвэл эхний барааных) + нийт барааны тоо. Marketplace унтраатай үед худалдагчийн бараа тоологдохгүй.
    const marketplaceRow = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    const visible = await prisma.product.findMany({
      where: { isActive: true, AND: [publicProductSellerFilter(Boolean((marketplaceRow as any)?.marketplaceEnabled))] },
      select: { categoryId: true, imageUrl: true },
      orderBy: { name: "asc" },
    });
    res.json(buildCategoryCards(categories as any, visible as any));
  } catch (err) {
    console.error("Ангилал татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Ангилал татаж чадсангүй" });
  }
});

// ============================================================================
// GET /api/public/products — Барааны каталог (нийтэд, аюулгүй талбарууд л)
// query: ?categoryId=&search=&color=&size=
// ============================================================================
// ✅ ШИНЭ: Худалдагчийн shop хуудас (зөвхөн идэвхтэй; банк, комисс, утас гарахгүй)
router.get("/sellers/:slug", async (req: Request, res: Response) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const mp = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    if (!slug || !(mp as any)?.marketplaceEnabled) return res.status(404).json({ error: "Shop олдсонгүй" }); // Marketplace унтраатай бол shop хуудас байхгүй
    res.json(await getPublicSeller(slug));
  } catch (err) {
    if (err instanceof SellerError) return res.status(err.status).json({ error: err.message });
    console.error("Shop хуудас татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Shop татаж чадсангүй" });
  }
});

// ✅ ШИНЭ (Etsy шиг): Нүүр хуудасны мөрүүд — онцлох, шинэ, эрэлттэй, өндөр үнэлгээтэй
router.get("/home", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(await getHomeSections());
  } catch (err) {
    console.error("Нүүр хуудасны мөр татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Нүүр хуудасны мэдээлэл татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Төстэй бараа
router.get("/products/:id/similar", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(await getSimilarProducts(req.params.id, Number(req.query.limit) || 8));
  } catch (err) {
    if (err instanceof SimilarError) return res.status(err.status).json({ error: err.message });
    console.error("Төстэй бараа татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Төстэй бараа татаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Барааны үнэлгээ (хувилбартай бүлгийн олон productId): ?productIds=a,b,c&limit=10&offset=0
router.get("/reviews", async (req: Request, res: Response) => {
  try {
    const ids = String(req.query.productIds ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(await listPublicReviews(ids, Number(req.query.limit) || 10, Number(req.query.offset) || 0));
  } catch (err) {
    if (err instanceof ReviewError) return res.status(err.status).json({ error: err.message });
    console.error("Үнэлгээ татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Үнэлгээ татаж чадсангүй" });
  }
});

router.get("/products", async (req: Request, res: Response) => {
  try {
    const { categoryId, search, color, size, seller } = req.query as {
      seller?: string; // ✅ ШИНЭ — shop-ийн холбоос (slug)
      categoryId?: string;
      search?: string;
      color?: string;
      size?: string;
    };

    // ✅ ШИНЭ: Marketplace унтраатай үед худалдагчийн бараа огт харагдахгүй
    const marketplaceRow = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    const marketplaceOn = Boolean((marketplaceRow as any)?.marketplaceEnabled);

    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        // ✅ ШИНЭ: Манай өөрийн бараа + ИДЭВХТЭЙ худалдагчийн бараа л харагдана (PENDING/SUSPENDED нуугдана)
        AND: [publicProductSellerFilter(marketplaceOn)],
        ...(seller && marketplaceOn ? { seller: { slug: String(seller).toLowerCase(), status: "ACTIVE" as const } } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(color ? { color: { equals: color, mode: "insensitive" } } : {}),
        ...(size ? { size: { equals: size, mode: "insensitive" } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { color: { contains: search, mode: "insensitive" } },
                { size: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: PUBLIC_PRODUCT_INCLUDE,
            orderBy: { name: "asc" },
    });

    // ⚠️ ЗӨВХӨН нийтэд зориулсан талбаруудыг л буцаана — costPrice,
    // minStockAlert, дотоод бараа зэрэг ил гартал болохгүй мэдээлэл алгасна.
    // ✅ ШИНЭ: үнэлгээний дундаж (нэг асуулгаар) + нийтийн хэлбэр (lib/public-product — /home, /similar-тай ИЖИЛ)
    const ratings = await getRatingMap(products.map((p) => p.id));
    const publicProducts = products.map((p) => toPublicProduct(p, ratings.get(p.id)));

    res.json(publicProducts);
  } catch (err) {
    console.error("Бараа татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Бараа татаж чадсангүй" });
  }
});

// ============================================================================
// POST /api/public/rentals/check-availability — Түрээсийн боломж шалгах
// ============================================================================
router.post("/rentals/check-availability", async (req: Request, res: Response) => {
  try {
    // ✅ ШИНЭ: Хугацаа хэтэрсэн (2+ цаг) PENDING захиалгуудыг цэвэрлэж,
    // тэдгээрийн хааж байсан огноог чөлөөлнө — эс бөгөөс хуурамч/орхигдсон
    // захиалга бодит боломжийг мөнхөд хааж орхино.
    await expireStaleOnlineOrders().catch((e) => console.error("Автомат цэвэрлэгээ алдаа:", e));

    const { productId, startDate, endDate, quantity } = req.body;
    if (!productId || !startDate || !endDate) {
      return res.status(400).json({ error: "productId, startDate, endDate заавал байх ёстой" });
    }

    const result = await checkAvailability({
      productId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      requestedQty: quantity || 1,
    });

    res.json(result);
  } catch (err) {
    console.error("Боломж шалгахад алдаа гарлаа:", err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// ============================================================================
// POST /api/public/orders — Худалдан авагч ЗАХИАЛГА үүсгэх
// ----------------------------------------------------------------------------
// body: {
//   customerName, customerPhone,   ← Staff мэдээлэл огт байхгүй (public тул)
//   items: [{ productId, itemType: "SALE"|"RENTAL", quantity, startDate?, endDate? }]
// }
// ----------------------------------------------------------------------------
// Дотроо ЯГ ижил checkout() service ашигладаг тул: сервер талын үнэ
// тооцоолол, rental race-safe баталгаажуулалт зэрэг БҮХ бизнесийн дүрэм
// Staff-ийн POS захиалгатай 100% ижил хэрэгждэг.
// ============================================================================
router.post("/orders", async (req: Request, res: Response) => {
  try {
    const { customerName, customerPhone, items, deliveryMethod, deliveryAddress, deliveryFee, deliveryLatitude, deliveryLongitude, deliveryDistrict, deliveryKhoroo } = req.body;

    if (!customerName || !customerPhone) {
      return res.status(400).json({ error: "customerName болон customerPhone заавал шаардлагатай" });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Захиалгад дор хаяж 1 бараа байх ёстой" });
    }

    // ---- Харилцагчийг олох/үүсгэх (upsert — давхардуулахгүй) ----
    // ✅ ЗАСВАР: update: {} байсан тул ижил утасны дугаараар ДАХИН
    // захиалахад шинэ (магадгүй засварласан/өөр) нэрийг ОГТ шинэчилдэггүй
    // байсан — эхний удаагийн нэр мөнхөд хадгалагдаж, POS дээр буруу нэр
    // харагддаг байв. Одоо ХАМГИЙН СҮҮЛД оруулсан нэрийг ашиглана.
    const customer = await prisma.customer.upsert({
      where: { phone: customerPhone },
      update: { name: customerName },
      create: { name: customerName, phone: customerPhone },
    });

    const order: any = await checkoutCart({
      customerId: customer.id,
      orderType: "ONLINE", // ⚠️ ЯМАРЧ ТОХИОЛДОЛД "POS" болгож болохгүй — гаднаас ирж байгаа тул
      storeId: "default",
      items,
      deliveryMethod, // ✅ ШИНЭ
      deliveryAddress, // ✅ ШИНЭ
      deliveryFee, // ✅ ШИНЭ
      deliveryLatitude, // ✅ ШИНЭ
      deliveryLongitude, // ✅ ШИНЭ
      deliveryDistrict, // ✅ ШИНЭ — гараар оруулсан үед дүүргээр үнэлнэ
      deliveryKhoroo, // ✅ ШИНЭ — хорооны бүс
    });

    // ✅ ШИНЭ: Хяналтын хуудасны токен — харилцагч захиалгаа хэзээ ч (OTP кодтой нь) дахин нээж харна
    // Худалдагчийн хэсэгтэй сагс бол захиалга бүрийн хяналтын токен + хүргэлтийн код буцаана (харилцагч бүгдийг нь харна)
    const groupOrders = Array.isArray(order.groupOrders) ? order.groupOrders.map((g: any) => ({ ...g, trackingToken: signCustomerToken(g.id) })) : undefined;
    res.status(201).json({ ...order, ...(groupOrders ? { groupOrders } : {}), trackingToken: signCustomerToken(order.id) });
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof RentalUnavailableError) {
      return res.status(409).json({
        error: "Уучлаарай, нэг эсвэл хэд хэдэн бараа энэ хугацаанд дутуу байна.",
        availableQty: err.availableQty,
      });
    }
    console.error("Нээлттэй захиалга үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга үүсгэж чадсангүй" });
  }
});

// ============================================================================
// GET /api/public/orders/:id — Захиалгын төлөв шалгах
// ----------------------------------------------------------------------------
// Аюулгүй байдал: :id (UUID) өөрөө л "нэвтрэх түлхүүр" — зөвхөн захиалгаа
// хийсэн хэрэглэгч л энэ ID-г мэднэ (checkout()-ийн хариунаас авсан байх
// ёстой).
// ============================================================================
router.get("/orders/:id", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { product: { select: { name: true, imageUrl: true, color: true, size: true } }, rentalDetail: true } },
      },
    });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    res.json(order);
  } catch (err) {
    console.error("Захиалга татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга татаж чадсангүй" });
  }
});

// ============================================================================
// POST /api/public/orders/:id/invoice — Тухайн захиалгын төлбөр/барьцаа Invoice
// body: { provider: "QPAY"|"SOCIALPAY", purpose: "ORDER_PAYMENT"|"DEPOSIT",
//         amount, description, rentalDetailId? }
// ----------------------------------------------------------------------------
// ⚠️ purpose=ORDER_PAYMENT үед orderId нь URL-ийн :id (сервер тал өөрөө
// холбоно) — худалдан авагч БУСДЫН orderId-г бичиж чадахгүй тул захиалга
// зөрчигдөхгүй.
// ============================================================================
router.post("/orders/:id/invoice", async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    const { provider, purpose, amount, description, rentalDetailId, combinedDepositRentalIds } = req.body;

    // ✅ ШИНЭ (marketplace): Бүлгийн (нэг сагсны) захиалгын төлбөр нь БҮЛГИЙН ҮЛДЭГДЛЭЭС бага байж болохгүй —
    // харилцагч эсвэл клиент дүнг багасгаж "хэсэгчилсэн" төлбөрөөр худалдагчийн захиалгыг бүрэн төлөгдсөн болгохоос сэргийлнэ.
    if (purpose === "ORDER_PAYMENT") {
      const groupLeft = await getGroupRemaining(order.id);
      if (groupLeft !== null && !(Number(amount) >= groupLeft)) {
        return res.status(400).json({ error: `Төлбөрийн дүн сагсны нийт үлдэгдэл (${groupLeft}₮)-өөс бага байж болохгүй` });
      }
    }

    const result = await createGatewayInvoice({
      provider: provider as GatewayProvider,
      purpose: purpose as GatewayPurpose,
      amount,
      description,
      orderId: purpose === "ORDER_PAYMENT" ? order.id : undefined,
      rentalDetailId: purpose === "DEPOSIT" ? rentalDetailId : undefined,
      combinedDepositRentalIds: purpose === "ORDER_PAYMENT" ? combinedDepositRentalIds : undefined, // ✅ ШИНЭ
    });

    res.json(result);
  } catch (err) {
    if (err instanceof InvalidProviderError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Нээлттэй invoice үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Invoice үүсгэж чадсангүй" });
  }
});

// ============================================================================
// GET /api/public/payments/status/:gatewayTransactionId — Polling
// ============================================================================
router.get("/payments/status/:gatewayTransactionId", async (req: Request, res: Response) => {
  // ⚠️ ЗААВАЛ: Polling endpoint-ыг browser/proxy КЭШЛЭХГҮЙ байх ёстой —
  // эс бөгөөс Express-ийн анхдагч ETag-аас болж хэрэглэгч ХУУЧИН (кэшилсэн)
  // статусыг үзэж, төлбөр бодитоор баталгаажсан ч "хүлээгдэж байна" гэсэн
  // хэвээр харагдана.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  const tx = await prisma.gatewayTransaction.findUnique({
    where: { id: req.params.gatewayTransactionId },
  });
  if (!tx) return res.status(404).json({ error: "Олдсонгүй" });

  res.json({ status: tx.status, paidAt: tx.paidAt });
});

// ============================================================================
// POST /api/public/orders/:id/cancel — Худалдан авагч захиалгаа цуцлах
// ----------------------------------------------------------------------------
// Аюулгүй байдал: :id (UUID) өөрөө "нэвтрэх түлхүүр" (бусад public route-той
// адил зарчим) — захиалгаа хийсэн хэрэглэгч л энэ ID-г мэднэ.
// ============================================================================
router.post("/orders/:id/cancel", async (req: Request, res: Response) => {
  try {
    await cancelOrder(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof OrderCancellationError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Захиалга цуцлахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Захиалга цуцалж чадсангүй" });
  }
});

// ============================================================================
// POST /api/public/rentals/:id/deposit/document — Бичиг баримтаар барьцаалах
// body: { documentDescription: string }
// ----------------------------------------------------------------------------
// ⚠️ Аюулгүй байдлын АНХААРУУЛГА: Энэ endpoint auth шаардахгүй тул зөвхөн
// "MONEY биш, DOCUMENT" горимоор л ажиллана (Staff-ийн PENDING мөнгийг
// баталгаагүйгээр HELD болгодог "MONEY" сонголтыг АЛГАСНА) — учир нь
// нээлттэй интернэтээс "мөнгө өгсөн" гэж хэн ч мэдэгдэж чадах эрсдэлтэй.
// Энэ функцийг зөвхөн кассчин хажууд нь байж, бодит бичиг баримтыг
// шалгасны дараа хэрэглэгчээр товч дарж баталгаажуулуулах (kiosk маягийн)
// хэрэглээнд зориулав.
// ============================================================================
router.post("/rentals/:id/deposit/document", async (req: Request, res: Response) => {
  try {
    const { documentDescription } = req.body;
    const rentalDetail = await markDepositHeldManually(req.params.id, {
      depositType: "DOCUMENT",
      documentDescription,
    });
    res.json(rentalDetail);
  } catch (err) {
    if (err instanceof RentalLifecycleError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Нээлттэй барьцаа бүртгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Барьцаа бүртгэж чадсангүй" });
  }
});

// ============================================================================
// POST /api/public/rentals/:id/deposit/bank-transfer — Барьцааг дансаар
// body: { note?: string }
// ----------------------------------------------------------------------------
// ✅ ЗАСВАР: ШУУД HELD БОЛГОХГҮЙ — учир нь худалдан авагч өөрөө "шилжүүлсэн"
// гэж мэдэгдэхэд мөнгө бодитоор ирсэн эсэхийг ХЭН Ч шалгадаггүй байсан.
// Одоо зөвхөн АЖИЛТАНД realtime мэдэгдэл илгээгээд, ТЭР ажилтан өөрийн
// банкны SMS-тэй тулгаад, ПОС дотроос ГАРААР баталгаажуулна (Идэвхтэй
// түрээс → "Барьцаа бүртгэх" товч).
// ============================================================================
router.post("/rentals/:id/deposit/bank-transfer", async (req: Request, res: Response) => {
  try {
    const { note } = req.body;

    const rentalDetail = await prisma.rentalDetail.findUnique({
      where: { id: req.params.id },
      include: { orderItem: { include: { order: { include: { customer: true } }, product: true } } },
    });
    if (!rentalDetail) return res.status(404).json({ error: "Түрээс олдсонгүй" });

    const order = rentalDetail.orderItem.order;
    emitToStore(order.storeId, "bank_transfer_claimed", {
      purpose: "DEPOSIT",
      orderId: order.id,
      orderNumber: order.orderNumber,
      rentalDetailId: rentalDetail.id,
      productName: rentalDetail.orderItem.product.name,
      amount: Number(rentalDetail.depositAmount),
      customerName: order.customer?.name ?? "Танихгүй",
      customerPhone: order.customer?.phone ?? null,
      note: note || null,
      claimedAt: new Date().toISOString(),
    });

    res.json({ success: true, pending: true });
  } catch (err) {
    console.error("Дансаар шилжүүлэлтийн мэдэгдэл илгээхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Мэдэгдэл илгээж чадсангүй" });
  }
});

// ============================================================================
// POST /api/public/orders/:id/pay/bank-transfer — Дансаар шилжүүлэлт
// body: { note?: string } — гүйлгээний утга/дугаар (заавал биш)
// ----------------------------------------------------------------------------
// ✅ ЗАСВАР: Мөн адил — ШУУД PAID БОЛГОХГҮЙ, зөвхөн ажилтанд мэдэгдэнэ.
// Ажилтан SMS-ээрээ баталгаажуулаад, Захиалгын түүх → "Төлөв өөрчлөх"
// (эсвэл PaymentFlow-ийн Дансаар алхмаар) ГАРААР PAID болгоно.
// ============================================================================
router.post("/orders/:id/pay/bank-transfer", async (req: Request, res: Response) => {
  try {
    const { note } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { customer: true, requestingCourier: { select: { name: true } } },
    });
    if (!order) return res.status(404).json({ error: "Захиалга олдсонгүй" });

    emitToStore(order.storeId, "bank_transfer_claimed", {
      purpose: "ORDER_PAYMENT",
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: Number(order.totalAmount) - Number(order.paidAmount),
      customerName: order.customer?.name ?? order.requestingCourier?.name ?? "Танихгүй", // ✅ ШИНЭ — илгээмжид илгээгч курьерийн нэр
      customerPhone: order.customer?.phone ?? null,
      note: note || (order.orderType === "COURIER_ERRAND" ? "Курьерийн илгээмж" : null),
      claimedAt: new Date().toISOString(),
    });

    res.json({ success: true, pending: true });
  } catch (err) {
    console.error("Дансаар шилжүүлэлтийн мэдэгдэл илгээхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Мэдэгдэл илгээж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: МАТЕРИАЛ (нээлттэй) — Storefront/POS тусгай захиалгад материал сонгоход.
// ⚠️ Өртөг, нэмэх хувь, нөөцийг ХЭЗЭЭ Ч буцаахгүй — зөвхөн нэр, хавтангийн хэмжээ,
// бөгөөд үнийг СЕРВЕР тооцож (POST /materials/quote) зөвхөн эцсийн дүнг өгнө.
// ============================================================================
router.get("/materials", async (_req: Request, res: Response) => {
  try {
    const materials = await prisma.material.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sheetWidthCm: true, sheetHeightCm: true, imageUrl: true }, // ✅ ШИНЭ — imageUrl (Etsy шиг swatch)
    });
    res.json(materials);
  } catch (err) {
    console.error("Материал татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Материал татаж чадсангүй" });
  }
});

// body: { materialId, widthCm, heightCm } → { areaCm2, widthCm, heightCm, price }
router.post("/materials/quote", materialQuoteLimiter, async (req: Request, res: Response) => {
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

export default router;

// ============================================================================
// GET /api/public/products/:id/components — Багцын орцын дэлгэрэнгүй
// ----------------------------------------------------------------------------
// Storefront-д зориулав — компонент бараа бүрийн нэр/өнгө/хэмжээ/зураг л
// буцаана (description-г ОРУУЛААГҮЙ — энэ бол зөвхөн POS-ийн боломж).
// ============================================================================
router.get("/products/:id/components", async (req: Request, res: Response) => {
  try {
    const recipes = await prisma.craftRecipe.findMany({
      where: { productId: req.params.id },
      include: { material: { select: { name: true, color: true, size: true, imageUrl: true } } },
    });

    const components = recipes.map((r) => ({
      name: r.material.name,
      color: r.material.color,
      size: r.material.size,
      imageUrl: r.material.imageUrl,
      quantity: r.quantity,
    }));

    res.json(components);
  } catch (err) {
    console.error("Багцын орц татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Орц татаж чадсангүй" });
  }
});
