// ============================================================================
// LISTING REQUEST SERVICE — Худалдагчийн шинэ бараа нэмэх хүсэлт → Staff шалгаж БАТЛАХ/ТАТГАЛЗАХ.
//   • Хүсэлт батлагдтал Product болохгүй (storefront-д алдаатай бараа огт гарахгүй)
//   • Батлахад бараа + анхны нөөцийн аудит НЭГ transaction-д үүснэ; төлөв шилжилт атомик (хоёр Staff зэрэг дарсан ч нэг бараа л)
//   • Худалдагч ЗӨВХӨН өөрийн хүсэлтийг харж/буцаана
// ============================================================================

import { prisma } from "../lib/prisma";
import { emitToStore } from "../realtime/socket";
import { generateSku } from "../lib/sku";
import { resolveImageUrl } from "../lib/product-images";
import { ListingError, MAX_PENDING_REQUESTS, mergeApproval, validateListingFields, validateRejectReason } from "../lib/listing-request";

/** Хадгалах хэлбэрт (Google Drive → манай image-proxy, https хэвээр). Хүчингүй бол null. */
export function resolveListingImage(url: string | null): string | null {
  return url ? resolveImageUrl(url) : null;
}

/** Хуучин мөрүүдэд imageUrls хоосон, зөвхөн imageUrl байж болно. */
function imagesOfRow(r: any): string[] {
  if (Array.isArray(r.imageUrls) && r.imageUrls.length > 0) return r.imageUrls;
  return r.imageUrl ? [r.imageUrl] : [];
}

/** Порталд худалдагчид харагдах ЗӨВШӨӨРСӨН талбарууд (allowlist). */
export function toPortalListing(r: any) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    imageUrl: imagesOfRow(r)[0] ?? null,
    imageUrls: imagesOfRow(r),
    sellPrice: Number(r.sellPrice),
    stockQty: r.stockQty,
    status: r.status,
    rejectReason: r.status === "REJECTED" ? r.rejectReason ?? null : null,
    // Батлагдсан бол үүссэн барааны id — портал "Миний хүсэлтүүд"-ээс энэ картыг нууж, бараа хоёр дахин харагдахаас сэргийлнэ
    productId: r.status === "APPROVED" ? r.productId ?? null : null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
  };
}

export async function createListingRequest(sellerId: string, body: unknown) {
  const f = validateListingFields(body);
  // ✅ ШИНЭ: Санамсаргүй давхар илгээлтээс (давхар дарсан, сүлжээ удааширч дахин дарсан) хамгаална — сүүлийн 5 минутад
  // ЯГ ИЖИЛ нэр + үнэтэй хүлээгдэж буй хүсэлт байвал шинээр үүсгэхгүй, байгааг нь буцаана.
  const recentDup = await prisma.productListingRequest.findFirst({
    where: { sellerId, status: "PENDING" as any, name: f.name, sellPrice: f.sellPrice, createdAt: { gte: new Date(Date.now() - 5 * 60_000) } },
  });
  if (recentDup) return toPortalListing(recentDup);
  const pending = await prisma.productListingRequest.count({ where: { sellerId, status: "PENDING" as any } });
  if (pending >= MAX_PENDING_REQUESTS) throw new ListingError(`Хүлээгдэж буй хүсэлт ${MAX_PENDING_REQUESTS} хүрсэн байна — дэлгүүр шалгаж дуустал хүлээнэ үү`, 429);
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { name: true } });
  const created = await prisma.productListingRequest.create({
    data: { sellerId, name: f.name, description: f.description, imageUrl: f.imageUrl, imageUrls: f.imageUrls, sellPrice: f.sellPrice, stockQty: f.stockQty },
  });
  try {
    emitToStore("default", "seller_listing_requested", { requestId: created.id, sellerName: seller?.name ?? "", name: f.name });
  } catch (err) {
    console.error("Шинэ барааны хүсэлтийн мэдэгдэл илгээхэд алдаа гарлаа (хүсэлт бүртгэгдсэн):", err);
  }
  return toPortalListing(created);
}

