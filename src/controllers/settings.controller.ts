// ============================================================================
// SETTINGS CONTROLLER — Дэлгүүрийн ерөнхий тохиргоо (Банк, Байршил, Хүргэлт)
// ----------------------------------------------------------------------------
// GET нь НЭЭЛТТЭЙ (auth шаардахгүй) — учир нь Storefront (Public) БОЛОН ПОС
// хоёул төлбөрийн дэлгэц дээрээ банкны/хүргэлтийн мэдээллийг харуулах ёстой.
// PUT нь Staff-only (requireAuth) — зөвхөн ажилтан тохиргоог өөрчилнө.
// ============================================================================

import { parseDistrictZones, parseKhorooZones, districtFee } from "../lib/delivery-district"; // ✅ ШИНЭ
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { computeDeliveryPolygon, isWithinDeliveryPolygon } from "../lib/delivery-boundary";
import { computeAutoDeliveryFee } from "../lib/delivery-zone";

const router = Router();

const SETTINGS_ID = "default";

const clampHour = (v: unknown) => Math.min(23, Math.max(0, Math.round(Number(v)) || 0)); // ✅ ШИНЭ

router.get("/", async (req: Request, res: Response) => {
  try {
    const settings = await prisma.shopSettings.findUnique({ where: { id: SETTINGS_ID } });
    const row: any = settings ?? {
        id: SETTINGS_ID,
        bankName: null,
        bankAccountNumber: null,
        bankIban: null,
        bankAccountHolder: null,
        shopAddress: null,
        shopPhone: null,
        shopLatitude: null,
        shopLongitude: null,
        saleZoneAFee: 10000,
        saleZoneBFee: 15000,
        rentalZoneAFee: 50000,
        rentalZoneBFee: 100000,
        localTransportFee: 15000,
        zoneAAutoRadiusKm: 5,
        courierCommissionPercent: 15,
        materialMarkupPercent: 100,
        serviceCommissionPercent: null,
        urgentSurchargeAmount: 0,
        errandCancelFeePercent: 20,
        nightHoldEnabled: true,
        nightStartHour: 22,
        nightEndHour: 8,
        marketplaceEnabled: false,
        sellerAcceptHours: 12,
  featuredCommissionExtraPercent: 2, // ✅ ШИНЭ — онцлох барааны худалдагчийн комиссд нэмэх %
  featuredSlotLimit: 8, // ✅ ШИНЭ — нэгэн зэрэг онцлох барааны дээд тоо
  featuredHoldMinutes: 20, // ✅ ШИНЭ — Staff зөвшөөрсний дараа төлөх хугацаа (минут)
  promoPaymentInfo: null, // ✅ ШИНЭ — онцлох байрлалын урьдчилсан төлбөрийн заавар (данс, нэр)
  saleCommissionExtraPercent: 2, // ✅ ШИНЭ — хямдралтай барааны худалдагчийн комиссд нэмэх %
  sellerReadyAutoOffer: false, // ✅ ШИНЭ — худалдагч "Бэлэн" дарахад курьерт автоматаар санал болгох эсэх (анхдагч: Staff мэдэж байж гараар)
        sellerPayoutHoldDays: 3,
      };
    // ✅ ШИНЭ: Гараар оруулсан хаягийн дүүрэг → бүс (анхдагчтай нэгтгэсэн, ҮРГЭЛЖ бүрэн 6 дүүрэг)
    res.json({ ...row, districtZones: parseDistrictZones(row.districtZones), khorooZones: parseKhorooZones(row.khorooZones) });
  } catch (err) {
    console.error("Тохиргоо татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Тохиргоо татаж чадсангүй" });
  }
});

