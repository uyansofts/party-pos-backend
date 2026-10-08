// ============================================================================
// ORDER SERVICE — Checkout (захиалга үүсгэх) цөм логик
// ----------------------------------------------------------------------------
// АРХИТЕКТУРЫН 2 ГОЛ ШИЙДЭЛ:
//
// 1. ҮНИЙГ СЕРВЕР ТАЛ ДАХИН ТООЦНО, КЛИЕНТЭЭС ИТГЭХГҮЙ.
//    Хэрэглэгч (Flutter апп) unitPrice дамжуулсан ч бид ашиглахгүй —
//    Product.sellPrice / rentalPricePerDay-с ШУУД сервер дээрээ дахин
//    тооцно. Ингэснээр клиент талын код өөрчлөгдөж үнийг хуурамчаар
//    бууруулах боломжгүй болно (энэ бол санхүүгийн систем дэх ҮНДСЭН дүрэм).
//
// 2. ЗАХИАЛГА + ТҮРЭЭСИЙН БАТАЛГААЖУУЛАЛТ = НЭГ АТОМИК ТРАНЗАКЦ.
//    reserveRentalWithinTx()-ийг ЯГ ЭНЭ функцийн нээсэн prisma.$transaction
//    дотор дуудна (шинэ transaction нээхгүй). Хэрэв нэг ч RENTAL мөр
//    боломжгүй бол ХАМГИЙН ЭХНИЙ SALE мөр хүртэл БҮХЭЛДЭЭ rollback хийгдэж,
//    захиалга огт үүсэхгүй — "хагас баталгаажсан захиалга" гэж зүйл ХЭЗЭЭ Ч
//    үүсэхгүй.
// ============================================================================

import { OrderType, OrderItemType, PayStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { applySale } from "../lib/pricing"; // ✅ ШИНЭ — хямдрал: бараа бүрийн ӨӨРИЙН үнийн хэсэгт (суурь, материал, түрээсийн өдрийн үнэ)
import { reserveRentalWithinTx, RentalUnavailableError } from "./rental-availability.service";
import { computeDeliveryPolygon, isWithinDeliveryPolygon } from "../lib/delivery-boundary";
import { computeAutoDeliveryFee } from "../lib/delivery-zone";
import { resolveDeliveryFee, DeliveryFeeError } from "../lib/delivery-district";
import { quoteMaterial, MaterialError } from "./material.service";
import { resolveNeededByDate, computeIsUrgent, assertCancelAllowed, OrderUrgencyError, parseNeededByDate, assertNeededByNotPast, urgentThresholdHoursFor } from "../lib/order-urgency";
import {
  parseStoredCustomFieldDefs,
  validateCustomFieldValues,
  summarizeCustomFieldValues,
  CustomFieldError,
  type CustomFieldValue,
} from "../lib/custom-fields";


export interface CheckoutItemInput {
  productId: string;
  itemType: "SALE" | "RENTAL";
  quantity: number;
  // RENTAL мөрд ЗААВАЛ шаардлагатай:
  startDate?: string; // ISO огноо
  endDate?: string;
  // ✅ ШИНЭ: Тусгай захиалга (Variation сонголт + чөлөөт бичвэр)
  customizationText?: string;
  customizationDeadline?: string; // ✅ ШИНЭ — ISO огноо, "хэзээ хэрэгтэй"
  selectedVariationValueIds?: string[]; // ProductVariationValue.id-ийн жагсаалт
  // ✅ ШИНЭ: Материал + хэмжээгээр (талбайгаар) үнэлэгдэх бараанд (Product.usesMaterialPricing)
  materialId?: string;
  widthCm?: number;
  heightCm?: number;
  // ✅ ШИНЭ: Хувийн мэдээлэл — { талбарын key: утга } (жишээ: { f1: "Анхилуун", f2: "08:08" })
  customFieldValues?: Record<string, string>;
  // ✅ ШИНЭ: Нэмэлт үйлчилгээ сонгосон эсэх (жишээ: бөмбөлгөн чимэглэлийг биднээр хийлгэх)
  serviceRequested?: boolean;
  // ✅ ШИНЭ: "Хэзээ хэрэгтэй вэ" — зөвхөн ЗАРАХ (SALE) захиалгад ЗААВАЛ; түрээст автоматаар (эхлэх огноо) тооцогдоно
  neededByDate?: string | null;
}

export interface CheckoutInput {
  customerId?: string;
  staffId?: string;
  orderType?: "POS" | "ONLINE";
  storeId?: string;
  items: CheckoutItemInput[];
  // ✅ ШИНЭ: Хүргэлтийн мэдээлэл
  deliveryMethod?: "PICKUP" | "DELIVERY" | "POST" | "LOCAL_TRANSPORT" | "UB_CAB";
  deliveryAddress?: string;
  deliveryFee?: number;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  deliveryKhoroo?: number | string; // ✅ ШИНЭ — Хороо: дүүргийн бүсийг хороогоор нарийвчилна
  deliveryDistrict?: string; // ✅ ШИНЭ — Байршлаа ГАРААР оруулсан үед (координатгүй) дүүрэг: үнийг бүсээр тооцно
}

/** ✅ ШИНЭ (marketplace): checkout-ийн нэмэлт тохиргоо — худалдагчийн хэсгийг үүсгэхэд marketplace-checkout.service ашиглана. */
export interface CheckoutOptions {
  /** Худалдагчийн барааг ЗӨВХӨН checkoutCart (онлайн сагс)-аар захиална — POS болон бусад шууд checkout дуудлагад хориглоно */
  allowSellerItems?: boolean;
  /** Хүргэлтийн үнийг ЭНЭ цэгээс (худалдагчийн хаяг) тооцно; null бол дэлгүүрийн байршил */
  originOverride?: { latitude: number; longitude: number } | null;
  /** Order.create data-д нэмэх талбарууд. itemsTotal = хүргэлтгүй барааны дүн, generateOtp = 4 оронтой код */
  orderExtras?: (ctx: { itemsTotal: number; generateOtp: () => string; lines: Array<{ productId: string; subtotal: number }> }) => Record<string, unknown>;
}

export class CheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutValidationError";
  }
}