export async function listSellerListingRequests(sellerId: string) {
  const rows = await prisma.productListingRequest.findMany({ where: { sellerId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map(toPortalListing);
}

/** Худалдагч шалгагдаагүй хүсэлтээ буцаана. Бусдын хүсэлт "олдсонгүй". */
export async function withdrawListingRequest(sellerId: string, requestId: string) {
  const r = await prisma.productListingRequest.updateMany({ where: { id: requestId, sellerId, status: "PENDING" as any }, data: { status: "WITHDRAWN" as any, reviewedAt: new Date() } });
  if (r.count === 0) {
    const exists = await prisma.productListingRequest.findFirst({ where: { id: requestId, sellerId } });
    if (!exists) throw new ListingError("Хүсэлт олдсонгүй", 404);
    throw new ListingError("Энэ хүсэлтийг аль хэдийн шалгасан тул буцаах боломжгүй", 409);
  }
  return { id: requestId, status: "WITHDRAWN" };
}

// ---------------------------- Staff ----------------------------

export async function listListingRequests(status?: string) {
  const valid = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"];
  const rows = await prisma.productListingRequest.findMany({
    where: status && valid.includes(status) ? { status: status as any } : {},
    include: { seller: { select: { id: true, name: true, slug: true, phone: true, status: true, commissionPercent: true } } },
    orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" }, // Хүлээгдэж буйг хуучнаас нь эхэлж шалгана
    take: 200,
  });
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    imageUrl: imagesOfRow(r)[0] ?? null,
    imageUrls: imagesOfRow(r),
    sellPrice: Number(r.sellPrice),
    stockQty: r.stockQty,
    status: r.status,
    rejectReason: r.rejectReason ?? null,
    productId: r.productId ?? null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
    seller: r.seller,
  }));
}

export async function approveListingRequest(requestId: string, overrides?: unknown) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.productListingRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ListingError("Хүсэлт олдсонгүй", 404);
    if (req.status !== "PENDING") throw new ListingError(`Энэ хүсэлт "${req.status}" төлөвт байгаа тул батлах боломжгүй`, 409);

    const { fields, categoryId } = mergeApproval(
      { name: req.name, description: req.description ?? null, imageUrl: imagesOfRow(req)[0] ?? null, imageUrls: imagesOfRow(req), sellPrice: Number(req.sellPrice), stockQty: req.stockQty },
      overrides
    );
    if (categoryId) {
      const cat = await tx.category.findUnique({ where: { id: categoryId }, select: { id: true } });
      if (!cat) throw new ListingError("Сонгосон ангилал олдсонгүй");
    }

    // Атомик төлөв шилжилт: зэрэг дарсан хоёр дахь Staff 409 авна, бараа ДАВХАР үүсэхгүй
    const claim = await tx.productListingRequest.updateMany({ where: { id: requestId, status: "PENDING" as any }, data: { status: "APPROVED" as any, reviewedAt: new Date() } });
    if (claim.count === 0) throw new ListingError("Хүсэлтийн төлөв дөнгөж өөрчлөгдлөө — жагсаалтаа шинэчилнэ үү", 409);

    // Зургууд: Drive → proxy, давхардал арилна; түлхүүр зураг = эхнийх
    const images: string[] = [];
    for (const u of fields.imageUrls) {
      const r = resolveImageUrl(u);
      if (r && !images.includes(r)) images.push(r);
    }

    const product = await tx.product.create({
      data: {
        name: fields.name,
        sku: generateSku(),
        publicDescription: fields.description, // ✅ ЗАСВАР: худалдагчийн тайлбар нь харилцагчид харагдах тайлбар (description нь дотоод)
        sellPrice: fields.sellPrice,
        sellStockQty: fields.stockQty,
        imageUrl: images[0] ?? null,
        imageUrls: images,
        categoryId,
        sellerId: req.sellerId,
        isRental: false,
        isCraft: false,
        isActive: true,
        minStockAlert: 3,
        usesMaterialPricing: false,
        customFields: [] as any,
      } as any,
    });
    if (fields.stockQty > 0) {
      await tx.stockMovement.create({ data: { productId: product.id, type: "ADJUSTMENT" as any, quantity: fields.stockQty, note: "Худалдагчийн шинэ бараа — анхны нөөц" } });
    }
    await tx.productListingRequest.update({ where: { id: requestId }, data: { productId: product.id } });
    return { requestId, productId: product.id, name: product.name };
  }, { timeout: 15000 });
}

export async function rejectListingRequest(requestId: string, reason: unknown) {
  const text = validateRejectReason(reason);
  const r = await prisma.productListingRequest.updateMany({ where: { id: requestId, status: "PENDING" as any }, data: { status: "REJECTED" as any, rejectReason: text, reviewedAt: new Date() } });
  if (r.count === 0) {
    const exists = await prisma.productListingRequest.findUnique({ where: { id: requestId } });
    if (!exists) throw new ListingError("Хүсэлт олдсонгүй", 404);
    throw new ListingError(`Энэ хүсэлт "${exists.status}" төлөвт байгаа тул татгалзах боломжгүй`, 409);
  }
  return { requestId, status: "REJECTED" };
}
