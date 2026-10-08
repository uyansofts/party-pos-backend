// ============================================================================
// MARKETPLACE CHECKOUT — Нэг сагсыг худалдагчаар ХУВААЖ бодит захиалгууд болгоно.
//   • Манай өөрийн бараа → 1 захиалга (дэлгүүрээс), худалдагч бүр → тусдаа захиалга (худалдагчийн хаягаас)
//   • Захиалга бүр өөрийн курьер, хүргэлтийн код, хяналт, комиссын snapshot-той — одоогийн механизм ЯГ ИЖИЛ ажиллана
//   • Харилцагч НЭГ л төлбөр хийнэ: бүх захиалга orderGroupId (= үндсэн захиалгын id)-аар холбогдоно,
//     төлбөрийг order-payment.service-ийн applyOrderPayment бүлгээр нь хуваарилна
//   • Худалдагчийн хэсэг үүсгэхэд алдаа гарвал өмнө үүссэн хэсгүүдийг БҮГДИЙГ цуцална (хагас сагс үлдэхгүй)
// ============================================================================

import { prisma } from "../lib/prisma";
import { checkout, cancelOrder, CheckoutInput, CheckoutValidationError } from "./order.service";
import { computeCommission, partitionItemsBySeller } from "../lib/marketplace";
import { computeSellerCommission, isSaleActive } from "../lib/pricing";
import { isFeaturedNow } from "../lib/featured"; // ✅ ШИНЭ — онцлох/хямдралтай барааны нэмэлт шимтгэл

interface SellerRow {
  id: string;
  name: string;
  status: string;
  commissionPercent: number;
  pickupAddress: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
}

async function compensate(created: Array<{ order: { id: string } }>) {
  for (const c of created) {
    try {
      await cancelOrder(c.order.id, true); // түрээсийн нөөц, төлөв бүгдийг одоо байгаа логикоор чөлөөлнө
    } catch (err) {
      console.error(`Сагсны хэсэг (${c.order.id}) цуцлахад алдаа гарлаа — Staff гараар цуцална уу:`, err);
    }
  }
}

