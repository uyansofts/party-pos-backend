// ============================================================================
// CATEGORY SERVICE — Ангиллыг POS-оос үүсгэх, нэр засах, зөөх, зураг, устгах.
//   • Excel импорт (legacyId-тай ангилал): нэрийг дараагийн импортод дарж бичнэ — `imported` тэмдэглэнэ (POS анхааруулна)
//   • Устгах: дэд ангилалтай бол татгалзана; бараатай бол өөр ангилалд ШИЛЖҮҮЛЭЭД л устгана (бараа ангилалгүй болохгүй)
// ============================================================================

import { prisma } from "../lib/prisma";
import { resolveImageUrl } from "../lib/product-images";
import { CategoryError, checkCreate, checkMove, siblingNameTaken, validateCategoryName, type CatNode } from "../lib/category-edit";

type Row = CatNode & { imageUrl: string | null; legacyId: number | null };

function pathOf(cats: Row[], id: string): string {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const parts: string[] = [];
  let cur: string | null | undefined = id;
  for (let guard = 0; cur && guard < 20; guard++) {
    const c = byId.get(cur);
    if (!c) break;
    parts.unshift(c.name);
    cur = c.parentId;
  }
  return parts.join(" > ");
}

const view = (cats: Row[], c: Row) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null, imageUrl: c.imageUrl ?? null, path: pathOf(cats, c.id) });

async function all(): Promise<Row[]> {
  return (await prisma.category.findMany({ select: { id: true, name: true, parentId: true, imageUrl: true, legacyId: true } } as any)) as unknown as Row[];
}

/** Staff-ийн жагсаалт: зам, зураг, ШУУД барааны тоо, дэд ангиллын тоо, Excel-ээс импортолсон эсэх. */
export async function listCategoriesForStaff() {
  const cats = await all();
  const counts: any[] = await prisma.product.groupBy({ by: ["categoryId"], _count: { _all: true } } as any);
  const productCount = new Map<string, number>(counts.filter((c) => c.categoryId).map((c) => [c.categoryId, c._count?._all ?? 0]));
  const childCount = new Map<string, number>();
  for (const c of cats) if (c.parentId) childCount.set(c.parentId, (childCount.get(c.parentId) ?? 0) + 1);
  return cats
    .map((c) => ({ ...view(cats, c), productCount: productCount.get(c.id) ?? 0, childCount: childCount.get(c.id) ?? 0, imported: c.legacyId != null }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function parseParent(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new CategoryError("Эцэг ангилал буруу байна");
  return v;
}

function parseImage(v: unknown): string | null {
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  const r = resolveImageUrl(v);
  if (!r) throw new CategoryError("Зургийн холбоос буруу — https:// эсвэл Google Drive холбоос байх ёстой");
  return r;
}

const reject = (body: Record<string, unknown>, allowed: string[]) => {
  const bad = Object.keys(body).filter((k) => !allowed.includes(k));
  if (bad.length) throw new CategoryError(`Зөвшөөрөгдөөгүй талбар: ${bad[0]}`);
};

export async function createCategory(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CategoryError("Мэдээлэл буруу байна");
  const b = body as Record<string, unknown>;
  reject(b, ["name", "parentId", "imageUrl"]);
  const name = validateCategoryName(b.name);
  const parentId = parseParent(b.parentId);
  const imageUrl = b.imageUrl === undefined ? null : parseImage(b.imageUrl);
  const cats = await all();
  checkCreate(cats, parentId);
  if (siblingNameTaken(cats, parentId, name)) throw new CategoryError(`"${name}" нэртэй ангилал энэ эцгийн доор аль хэдийн байна`, 409);
  const created: any = await prisma.category.create({ data: { name, parentId, imageUrl } });
  return view([...cats, created], created);
}

export async function updateCategory(id: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CategoryError("Мэдээлэл буруу байна");
  const b = body as Record<string, unknown>;
  reject(b, ["name", "parentId", "imageUrl"]);
  if (b.name === undefined && b.parentId === undefined && b.imageUrl === undefined) throw new CategoryError("Өөрчлөх зүйл алга");
  const cats = await all();
  const cur = cats.find((c) => c.id === id);
  if (!cur) throw new CategoryError("Ангилал олдсонгүй", 404);

  const data: Record<string, unknown> = {};
  const nextName = b.name !== undefined ? validateCategoryName(b.name) : cur.name;
  const nextParent = b.parentId !== undefined ? parseParent(b.parentId) : cur.parentId ?? null;
  if (b.parentId !== undefined && nextParent !== (cur.parentId ?? null)) checkMove(cats, id, nextParent);
  if ((b.name !== undefined || b.parentId !== undefined) && siblingNameTaken(cats, nextParent, nextName, id)) throw new CategoryError(`"${nextName}" нэртэй ангилал тэр эцгийн доор аль хэдийн байна`, 409);
  if (b.name !== undefined) data.name = nextName;
  if (b.parentId !== undefined) data.parentId = nextParent;
  if (b.imageUrl !== undefined) data.imageUrl = parseImage(b.imageUrl);

  const updated: any = await prisma.category.update({ where: { id }, data });
  return view(cats.map((c) => (c.id === id ? { ...c, ...updated } : c)), { ...cur, ...updated });
}

/** Устгах. Дэд ангилалтай → 409. Бараатай → moveProductsTo (өөр ангилал) өгөөгүй бол 409; өгвөл бараануудыг шилжүүлээд нэг transaction-д устгана. */
export async function deleteCategory(id: string, moveProductsTo?: unknown) {
  const target = moveProductsTo === undefined || moveProductsTo === null || moveProductsTo === "" ? null : parseParent(moveProductsTo);
  try {
    return await prisma.$transaction(async (tx) => {
      const cur = await tx.category.findUnique({ where: { id }, select: { id: true } });
      if (!cur) throw new CategoryError("Ангилал олдсонгүй", 404);
      const children = await tx.category.count({ where: { parentId: id } });
      if (children > 0) throw new CategoryError(`${children} дэд ангилалтай тул устгах боломжгүй — эхлээд дэд ангиллуудыг устгах эсвэл өөр рүү зөөнө үү`, 409);
      const products = await tx.product.count({ where: { categoryId: id } });
      let moved = 0;
      if (products > 0) {
        if (!target) throw new CategoryError(`${products} бараатай — устгахын өмнө бараануудыг шилжүүлэх ангиллаа сонгоно уу`, 409);
        if (target === id) throw new CategoryError("Бараануудыг устгаж буй ангилал руу шилжүүлж болохгүй");
        const dest = await tx.category.findUnique({ where: { id: target }, select: { id: true } });
        if (!dest) throw new CategoryError("Шилжүүлэх ангилал олдсонгүй", 404);
        moved = (await tx.product.updateMany({ where: { categoryId: id }, data: { categoryId: target } })).count;
      }
      await tx.category.delete({ where: { id } });
      return { deleted: true, movedProducts: moved };
    });
  } catch (err: any) {
    if (err?.code === "P2003") throw new CategoryError("Өөр мэдээлэлд холбогдсон тул устгах боломжгүй", 409);
    throw err;
  }
}
