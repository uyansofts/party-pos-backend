// ============================================================================
// CATEGORY EDIT — Ангиллыг POS-оос засах дүрэм (цэвэр логик): нэр, мөчлөг, гүн.
//   • Нэг эцгийн доор ижил нэр (том/жижиг үсэг үл хамаарна) давтагдахгүй
//   • Ангилал өөрийнхөө дотор/өөрийн дэд ангилалд ОРОХГҮЙ (мөчлөг) — мод эвдрэхгүй
//   • Хамгийн ихдээ 4 түвшин (storefront-ын навигаци ойлгомжтой байхын тулд)
// ============================================================================

export class CategoryError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "CategoryError";
    this.status = status;
  }
}

export const MAX_CATEGORY_DEPTH = 4;

export interface CatNode {
  id: string;
  name: string;
  parentId: string | null;
}

export function validateCategoryName(raw: unknown): string {
  if (typeof raw !== "string") throw new CategoryError("Ангиллын нэрийг оруулна уу");
  const t = raw.replace(/[\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 1 || t.length > 60) throw new CategoryError("Ангиллын нэр 1-60 тэмдэгттэй байх ёстой");
  return t;
}

export function siblingNameTaken(cats: CatNode[], parentId: string | null, name: string, exceptId?: string): boolean {
  const key = name.trim().toLowerCase();
  return cats.some((c) => c.id !== exceptId && (c.parentId ?? null) === (parentId ?? null) && c.name.trim().toLowerCase() === key);
}

/** Үндэс = 1. Өгөгдлийн мөчлөг/устсан эцэг байвал 20-оор таслана (хязгааргүй давталтгүй). */
export function depthOf(cats: CatNode[], id: string | null): number {
  if (id === null) return 0;
  const byId = new Map(cats.map((c) => [c.id, c]));
  let depth = 0;
  let cur: string | null | undefined = id;
  for (let guard = 0; cur && guard < 20; guard++) {
    const c = byId.get(cur);
    if (!c) break;
    depth++;
    cur = c.parentId;
  }
  return depth;
}

/** Өөрөө + хамгийн гүн дэд ангиллын түвшний тоо (навч = 1). */
export function subtreeHeight(cats: CatNode[], id: string): number {
  const children = new Map<string, string[]>();
  for (const c of cats) if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
  const walk = (cur: string, seen: Set<string>): number => {
    if (seen.has(cur)) return 0;
    const next = new Set(seen).add(cur);
    let h = 0;
    for (const ch of children.get(cur) ?? []) h = Math.max(h, walk(ch, next));
    return 1 + h;
  };
  return walk(id, new Set());
}

export function isDescendant(cats: CatNode[], ancestorId: string, nodeId: string): boolean {
  const byId = new Map(cats.map((c) => [c.id, c]));
  let cur: string | null | undefined = byId.get(nodeId)?.parentId;
  for (let guard = 0; cur && guard < 20; guard++) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

/** Шинэ ангилал үүсгэхэд: эцэг (байвал) олдох, гүн хязгаараас хэтрэхгүй. */
export function checkCreate(cats: CatNode[], parentId: string | null): void {
  if (parentId !== null && !cats.some((c) => c.id === parentId)) throw new CategoryError("Эцэг ангилал олдсонгүй", 404);
  if (depthOf(cats, parentId) + 1 > MAX_CATEGORY_DEPTH) throw new CategoryError(`Ангилал хамгийн ихдээ ${MAX_CATEGORY_DEPTH} түвшинтэй байна`);
}

/** Ангиллыг өөр эцэг рүү зөөхөд: өөрийн дотор/дэд ангилалд ороход ТАТГАЛЗАНА; дэд мод хамт зөөгдөх тул гүнг шалгана. */
export function checkMove(cats: CatNode[], id: string, newParentId: string | null): void {
  if (newParentId !== null) {
    if (!cats.some((c) => c.id === newParentId)) throw new CategoryError("Эцэг ангилал олдсонгүй", 404);
    if (newParentId === id) throw new CategoryError("Ангилал өөрийнхөө дотор орж чадахгүй");
    if (isDescendant(cats, id, newParentId)) throw new CategoryError("Ангилалыг өөрийн дэд ангилалд зөөж болохгүй");
  }
  if (depthOf(cats, newParentId) + subtreeHeight(cats, id) > MAX_CATEGORY_DEPTH) throw new CategoryError(`Зөөсний дараа ангилал ${MAX_CATEGORY_DEPTH} түвшнээс хэтэрнэ`);
}