// ============================================================================
// POST /api/settings/check-delivery-boundary — Координат хилийн бүсийн
// дотор эсэхийг шалгана (POS + Storefront хоёул дуудна — НЭГ Л ГАЗАРТ
// polygon логик байх тул давхардуулахгүй, мөн ГАДНА бол автоматаар
// бүртгэнэ).
// body: { latitude, longitude, customerPhone? }
// ============================================================================
router.post("/check-delivery-boundary", async (req: Request, res: Response) => {
  try {
    const { latitude, longitude, customerPhone } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude, longitude заавал шаардлагатай" });
    }

    const settings = await prisma.shopSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings) return res.json({ withinBoundary: true }); // Тохируулаагүй бол шалгахгүй

    // ✅ ЗАСВАР: 4 тогтмол цэгийн оронд ДУРЫН ТООНЫ цэгээс полигон тооцно
    const boundaryPoints = await prisma.deliveryBoundaryPoint.findMany({
      where: { shopSettingsId: SETTINGS_ID },
      orderBy: { sortOrder: "asc" }, // ✅ ЗАСВАР — staff-ийн өөрийнх нь дараалал
    });
    const polygon = computeDeliveryPolygon(boundaryPoints.map((p) => ({ lat: p.latitude, lng: p.longitude })));
    if (!polygon) return res.json({ withinBoundary: true }); // Хил бүрэн тохируулаагүй (3-аас цөөн цэг)

    const withinBoundary = isWithinDeliveryPolygon(latitude, longitude, polygon);

    if (!withinBoundary) {
      await prisma.deliveryBoundaryRejection
        .create({ data: { latitude, longitude, customerPhone: customerPhone || null } })
        .catch((e) => console.error("Хилийн бүртгэл хийхэд алдаа гарлаа:", e));
    }

    res.json({ withinBoundary });
  } catch (err) {
    console.error("Хил шалгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Хил шалгаж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: POST /api/settings/compute-delivery-fee — Дэлгүүрийн байршлаас
// радиусаар (Бүс А/Б) хүргэлтийн төлбөрийг АВТОМАТААР тооцож урьдчилан
// харуулна (Storefront/POS — захиалга баталгаажуулахаас ӨМНӨ).
// body: { latitude, longitude, hasRental? }
// ============================================================================
router.post("/compute-delivery-fee", async (req: Request, res: Response) => {
  try {
    const { latitude, longitude, hasRental } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude, longitude заавал шаардлагатай" });
    }

    const settings = await prisma.shopSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings) return res.status(400).json({ error: "Дэлгүүрийн тохиргоо олдсонгүй" });

    const result = await computeAutoDeliveryFee(latitude, longitude, Boolean(hasRental), {
      shopLatitude: settings.shopLatitude,
      shopLongitude: settings.shopLongitude,
      zoneAAutoRadiusKm: settings.zoneAAutoRadiusKm,
      saleZoneAFee: Number(settings.saleZoneAFee),
      saleZoneBFee: Number(settings.saleZoneBFee),
      rentalZoneAFee: Number(settings.rentalZoneAFee),
      rentalZoneBFee: Number(settings.rentalZoneBFee),
      localTransportFee: Number(settings.localTransportFee),
    });

    if (!result) {
      return res.status(400).json({ error: "Дэлгүүрийн байршил тохируулаагүй байна — Тохиргооноос оруулна уу" });
    }

    res.json(result); // { fee, zone, distanceKm }
  } catch (err) {
    console.error("Хүргэлтийн төлбөр тооцоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Тооцож чадсангүй" });
  }
});

// ============================================================================
// GET /api/settings/boundary-rejections — Хилээс гадна хүсэлтийн статистик
// (Staff-only) — сүүлийн 30 хоногийн тоо + сүүлийн 20 бичлэг.
// ============================================================================
// ============================================================================
// POST /api/settings/compute-delivery-fee-by-district — Байршлаа ГАРААР (дүүрэг/хороо) оруулсан харилцагчид
// хүргэлтийн төлбөрийг харуулна. Эцсийн үнийг захиалга үүсгэхэд сервер ДАХИН тооцно (энэ зөвхөн харуулахад).
// body: { district, hasRental? } → { zone, fee, district }
// ============================================================================
router.post("/compute-delivery-fee-by-district", async (req: Request, res: Response) => {
  try {
    const settings = await prisma.shopSettings.findUnique({ where: { id: SETTINGS_ID } });
    const fees = {
      saleZoneAFee: Number(settings?.saleZoneAFee ?? 10000),
      saleZoneBFee: Number(settings?.saleZoneBFee ?? 15000),
      rentalZoneAFee: Number(settings?.rentalZoneAFee ?? 50000),
      rentalZoneBFee: Number(settings?.rentalZoneBFee ?? 100000),
    };
    const result = districtFee(req.body?.district, (settings as any)?.districtZones, fees, Boolean(req.body?.hasRental), req.body?.khoroo, (settings as any)?.khorooZones);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ zone: result.zone, fee: result.fee, district: result.district, khoroo: result.khoroo ?? null });
  } catch (err) {
    console.error("Дүүргийн хүргэлтийн төлбөр тооцоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Тооцож чадсангүй" });
  }
});

