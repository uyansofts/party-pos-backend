import { prisma } from "../lib/prisma";
import { SELLER_STATUSES, slugifyName, validateSellerInput } from "../lib/seller";
import { getSellerRating } from "./review.service";

export class SellerError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "SellerError";
    this.status = status;
  }
}

const taken = async (slug: string, exceptId?: string) => {
  const found = await prisma.seller.findUnique({ where: { slug } });
  return !!found && found.id !== exceptId;
};

/** Нэрээс автоматаар холбоос гаргаж, давхцвал -2, -3 залгана. */
async function uniqueSlugFromName(name: string): Promise<string> {
  const base = slugifyName(name) ?? "shop";
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new SellerError("Холбооны нэр үүсгэж чадсангүй — гараар оруулна уу", 409);
}

const isStatus = (v: unknown): v is (typeof SELLER_STATUSES)[number] => typeof v === "string" && (SELLER_STATUSES as readonly string[]).includes(v);

export async function listSellers() {
  const rows = await prisma.seller.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { products: true } } } });
  return rows.map((r: any) => ({ ...r, productCount: r._count?.products ?? 0, _count: undefined }));
}

export async function createSeller(raw: unknown) {
  const v = validateSellerInput(raw, "create");
  if (!v.ok || !v.data) throw new SellerError(v.error ?? "Мэдээлэл буруу байна");
  const status = (raw as any)?.status;
  if (status !== undefined && !isStatus(status)) throw new SellerError("Төлөв буруу байна");

  let slug = v.data!.slug;
  if (slug) {
    if (await taken(slug)) throw new SellerError("Энэ холбоос аль хэдийн ашиглагдаж байна — өөрийг сонгоно уу", 409);
  } else {
    slug = await uniqueSlugFromName(v.data!.name!);
  }
  try {
    return await prisma.seller.create({ data: { ...(v.data as any), slug, ...(status ? { status } : {}) } });
  } catch (err: any) {
    if (err?.code === "P2002") throw new SellerError("Энэ холбоос аль хэдийн ашиглагдаж байна — өөрийг сонгоно уу", 409);
    throw err;
  }
}

export async function updateSeller(id: string, raw: unknown) {
  const existing = await prisma.seller.findUnique({ where: { id } });
  if (!existing) throw new SellerError("Худалдагч олдсонгүй", 404);
  const v = validateSellerInput(raw, "update");
  if (!v.ok || !v.data) throw new SellerError(v.error ?? "Мэдээлэл буруу байна");
  if (v.data!.slug && (await taken(v.data!.slug, id))) throw new SellerError("Энэ холбоос өөр худалдагчид ашиглагдаж байна", 409);
  try {
    return await prisma.seller.update({ where: { id }, data: v.data as any });
  } catch (err: any) {
    if (err?.code === "P2002") throw new SellerError("Энэ холбоос аль хэдийн ашиглагдаж байна", 409);
    throw err;
  }
}

export async function setSellerStatus(id: string, status: unknown) {
  if (!isStatus(status)) throw new SellerError("Төлөв PENDING, ACTIVE, SUSPENDED-ийн нэг байх ёстой");
  const existing = await prisma.seller.findUnique({ where: { id } });
  if (!existing) throw new SellerError("Худалдагч олдсонгүй", 404);
  return prisma.seller.update({ where: { id }, data: { status } });
}

/** Storefront-ын shop хуудас: ЗӨВХӨН идэвхтэй худалдагч, дотоод мэдээлэл (банк, комисс, утас) ГАРАХГҮЙ. */
export async function getPublicSeller(slug: string) {
  const s = await prisma.seller.findUnique({ where: { slug }, include: { _count: { select: { products: { where: { isActive: true } } } } } });
  if (!s || s.status !== "ACTIVE") throw new SellerError("Shop олдсонгүй", 404);
  // ✅ ШИНЭ: shop-ийн дундаж үнэлгээ (бараануудынх нь нэгтгэл). Нэмэлт мэдээлэл тул алдаа гарвал shop хуудсыг унагахгүй.
  let rating: { avg: number | null; count: number } = { avg: null, count: 0 };
  try {
    rating = await getSellerRating(s.id);
  } catch (err) {
    console.error("Shop-ийн үнэлгээ тооцоход алдаа гарлаа (shop хуудас хэвийн үргэлжилнэ):", err);
  }
  return { name: s.name, slug: s.slug, description: s.description, logoUrl: s.logoUrl, productCount: (s as any)._count?.products ?? 0, ratingAvg: rating.avg, ratingCount: rating.count };
}