export class OrderCancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderCancellationError";
  }
}

/**
 * ЗАХИАЛГА ЦУЦЛАХ — Staff (order.controller.ts) БОЛОН нээлттэй худалдан
 * авагч (public.controller.ts) хоёулаа ЯГ ИЖИЛ энэ функцийг дуудна —
 * логик 2 газар давхардахгүй.
 * ----------------------------------------------------------------------------
 * ⚠️ ХОЛБОГДОХ RentalDetail бүрийг ч CANCELLED болгодог — эс бөгөөс BOOKED
 * хэвээр үлдэж, тэр өдрүүд МӨНХӨД "захиалагдсан" гэж хаагдана.
 */
export async function cancelOrder(orderId: string, confirmedOverdueCancel = false) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { rentalDetail: true } } },
  });
  if (!order) throw new OrderCancellationError("Захиалга олдсонгүй");

  if (order.paymentStatus === PayStatus.PAID || order.paymentStatus === PayStatus.CANCELLED) {
    throw new OrderCancellationError(`Энэ захиалга "${order.paymentStatus}" төлөвт байгаа тул цуцлах боломжгүй`);
  }

  // ✅ ШИНЭ: "Хэзээ хэрэгтэй вэ" (neededByDate) 24 цагийн дотор эсвэл аль
  // хэдийн өнгөрсөн бол, Staff ЗААВАЛ баталгаажуулаагүй л бол цуцлахгүй.
  try {
    assertCancelAllowed({ neededByDate: order.neededByDate, urgentThresholdHours: (order as any).urgentThresholdHours }, confirmedOverdueCancel);
  } catch (err) {
    if (err instanceof OrderUrgencyError) throw new OrderCancellationError("NEEDS_CONFIRMATION");
    throw err;
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: PayStatus.CANCELLED },
      });

      for (const item of order.items) {
        if (item.rentalDetail) {
          await tx.rentalDetail.update({
            where: { id: item.rentalDetail.id },
            data: { rentalStatus: "CANCELLED" },
          });
        }
      }
    },
    { timeout: 15000 } // ✅ ШИНЭ — анхдагч 5000мс дутуу байсан тул нэмэгдүүлэв
  );
}