export async function checkoutCart(input: CheckoutInput) {
  const items = input.items ?? [];
  if (items.length === 0) return checkout(input); // "дор хаяж 1 бараа" гэсэн одоогийн алдаа

  const ids = Array.from(new Set(items.map((i) => i.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sellerId: true, isFeatured: true, featuredUntil: true, sellPrice: true, salePrice: true, salePercent: true, saleStartsAt: true, saleEndsAt: true } });
  const sellerOf = new Map<string, string | null>(products.map((p) => [p.id, p.sellerId ?? null]));

  // Худалдагчийн бараагүй сагс → ХУУЧИН урсгал огт өөрчлөгдөхгүй
  if (!items.some((i) => sellerOf.get(i.productId))) return checkout(input);

  if ((input.orderType ?? "POS") !== "ONLINE") {
    throw new CheckoutValidationError("Худалдагчийн барааг зөвхөн онлайн захиалгаар зарна");
  }
  const settings = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  if (!(settings as any)?.marketplaceEnabled) {
    throw new CheckoutValidationError("Худалдагчийн барааны захиалга одоогоор нээгдээгүй байна");
  }
  // Худалдагчийн бараа манай курьерээр (Улаанбаатар дотор) л хүргэгдэнэ — Шуудан/өөрөө авах/UB Cab боломжгүй
  if (input.deliveryMethod !== "DELIVERY") {
    throw new CheckoutValidationError("Худалдагчийн бараа зөвхөн манай курьерээр (Улаанбаатар хот дотор) хүргэгдэнэ — \"Манай унаагаар хүргүүлэх\" сонгоно уу");
  }

  // ✅ ШИНЭ: Онцлох (isFeatured) болон ХЯМДРАЛ идэвхтэй барааны шимтгэл арай өндөр (тохиргоо: 0-20%-ийн нэмэлт)
  const checkoutAt = new Date();
  const flags = new Map<string, { featured: boolean; onSale: boolean }>(products.map((p: any) => [p.id, { featured: isFeaturedNow(p, checkoutAt), onSale: isSaleActive(p, checkoutAt) }]));
  const extras = { featured: Number((settings as any)?.featuredCommissionExtraPercent ?? 2), sale: Number((settings as any)?.saleCommissionExtraPercent ?? 2) };

  const parts = partitionItemsBySeller(items, sellerOf);
  const sellerIds = parts.map((p) => p.sellerId).filter((x): x is string => !!x);
  const sellerRows = (await prisma.seller.findMany({ where: { id: { in: sellerIds } } })) as unknown as SellerRow[];
  const sellers = new Map(sellerRows.map((s) => [s.id, s]));
  for (const sid of sellerIds) {
    const seller = sellers.get(sid);
    if (!seller || seller.status !== "ACTIVE") {
      throw new CheckoutValidationError(`"${seller?.name ?? "Худалдагч"}" одоогоор захиалга авахгүй байна — сагснаасаа тэдний барааг хасна уу`);
    }
  }

  const created: Array<{ order: any; seller: SellerRow | null }> = [];
  try {
    for (const part of parts) {
      const seller = part.sellerId ? sellers.get(part.sellerId)! : null;
      const order = await checkout(
        { ...input, items: part.items },
        seller
          ? {
              allowSellerItems: true,
              originOverride: seller.pickupLatitude != null && seller.pickupLongitude != null ? { latitude: seller.pickupLatitude, longitude: seller.pickupLongitude } : null,
              orderExtras: ({ itemsTotal, generateOtp, lines }) => {
                // Мөр бүр өөрийн хувиар (онцлох/хямдралтай бол нэмэлттэй); commissionPercent = жинлэсэн дундаж (харуулахад), commissionAmount = ҮНЭН
                const c = lines && lines.length > 0 ? computeSellerCommission(lines, flags, seller.commissionPercent, extras) : null;
                return {
                sellerId: seller.id,
                sellerStatus: "PENDING_PAYMENT", // Төлбөр орсны дараа л худалдагчид мэдэгдэж, AWAITING_SELLER болно
                commissionPercent: c ? c.effectivePercent : seller.commissionPercent,
                commissionAmount: c ? c.commissionAmount : computeCommission(itemsTotal, seller.commissionPercent).commissionAmount,
                // Курьер худалдагчийн хаягаас очиж авна; авахдаа худалдагчаас авсан КОДыг (pickupOtp) оруулна
                pickupAddress: seller.pickupAddress,
                pickupLatitude: seller.pickupLatitude,
                pickupLongitude: seller.pickupLongitude,
                pickupOtp: generateOtp(),
                };
              },
            }
          : { allowSellerItems: false }
      );
      created.push({ order, seller });
    }
  } catch (err) {
    await compensate(created);
    throw err;
  }

  // Бүлэг: бүх захиалга ҮНДСЭН (эхний) захиалгын id-г заана. Төлбөр ҮНДСЭН захиалгаар дамжин бүгдэд хуваарилагдана.
  const primary = created[0].order;
  await prisma.order.updateMany({ where: { id: { in: created.map((c) => c.order.id) } }, data: { orderGroupId: primary.id } });

  const orders = created.map((c) => c.order);
  const sum = (pick: (o: any) => unknown) => orders.reduce((s, o) => s + Number(pick(o) ?? 0), 0);
  const groupTotal = sum((o) => o.totalAmount);
  return {
    ...primary,
    orderGroupId: primary.id,
    // Төлбөрийн урсгал (QPay/данс) НИЙТ дүнгээр ажиллана — үндсэн захиалгын id-аар
    totalAmount: groupTotal,
    deliveryFee: sum((o) => o.deliveryFee),
    items: orders.flatMap((o) => o.items), // барьцааны (түрээс) мөрүүд нэгтгэгдэнэ
    groupTotalAmount: groupTotal,
    groupOrders: created.map((c) => ({
      id: c.order.id,
      orderNumber: c.order.orderNumber,
      sellerName: c.seller?.name ?? null,
      totalAmount: Number(c.order.totalAmount),
      deliveryFee: Number(c.order.deliveryFee),
      deliveryOtp: c.order.deliveryOtp ?? null,
    })),
  };
}
