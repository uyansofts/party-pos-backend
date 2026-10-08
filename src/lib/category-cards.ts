// ============================================================================
// CATEGORY CARDS — Storefront-ын ангиллын дугуй зураг (Etsy шиг) + барааны тоо (цэвэр логик).
//   • Зураг: ангиллын өөрийн imageUrl; байхгүй бол өөрийн, дараа нь дэд ангиллын эхний барааны зураг (fallback)
//   • Тоо: энэ ангилал + БҮХ дэд ангиллын харагдах барааны нийлбэр
// ============================================================================

export interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  imageUrl?: string | null;
}

export interface CategoryProduct {
  categoryId: string | null;
  imageUrl: string | null;
}

export interface CategoryCard {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  imageUrl: string | null;
  productCount: number;
}

export function buildCategoryCards(categories: CategoryRow[], products: CategoryProduct[]): CategoryCard[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (c.parentId && byId.has(c.parentId)) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
  }
  const directCount = new Map<string, number>();
  const directImage = new Map<string, string>();
  for (const p of products) {
    if (!p.categoryId || !byId.has(p.categoryId)) continue;
    directCount.set(p.categoryId, (directCount.get(p.categoryId) ?? 0) + 1);
    if (p.imageUrl && !directImage.has(p.categoryId)) directImage.set(p.categoryId, p.imageUrl);
  }

  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur: string | null | undefined = id;
    for (let guard = 0; cur && guard < 20; guard++) {
      const c = byId.get(cur);
      if (!c) break;
      parts.unshift(c.name);
      cur = c.parentId;
    }
    return parts.join(" > ");
  };

  // Дэд мод дундах тоо, fallback зураг. Мөчрийн мөчлөг (өгөгдлийн алдаа)-аас хамгаална.
  const memo = new Map<string, { count: number; image: string | null }>();
  const walk = (id: string, seen: Set<string>): { count: number; image: string | null } => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (seen.has(id)) return { count: 0, image: null };
    const nextSeen = new Set(seen).add(id);
    let count = directCount.get(id) ?? 0;
    let image: string | null = directImage.get(id) ?? null;
    for (const childId of children.get(id) ?? []) {
      const sub = walk(childId, nextSeen);
      count += sub.count;
      if (!image && sub.image) image = sub.image;
    }
    const res = { count, image };
    memo.set(id, res);
    return res;
  };

  return categories
    .map((c) => {
      const sub = walk(c.id, new Set());
      return { id: c.id, name: c.name, parentId: c.parentId, path: pathOf(c.id), imageUrl: c.imageUrl || sub.image, productCount: sub.count };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