export function generateOrderNumber(orderType: string): string {
  // ✅ ШИНЭ: COURIER_ERRAND-д тусдаа "ERR" угтвар (тайланд ялгаж харахад)
  const prefix = orderType === "ONLINE" ? "ORD" : orderType === "COURIER_ERRAND" ? "ERR" : "POS";
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * Захиалга үүсгэх (Checkout) — SALE болон RENTAL мөрүүдийг холилдуулан
 * дэмжинэ (жишээ нь: баллон зарж, тавилга нэгэн зэрэг түрээслэх).
 *
 * @throws CheckoutValidationError — оролтын өгөгдөл дутуу/буруу бол
 * @throws RentalUnavailableError — RENTAL мөр хугацаандаа боломжгүй бол
 *         (transaction автоматаар БҮХЭЛДЭЭ rollback хийгдэнэ)
 */
export async function checkout(input: CheckoutInput, options: CheckoutOptions = {}) {
  if (!input.items || input.items.length === 0) {
    throw new CheckoutValidationError("Захиалгад дор хаяж 1 бараа байх ёстой");
  }

  // ✅ ШИНЭ: Түрээсийн бараа орон нутагт (Монгол Шуудан/Унаа) хүргэгдэхгүй —
  // зөвхөн ӨӨРӨӨ ОЧИЖ АВАХ эсвэл УБ ХОТЫН ДОТОРХ хүргэлт л боломжтой.
  // Клиент талын шалгалтыг тойрч болзошгүй тул сервер дээр ЗААВАЛ хориглоно.
  const hasRentalItem = input.items.some((i) => i.itemType === "RENTAL");
  if (hasRentalItem && (input.deliveryMethod === "POST" || input.deliveryMethod === "LOCAL_TRANSPORT")) {
    throw new CheckoutValidationError(
      "Түрээсийн бараа орон нутагт (Монгол Шуудан/Унаа) хүргэгдэхгүй — зөвхөн өөрөө очиж авах, UB Cab, эсвэл манай унаагаар хотын дотор хүргэлт сонгоно уу"
    );
  }

  // ✅ ШИНЭ: "Дэлгүүрийн хүргэлт" (DELIVERY) нь ЗӨВХӨН тохируулсан хилийн
  // (Баруун/Зүүн/Хойд/Урд) 4 цэгээс тооцсон бүсийн дотор л боломжтой.
  // Клиент GPS координатаа заасан (ирүүлсэн) тохиолдолд л энд шалгана —
  // Google Maps линкээс координат гаргаж авах боломжгүй тул тэр тохиолдолд
  // энэ шалгалт алгасагдана (клиент талд дүүргийн жагсаалтаар цомхотгосон).
  if (
    input.deliveryMethod === "DELIVERY" &&
    input.deliveryLatitude != null &&
    input.deliveryLongitude != null
  ) {
    const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
    if (settings) {
      // ✅ ЗАСВАР: 4 тогтмол цэгийн оронд ДУРЫН ТООНЫ цэгээс полигон тооцно
      const boundaryPoints = await prisma.deliveryBoundaryPoint.findMany({
        where: { shopSettingsId: "default" },
        orderBy: { sortOrder: "asc" }, // ✅ ЗАСВАР — staff-ийн өөрийнх нь дараалал
      });
      const polygon = computeDeliveryPolygon(boundaryPoints.map((p) => ({ lat: p.latitude, lng: p.longitude })));
      if (polygon && !isWithinDeliveryPolygon(input.deliveryLatitude, input.deliveryLongitude, polygon)) {
        // ✅ ШИНЭ: Хилээс гадна байрлалаас хүргэлт хүссэн оролдлогыг
        // бүртгэнэ — бизнес бүсээ өргөтгөх эсэхээ статистикаар шийднэ.
        await prisma.deliveryBoundaryRejection
          .create({
            data: {
              latitude: input.deliveryLatitude,
              longitude: input.deliveryLongitude,
              customerPhone: input.customerId
                ? (await prisma.customer.findUnique({ where: { id: input.customerId } }))?.phone
                : null,
            },
          })
          .catch((e) => console.error("Хилийн бүртгэл хийхэд алдаа гарлаа:", e));

        throw new CheckoutValidationError(
          "Уучлаарай, таны байршил манай хүргэлтийн бүсээс (хотын төв) гадна байна. Та 'Өөрөө очиж авах' эсвэл 'UB Cab' сонгоно уу."
        );
      }
    }
  }

  const orderType = (input.orderType ?? "POS") as OrderType;
  const storeId = input.storeId ?? "default";

  return prisma.$transaction(
    async (tx) => {
    // ---------- 1. Бараа бүрийн ҮНИЙГ СЕРВЕР ТАЛ дахин тооцно ----------
    let totalAmount = 0;
    const preparedItems: Array<{
      productId: string;
      itemType: OrderItemType;
      quantity: number;
      unitPrice: number;
      subtotal: number;
      rental?: { startDate: Date; endDate: Date; dailyRate: number; depositAmount: number };
      customizationText?: string | null;
      customizationDeadline?: Date | null;
      selectedVariations?: Record<string, string> | null;
      // ✅ ШИНЭ: Материал + хэмжээ
      materialId?: string | null;
      materialNameSnapshot?: string | null;
      widthCm?: number | null;
      heightCm?: number | null;
      areaCm2?: number | null;
      materialCostSnapshot?: number | null;
      materialPriceSnapshot?: number | null;
      customFieldValues?: CustomFieldValue[] | null; // ✅ ШИНЭ
      serviceRequested?: boolean; // ✅ ШИНЭ
      isSpecial?: boolean; // ✅ ШИНЭ — Тусгай захиалга (isCustomizable / материалаар үнэлэгдэх / үйлчилгээ захиалсан) → яаралтайн босго 48 цаг
      serviceLabelSnapshot?: string | null;
      serviceFeeSnapshot?: number | null;
    }> = [];

    // ✅ ШИНЭ: Нэмэлт үйлчилгээний нийт төлбөр (НЭГ удаагийн — түрээсийн хоногоор үржихгүй)
    let serviceAmountTotal = 0;
    const serviceLabels = new Set<string>();
    let needsCourierForService = false; // ✅ ШИНЭ — курьер шаардсан үйлчилгээтэй бараа байвал true

    for (const item of input.items) {
      const product = await tx.product.findUniqueOrThrow({
        where: { id: item.productId },
        include: { allowedMaterials: { select: { id: true } } }, // ✅ ШИНЭ — бараанд зөвшөөрөгдсөн материал шалгахад
      });

      // ✅ ШИНЭ: Түдгэлзсэн/идэвхжээгүй худалдагчийн барааг захиалах боломжгүй (сагсанд өмнө нь орсон байсан ч)
      if (product.sellerId) {
        // Худалдагчийн бараа зөвхөн marketplace сагсаар (checkoutCart) захиалагдана — POS/бусад шууд дуудлагад хориглоно
        if (!options.allowSellerItems) throw new CheckoutValidationError(`"${product.name}" — худалдагчийн барааг зөвхөн онлайн сагсаар захиална`);
        const marketplaceRow = await tx.shopSettings.findUnique({ where: { id: "default" } });
        if (!(marketplaceRow as any)?.marketplaceEnabled) throw new CheckoutValidationError(`"${product.name}" бараа одоогоор захиалах боломжгүй`); // Marketplace нээгдээгүй
        const seller = await tx.seller.findUnique({ where: { id: product.sellerId }, select: { status: true } });
        if (!seller || seller.status !== "ACTIVE") throw new CheckoutValidationError(`"${product.name}" бараа одоогоор захиалах боломжгүй`);
      }

      // ✅ ШИНЭ: Тусгай захиалгын Variation сонголтуудыг шалгаж, нэмэлт
      // үнийг (priceAdjustment) тооцно. Мөн ЗААВАЛ шаардлагатай (personalization
      // required) бол текст хоосон биш эсэхийг шалгана.
      let variationPriceAdjustment = 0;
      let selectedVariationsMap: Record<string, string> | null = null;
      let customFieldValues: CustomFieldValue[] = []; // ✅ ШИНЭ

      if (product.isCustomizable) {
        if (product.personalizationEnabled && product.personalizationRequired && !item.customizationText?.trim()) {
          throw new CheckoutValidationError(`"${product.name}" барааны хувьд "${product.personalizationLabel || "бичих текст"}" заавал бөглөх ёстой`);
        }
        if (product.personalizationEnabled && item.customizationText && product.personalizationMaxLength) {
          if (item.customizationText.length > product.personalizationMaxLength) {
            throw new CheckoutValidationError(`"${product.name}"-ий текст ${product.personalizationMaxLength} тэмдэгтээс ихгүй байх ёстой`);
          }
        }

        const groups = await tx.productVariationGroup.findMany({
          where: { productId: item.productId },
          include: { values: true },
        });

        selectedVariationsMap = {};
        const selectedIds = new Set(item.selectedVariationValueIds || []);

        for (const group of groups) {
          // ✅ ЗАСВАР: Ганц (find) биш, БҮХ тохирох утгыг (filter) авна — олон
          // сонголттой (allowMultiple) бүлэгт хэдэн ч утга зэрэг сонгогдож
          // болно, үнэ тус бүрээр нь нэмэгдэнэ (жишээ: бөмбөлгийн 4 өнгө).
          const chosenValues = group.values.filter((v) => selectedIds.has(v.id));
          if (chosenValues.length === 0) {
            if (group.required) {
              throw new CheckoutValidationError(`"${product.name}" барааны "${group.name}" сонголтыг заавал хийнэ үү`);
            }
            continue;
          }
          if (!group.allowMultiple && chosenValues.length > 1) {
            throw new CheckoutValidationError(`"${product.name}" барааны "${group.name}" сонголтод зөвхөн НЭГ утга сонгоно уу`);
          }
          selectedVariationsMap[group.name] = chosenValues.map((v) => v.value).join(", ");
          for (const v of chosenValues) variationPriceAdjustment += Number(v.priceAdjustment);
        }

        // ✅ ШИНЭ: Олон талбартай хувийн мэдээлэл (нэр, төрсөн цаг, өндөр, жин г.м.) — сервер шалгана
        const fieldDefs = parseStoredCustomFieldDefs(product.customFields);
        if (fieldDefs.length > 0) {
          try {
            customFieldValues = validateCustomFieldValues(fieldDefs, item.customFieldValues);
          } catch (err) {
            if (err instanceof CustomFieldError) {
              throw new CheckoutValidationError(`"${product.name}": ${err.message}`);
            }
            throw err;
          }
        }
      }

      // ✅ ШИНЭ: Бөглөсөн талбарууд байвал нэг мөр хураангуйг customizationText-д (Тусгай захиалгын
      // жагсаалт, хугацааны сануулга, харагдац бүгд үүнийг ашигладаг) хамт хадгална.
      const fieldsSummary = summarizeCustomFieldValues(customFieldValues);
      const ownText = item.customizationText?.trim() || "";
      const customizationTextFinal = fieldsSummary ? (ownText ? `${ownText} · ${fieldsSummary}` : fieldsSummary) : ownText || null;
      const hasCustomInfo = customFieldValues.length > 0 || ownText !== "";

      // ✅ ШИНЭ: Нэмэлт үйлчилгээ (жишээ: бөмбөлгөн чимэглэлийг биднээр хийлгэх) — НЭГ удаагийн төлбөр
      let serviceRequested = false;
      let serviceCharge = 0;
      if (item.serviceRequested) {
        if (!product.serviceEnabled) {
          throw new CheckoutValidationError(`"${product.name}" бараанд нэмэлт үйлчилгээ байхгүй байна`);
        }
        serviceRequested = true;
        serviceCharge = Number(product.serviceFee ?? 0) * item.quantity;
        serviceAmountTotal += serviceCharge;
        serviceLabels.add(product.serviceLabel || "Нэмэлт үйлчилгээ");
        // ✅ ШИНЭ: Барааны тохиргоогоор — зарим үйлчилгээ (жишээ: арк угсрах) газар дээр нь
        // хийгддэг тул ЗААВАЛ курьер, зарим нь (бэлдээд өгдөг, жишээ: бөмбөлгөн чимэглэл)
        // ямар ч аргаар авч болно.
        if (product.serviceRequiresCourierDelivery) needsCourierForService = true;
      }

      if (item.itemType === "SALE") {
        // ✅ ШИНЭ: Материалаар үнэлэгдэх бараанд үндсэн үнэ (sellPrice) заавал биш — 0 эсвэл
        // загварын/ажлын үнэ байж болно. Үнийг клиентээс ИТГЭЛГҮЙ, СЕРВЕР дээр талбайгаар тооцно.
        // ✅ ШИНЭ: хямдрал идэвхтэй бол хямдралын үнэ (сервер дээр тооцно — клиентээс итгэхгүй)
        const saleAt = new Date();
        const rawBase = product.sellPrice != null ? Number(product.sellPrice) : null;
        const configuredBase = rawBase == null ? null : applySale(product as any, rawBase, saleAt); // суурь үнэд хямдрал
        if (!product.usesMaterialPricing && configuredBase == null) {
          throw new CheckoutValidationError(`"${product.name}" барааны зарах үнэ тохируулаагүй байна`);
        }

        let materialFields: {
          materialId: string;
          materialNameSnapshot: string;
          widthCm: number;
          heightCm: number;
          areaCm2: number;
          materialCostSnapshot: number;
          materialPriceSnapshot: number;
        } | null = null;
        if (product.usesMaterialPricing) {
          // ✅ ШИНЭ: Бараанд ТОДОРХОЙ материал зөвшөөрсөн бол (жишээ: cake topper зөвхөн
          // акрилаар) сонгосон материал заавал тэр жагсаалтад байх ёстой. Хоосон бол
          // (staff тохируулаагүй) БҮХ идэвхтэй материалыг зөвшөөрнө — хуучин зан төлөвтэй нийцнэ.
          if (product.allowedMaterials.length > 0 && !product.allowedMaterials.some((m) => m.id === item.materialId)) {
            throw new CheckoutValidationError(`"${product.name}" бараанд энэ материалыг ашиглах боломжгүй`);
          }
          try {
            const q = await quoteMaterial(item.materialId, item.widthCm, item.heightCm, tx);
            materialFields = {
              materialId: q.material.id,
              materialNameSnapshot: q.material.name,
              widthCm: q.widthCm,
              heightCm: q.heightCm,
              areaCm2: q.areaCm2,
              materialCostSnapshot: q.quote.cost,
              materialPriceSnapshot: q.quote.price,
            };
          } catch (err) {
            if (err instanceof MaterialError) {
              throw new CheckoutValidationError(`"${product.name}": ${err.message}`);
            }
            throw err;
          }
        }

        // Хямдрал: суурь үнэ БОЛОН материалын үнэд тус тусад нь (материалын snapshot нь жагсаалтын үнээр хадгалагдана — өртөгтэй харьцуулах); вариацын нэмэгдэл, үйлчилгээнд хамаарахгүй
        const unitPrice = (configuredBase ?? 0) + applySale(product as any, materialFields?.materialPriceSnapshot ?? 0, saleAt) + variationPriceAdjustment;
        const subtotal = unitPrice * item.quantity + serviceCharge; // ✅ ШИНЭ — үйлчилгээний төлбөр нэг удаа нэмэгдэнэ
        totalAmount += subtotal;
        preparedItems.push({
          productId: item.productId,
          itemType: OrderItemType.SALE,
          quantity: item.quantity,
          unitPrice,
          subtotal,
          customizationText: customizationTextFinal,
          serviceRequested, // ✅ ШИНЭ
          isSpecial: !!(product.isCustomizable || product.usesMaterialPricing || serviceRequested),
          serviceLabelSnapshot: serviceRequested ? product.serviceLabel ?? null : null,
          serviceFeeSnapshot: serviceRequested ? Number(product.serviceFee ?? 0) : null,
          customFieldValues: customFieldValues.length > 0 ? customFieldValues : null, // ✅ ШИНЭ
          customizationDeadline: item.customizationDeadline ? new Date(item.customizationDeadline) : null,
          selectedVariations: selectedVariationsMap,
          ...(materialFields ?? {}), // ✅ ШИНЭ — материал, хэмжээ, талбай, өртөг/үнийн snapshot
        });
      } else {
        // ---- RENTAL мөр ----
        if (product.usesMaterialPricing) {
          throw new CheckoutValidationError(`"${product.name}" нь материалаар үнэлэгддэг бараа тул зөвхөн худалдаж авах боломжтой`);
        }
        if (!product.isRental || product.rentalPricePerDay == null) {
          throw new CheckoutValidationError(`"${product.name}" бараа түрээслэгддэггүй`);
        }
        if (!item.startDate || !item.endDate) {
          throw new CheckoutValidationError(`"${product.name}"-д startDate/endDate заавал шаардлагатай`);
        }

        const startDate = new Date(item.startDate);
        const endDate = new Date(item.endDate);
        if (startDate >= endDate) {
          throw new CheckoutValidationError("Түрээсийн эхлэх огноо дуусах огнооноос өмнө байх ёстой");
        }

        // Хямдрал: түрээсийн ӨДРИЙН үнэд (барьцаа, үйлчилгээ, вариацын нэмэгдэлд хамаарахгүй)
        const dailyRate = applySale(product as any, Number(product.rentalPricePerDay), new Date()) + variationPriceAdjustment;
        const depositAmount = Number(product.depositAmount ?? 0);
        const rentalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const subtotal = dailyRate * rentalDays * item.quantity + serviceCharge; // ✅ ШИНЭ — үйлчилгээ хоногоор ҮРЖИГДЭХГҮЙ
        totalAmount += subtotal;

        preparedItems.push({
          productId: item.productId,
          itemType: OrderItemType.RENTAL,
          quantity: item.quantity,
          unitPrice: dailyRate,
          subtotal,
          rental: { startDate, endDate, dailyRate, depositAmount },
          customizationText: customizationTextFinal,
          serviceRequested, // ✅ ШИНЭ
          serviceLabelSnapshot: serviceRequested ? product.serviceLabel ?? null : null,
          serviceFeeSnapshot: serviceRequested ? Number(product.serviceFee ?? 0) : null,
          customFieldValues: customFieldValues.length > 0 ? customFieldValues : null, // ✅ ШИНЭ
          // ✅ ШИНЭ: Хувийн мэдээлэлтэй түрээсийн хуулга/бэлтгэл ажил түрээс эхлэхээс 1 өдрийн ӨМНӨ
          // бэлэн байх ёстой — гараар хугацаа өгөөгүй бол автоматаар тавина.
          customizationDeadline: item.customizationDeadline
            ? new Date(item.customizationDeadline)
            : hasCustomInfo
            ? new Date(startDate.getTime() - 24 * 60 * 60 * 1000)
            : null,
          selectedVariations: selectedVariationsMap,
        });
      }
    }

    // ✅ ЗАСВАР: БҮХ чимэглэлтэй захиалга биш, ЗӨВХӨН "курьер заавал" гэж
    // тохируулсан бараатай (жишээ: газар дээр нь угсрах арк) захиалгыг л
    // ЗӨВХӨН манай курьерийн хүргэлтээр (DELIVERY) хязгаарлана. "Бэлдээд
    // өгдөг" (жишээ: бөмбөлгөн чимэглэл) үйлчилгээ ямар ч аргаар явна.
    if (needsCourierForService && (input.deliveryMethod ?? "PICKUP") !== "DELIVERY") {
      throw new CheckoutValidationError(
        "Энэ үйлчилгээг газар дээр нь хийх шаардлагатай тул зөвхөн манай курьерийн хүргэлтээр авна — хүргэлтийн хаяг, байршлаа оруулна уу"
      );
    }

    // ---------- 2. Order + OrderItem-үүдийг үүсгэнэ ----------
    const hasRentalInOrder = preparedItems.some((p) => p.itemType === "RENTAL");

    // ✅ ЗАСВАР: Хүргэлтийн төлбөрийг client-ээс ИТГЭМЖЛЭЛГҮЙгээр авахын
    // оронд, дэлгүүрийн байршлаас радиусаар (Бүс А: radiuskm дотор, Бүс
    // Б: гадна) BACKEND дээр ХАТУУ автоматаар тооцно. Дэлгүүрийн байршил
    // тохируулаагүй бол хуучин зан төлөв (client-ийн дүнг итгэж авах)
    // хэвээр үлдэнэ.
    // ✅ ЗАСВАР (санхүүгийн алдаа): Харилцагчийн (ONLINE) хүргэлтийн үнийг СЕРВЕР талд ХАТУУ тооцно —
    // координат → замын зайгаар Бүс А/Б; зөвхөн дүүрэг (гараар) → дүүргийн бүсээр; аль нь ч үгүй бол татгалзана.
    // Өмнө нь гараар оруулбал координатгүй тул клиентийн (0) үнийг итгэж, хүргэлт ҮНЭГҮЙ болдог байсан.
    const shopSettings = await tx.shopSettings.findUnique({ where: { id: "default" } });
    let deliveryFee: number;
    try {
      const resolved = await resolveDeliveryFee({
        orderType: input.orderType ?? "POS",
        method: input.deliveryMethod ?? "PICKUP",
        clientFee: input.deliveryFee,
        lat: input.deliveryLatitude,
        lng: input.deliveryLongitude,
        district: input.deliveryDistrict,
        khoroo: input.deliveryKhoroo,
        hasRental: hasRentalInOrder,
        settings: shopSettings
          ? {
              saleZoneAFee: Number(shopSettings.saleZoneAFee),
              saleZoneBFee: Number(shopSettings.saleZoneBFee),
              rentalZoneAFee: Number(shopSettings.rentalZoneAFee),
              rentalZoneBFee: Number(shopSettings.rentalZoneBFee),
              localTransportFee: Number(shopSettings.localTransportFee),
              districtZones: (shopSettings as any).districtZones,
              khorooZones: (shopSettings as any).khorooZones,
            }
          : null,
        autoFee: async () =>
          shopSettings && input.deliveryLatitude != null && input.deliveryLongitude != null
            ? computeAutoDeliveryFee(input.deliveryLatitude, input.deliveryLongitude, hasRentalInOrder, {
                shopLatitude: options.originOverride?.latitude ?? shopSettings.shopLatitude, // ✅ ШИНЭ — худалдагчийн хаягаас
                shopLongitude: options.originOverride?.longitude ?? shopSettings.shopLongitude,
                zoneAAutoRadiusKm: shopSettings.zoneAAutoRadiusKm,
                saleZoneAFee: Number(shopSettings.saleZoneAFee),
                saleZoneBFee: Number(shopSettings.saleZoneBFee),
                rentalZoneAFee: Number(shopSettings.rentalZoneAFee),
                rentalZoneBFee: Number(shopSettings.rentalZoneBFee),
                localTransportFee: Number(shopSettings.localTransportFee),
              })
            : null,
      });
      deliveryFee = resolved.fee;
    } catch (err) {
      if (err instanceof DeliveryFeeError) throw new CheckoutValidationError(err.message);
      throw err;
    }
    const finalTotalAmount = totalAmount + deliveryFee; // ✅ Хүргэлтийн үнийг нийт дүнд нэмнэ

    // ✅ ШИНЭ: "Хэзээ хэрэгтэй вэ" (neededByDate) — Түрээст эхлэх огнооноос
    // автоматаар, Зарахад client-ээс ЗААВАЛ ирсэн байх ёстой (хамгийн эрт
    // огноог сонгоно, олон мөр байвал). 24ц дотор бол яаралтай нэмэгдэл.
    const rentalStartDates = preparedItems.filter((p) => p.rental).map((p) => p.rental!.startDate);
    const earliestRentalStart = rentalStartDates.length > 0 ? new Date(Math.min(...rentalStartDates.map((d) => d.getTime()))) : null;
    const saleNeededDates = input.items.filter((i) => i.itemType === "SALE" && i.neededByDate).map((i) => parseNeededByDate(i.neededByDate)!); // ✅ ШИНЭ — "YYYY-MM-DD" (зөвхөн өдөр) бол тэр өдрийн төгсгөл (23:59 УБ)
    const earliestSaleNeeded = saleNeededDates.length > 0 ? new Date(Math.min(...saleNeededDates.map((d) => d.getTime()))) : null;

    let neededByDate: Date;
    try {
      neededByDate = resolveNeededByDate({ neededByDate: earliestSaleNeeded }, hasRentalInOrder, earliestRentalStart);
      // ✅ ШИНЭ: Харилцагч ӨНГӨРСӨН өдрийг сонгож чадахгүй (өнөөдөр болон дараа нь л)
      if ((input.orderType ?? "POS") === "ONLINE" && !hasRentalInOrder) assertNeededByNotPast(neededByDate);
    } catch (err) {
      if (err instanceof OrderUrgencyError) throw new CheckoutValidationError(err.message);
      throw err;
    }
    // ✅ ШИНЭ: Яаралтайн босго — энгийн худалдах бараа 24 цаг, түрээс/тусгай захиалга 48 цаг (холимог бол урт нь)
    const urgentThresholdHours = urgentThresholdHoursFor({ hasRental: hasRentalInOrder, hasSpecial: preparedItems.some((p) => p.isSpecial) });
    const isUrgent = computeIsUrgent(neededByDate, new Date(Date.now()), urgentThresholdHours * 3600000);
    const shopSettingsForUrgency = await tx.shopSettings.findUnique({ where: { id: "default" } });
    const urgentFee = isUrgent ? Number(shopSettingsForUrgency?.urgentSurchargeAmount ?? 0) : 0;
    const finalTotalWithUrgency = finalTotalAmount + urgentFee;

    // ✅ ШИНЭ: Манай курьер хүргэдэг захиалгад (DELIVERY) л OTP код
    // үүсгэнэ — Staff Pickup/UB Cab/Шуудан зэрэгт хэрэггүй.
    const needsOtp = (input.deliveryMethod ?? "PICKUP") === "DELIVERY";
    const generateOtp = () => Math.floor(1000 + Math.random() * 9000).toString(); // 4 оронтой

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(orderType),
        customerId: input.customerId,
        staffId: input.staffId,
        orderType,
        storeId,
        totalAmount: finalTotalWithUrgency,
        paidAmount: 0,
        paymentStatus: PayStatus.PENDING,
        deliveryMethod: input.deliveryMethod ?? "PICKUP",
        deliveryAddress: input.deliveryAddress,
        deliveryFee,
        serviceAmount: serviceAmountTotal, // ✅ ШИНЭ — Чимэглэл г.м. нэмэлт үйлчилгээний нийт төлбөр
        serviceLabel: serviceLabels.size > 0 ? Array.from(serviceLabels).join(", ") : null,
        neededByDate, // ✅ ШИНЭ
        isUrgent, // ✅ ШИНЭ
        urgentThresholdHours, // ✅ ШИНЭ — цуцлалтын хамгаалалт яг ижил босгыг ашиглана
        urgentFee, // ✅ ШИНЭ
        deliveryLatitude: input.deliveryLatitude,
        deliveryLongitude: input.deliveryLongitude,
        deliveryOtp: needsOtp ? generateOtp() : null, // ✅ ШИНЭ
        returnOtp: needsOtp && hasRentalInOrder ? generateOtp() : null, // ✅ ШИНЭ — зөвхөн түрээст
        ...(options.orderExtras ? options.orderExtras({ itemsTotal: totalAmount, generateOtp, lines: preparedItems.map((i: any) => ({ productId: i.productId, subtotal: Number(i.subtotal) })) }) : {}), // ✅ ШИНЭ — худалдагч, комисс, авах хаяг, авах код
        items: {
          create: preparedItems.map((p) => ({
            productId: p.productId,
            itemType: p.itemType,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            subtotal: p.subtotal,
            customizationText: p.customizationText, // ✅ ШИНЭ
            customizationDeadline: p.customizationDeadline, // ✅ ШИНЭ
            selectedVariations: p.selectedVariations ?? undefined, // ✅ ШИНЭ
            materialId: p.materialId ?? undefined, // ✅ ШИНЭ — Материал + хэмжээ
            materialNameSnapshot: p.materialNameSnapshot ?? undefined,
            widthCm: p.widthCm ?? undefined,
            heightCm: p.heightCm ?? undefined,
            areaCm2: p.areaCm2 ?? undefined,
            materialCostSnapshot: p.materialCostSnapshot ?? undefined,
            materialPriceSnapshot: p.materialPriceSnapshot ?? undefined,
            customFieldValues: (p.customFieldValues ?? undefined) as any, // ✅ ШИНЭ
            serviceRequested: p.serviceRequested ?? false, // ✅ ШИНЭ — Нэмэлт үйлчилгээ
            serviceLabelSnapshot: p.serviceLabelSnapshot ?? undefined,
            serviceFeeSnapshot: p.serviceFeeSnapshot ?? undefined,
          })),
        },
      },
      include: { items: true },
    });

    // ---------- 3. RENTAL мөр бүрийг ЯГ ЭНЭ ТРАНЗАКЦИЙН ДОТОР баталгаажуулна ----------
    // order.items[i]-ийн дараалал нь preparedItems-тэй ЯГ АДИЛ (Prisma nested
    // create нь оруулсан дарааллаараа буцаадаг) тул индексээр зэрэгцүүлж болно.
    for (let i = 0; i < preparedItems.length; i++) {
      const prepared = preparedItems[i];
      if (prepared.itemType === OrderItemType.RENTAL && prepared.rental) {
        const createdOrderItem = order.items[i];
        // Энд throw хийвэл prisma.$transaction БҮХЭЛДЭЭ rollback хийж,
        // дээр үүсгэсэн Order, бүх OrderItem устана — "хагас захиалга" гарахгүй.
        await reserveRentalWithinTx(tx, {
          orderItemId: createdOrderItem.id,
          productId: prepared.productId,
          startDate: prepared.rental.startDate,
          endDate: prepared.rental.endDate,
          dailyRate: prepared.rental.dailyRate,
          depositAmount: prepared.rental.depositAmount,
        });
      }
    }

    // ---------- 4. Бүрэн дүрсийг буцаана (rentalDetail-үүдтэй хамт) ----------
    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        items: { include: { product: true, rentalDetail: true } },
        customer: true,
      },
    });
    },
    { timeout: 15000 } // ✅ ШИНЭ — RENTAL мөр олонтой захиалгад анхдагч 5000мс дутуу байсан
  );
}

export { RentalUnavailableError };
