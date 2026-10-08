// ============================================================================
// CATEGORY CONTROLLER — /api/categories (Staff): жагсаалт (зам, зураг, барааны тоо), үүсгэх, нэр засах, зөөх, зураг, устгах.
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { CategoryError } from "../lib/category-edit";
import { createCategory, deleteCategory, listCategoriesForStaff, updateCategory } from "../services/category.service";

const router = Router();
router.use(requireAuth);

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof CategoryError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

// GET / — Бүх ангиллыг "Эцэг > Хүүхэд > Ач" замтай, зурагтай, барааны тоотой (Flutter dropdown + удирдлагын дэлгэцэнд)
router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listCategoriesForStaff());
  } catch (err) {
    fail(err, res, "Ангилал татаж");
  }
});

// POST / — { name, parentId?, imageUrl? }
router.post("/", async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createCategory(req.body));
  } catch (err) {
    fail(err, res, "Ангилал үүсгэж");
  }
});

// PATCH /:id — { name?, parentId?, imageUrl? } (зөвхөн { imageUrl } — хуучин POS-той нийцнэ)
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    res.json(await updateCategory(req.params.id, req.body));
  } catch (err) {
    fail(err, res, "Ангилал шинэчилж");
  }
});

// DELETE /:id?moveProductsTo=<өөр ангиллын id> — бараатай бол заавал шилжүүлэх ангиллыг өгнө
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    res.json(await deleteCategory(req.params.id, req.query.moveProductsTo));
  } catch (err) {
    fail(err, res, "Ангилал устгаж");
  }
});

export default router;