router.get("/boundary-rejections", requireAuth, async (req: Request, res: Response) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [count, recent] = await Promise.all([
      prisma.deliveryBoundaryRejection.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.deliveryBoundaryRejection.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    res.json({ last30DaysCount: count, recent });
  } catch (err) {
    console.error("Статистик татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Статистик татаж чадсангүй" });
  }
});

router.put("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      bankName,
      bankAccountNumber,
      bankIban,
      bankAccountHolder,
      shopAddress,
      shopPhone,
      shopLatitude,
      shopLongitude,
      saleZoneAFee,
      saleZoneBFee,
      rentalZoneAFee,
      rentalZoneBFee,
      localTransportFee,
      zoneAAutoRadiusKm,
      courierCommissionPercent,
      materialMarkupPercent,
      serviceCommissionPercent,
      urgentSurchargeAmount, // ✅ ШИНЭ
      errandCancelFeePercent, // ✅ ШИНЭ
      districtZones, // ✅ ШИНЭ
      khorooZones, // ✅ ШИНЭ
      nightHoldEnabled, // ✅ ШИНЭ
      marketplaceEnabled, // ✅ ШИНЭ
      sellerAcceptHours, // ✅ ШИНЭ — худалдагч зөвшөөрөх хугацаа (цаг)
      sellerReadyAutoOffer, // ✅ ШИНЭ
      featuredCommissionExtraPercent, // ✅ ШИНЭ
      saleCommissionExtraPercent,
      promoPaymentInfo,
      featuredSlotLimit,
      featuredHoldMinutes,
      sellerPayoutHoldDays, // ✅ ШИНЭ — мөнгө олгохын өмнөх хүлээлт (өдөр)
      nightStartHour,
      nightEndHour,
    } = req.body;

    const data = {
      bankName,
      bankAccountNumber,
      bankIban,
      bankAccountHolder,
      shopAddress,
      shopPhone,
      shopLatitude,
      shopLongitude,
      ...(saleZoneAFee != null && { saleZoneAFee }),
      ...(saleZoneBFee != null && { saleZoneBFee }),
      ...(rentalZoneAFee != null && { rentalZoneAFee }),
      ...(rentalZoneBFee != null && { rentalZoneBFee }),
      ...(localTransportFee != null && { localTransportFee }),
      ...(zoneAAutoRadiusKm != null && { zoneAAutoRadiusKm }),
      ...(courierCommissionPercent != null && { courierCommissionPercent }),
      ...(materialMarkupPercent != null && { materialMarkupPercent }),
      // ✅ ШИНЭ: undefined = хөндөхгүй; null/хоосон = "хүргэлтийн хувьтай адил" болгож цэвэрлэнэ
      ...(serviceCommissionPercent !== undefined && {
        serviceCommissionPercent:
          serviceCommissionPercent === null || serviceCommissionPercent === ""
            ? null
            : Math.min(100, Math.max(0, Number(serviceCommissionPercent) || 0)),
      }),
      ...(urgentSurchargeAmount != null && { urgentSurchargeAmount: Math.max(0, Number(urgentSurchargeAmount) || 0) }), // ✅ ШИНЭ
      ...(khorooZones != null && { khorooZones: parseKhorooZones(khorooZones) as any }), // ✅ ШИНЭ — буруу дүүрэг/хороо/бүсийг цэвэрлэнэ
      ...(marketplaceEnabled != null && { marketplaceEnabled: Boolean(marketplaceEnabled) }), // ✅ ШИНЭ
      ...(featuredCommissionExtraPercent != null && Number.isFinite(Number(featuredCommissionExtraPercent)) && { featuredCommissionExtraPercent: Math.min(20, Math.max(0, Number(featuredCommissionExtraPercent))) }), // 0-20%
      ...(featuredSlotLimit != null && Number.isInteger(Number(featuredSlotLimit)) && { featuredSlotLimit: Math.min(50, Math.max(1, Number(featuredSlotLimit))) }), // 1-50
      ...(featuredHoldMinutes != null && Number.isInteger(Number(featuredHoldMinutes)) && { featuredHoldMinutes: Math.min(1440, Math.max(5, Number(featuredHoldMinutes))) }), // 5-1440 минут
      ...(promoPaymentInfo != null && { promoPaymentInfo: typeof promoPaymentInfo === "string" && promoPaymentInfo.trim() ? promoPaymentInfo.trim().slice(0, 500) : null }), // ✅ ШИНЭ
      ...(saleCommissionExtraPercent != null && Number.isFinite(Number(saleCommissionExtraPercent)) && { saleCommissionExtraPercent: Math.min(20, Math.max(0, Number(saleCommissionExtraPercent))) }),
      ...(sellerReadyAutoOffer != null && { sellerReadyAutoOffer: Boolean(sellerReadyAutoOffer) }), // ✅ ШИНЭ
      ...(sellerAcceptHours != null && { sellerAcceptHours: Math.min(168, Math.max(1, Math.round(Number(sellerAcceptHours)) || 12)) }), // 1-168 цаг
      ...(sellerPayoutHoldDays != null && { sellerPayoutHoldDays: Math.min(60, Math.max(0, Math.round(Number(sellerPayoutHoldDays)) || 0)) }), // 0-60 өдөр
      ...(nightHoldEnabled != null && { nightHoldEnabled: Boolean(nightHoldEnabled) }), // ✅ ШИНЭ
      ...(nightStartHour != null && { nightStartHour: clampHour(nightStartHour) }),
      ...(nightEndHour != null && { nightEndHour: clampHour(nightEndHour) }),
      ...(districtZones != null && { districtZones: parseDistrictZones(districtZones) as any }), // ✅ ШИНЭ — буруу дүүрэг/бүсийг цэвэрлэнэ
      ...(errandCancelFeePercent != null && { errandCancelFeePercent: Math.min(100, Math.max(0, Number(errandCancelFeePercent) || 0)) }), // ✅ ШИНЭ — курьерийн илгээмж авсны дараа цуцалбал суутгах хувь
    };

    const settings = await prisma.shopSettings.upsert({
      where: { id: SETTINGS_ID },
      update: data,
      create: { id: SETTINGS_ID, ...data },
    });

    res.json(settings);
  } catch (err) {
    console.error("Тохиргоо шинэчлэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Тохиргоо шинэчилж чадсангүй" });
  }
});

// ============================================================================
// ✅ ШИНЭ: Хилийн ЦЭГҮҮД удирдах (дурын тоо, GET/POST/DELETE)
// ============================================================================
router.get("/boundary-points", async (req: Request, res: Response) => {
  try {
    const points = await prisma.deliveryBoundaryPoint.findMany({
      where: { shopSettingsId: SETTINGS_ID },
      orderBy: { sortOrder: "asc" }, // ✅ ЗАСВАР — staff-ийн өөрийнх нь дараалал
    });
    res.json(points);
  } catch (err) {
    console.error("Хилийн цэг татахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Татаж чадсангүй" });
  }
});

router.post("/boundary-points", requireAuth, async (req: Request, res: Response) => {
  try {
    const { latitude, longitude, label } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude, longitude заавал шаардлагатай" });
    }
    // ✅ ШИНЭ: Дараалалд ХАМГИЙН СҮҮЛД (жагсаалтын төгсгөлд) нэмнэ
    const maxOrder = await prisma.deliveryBoundaryPoint.aggregate({
      where: { shopSettingsId: SETTINGS_ID },
      _max: { sortOrder: true },
    });
    const point = await prisma.deliveryBoundaryPoint.create({
      data: { latitude, longitude, label, shopSettingsId: SETTINGS_ID, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1 },
    });
    res.status(201).json(point);
  } catch (err) {
    console.error("Хилийн цэг нэмэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Нэмж чадсангүй" });
  }
});

router.delete("/boundary-points/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    await prisma.deliveryBoundaryPoint.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Хилийн цэг устгахад алдаа гарлаа:", err);
    res.status(500).json({ error: "Устгаж чадсангүй" });
  }
});

// ✅ ШИНЭ: Бүх цэгийн ДАРААЛЛЫГ (sortOrder) нэг дор шинэчлэх — staff
// жагсаалтыг дээш/доош дараад дараалал өөрчлөхөд ашиглана.
// body: { orderedIds: string[] } — эхнийх нь sortOrder=0, дараагийнх нь 1, г.м.
router.put("/boundary-points/reorder", requireAuth, async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: "orderedIds массив заавал шаардлагатай" });
    }

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.deliveryBoundaryPoint.update({ where: { id }, data: { sortOrder: index } })
      )
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Дараалал шинэчлэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Шинэчилж чадсангүй" });
  }
});

export default router;
