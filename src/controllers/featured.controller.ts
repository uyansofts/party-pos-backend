// ============================================================================
// FEATURED CONTROLLER — /api/featured (Staff): онцлох байрлалын багц, зарууд, төлбөр баталгаажуулах.
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { FeaturedError } from "../lib/featured";
import { approvePromotion, cancelPromotionByStaff, confirmPromotionPayment, createPackage, deletePackage, getCalendar, listPackages, listPromotions, markRefunded, rejectPromotion, updatePackage } from "../services/featured.service";

const router = Router();
router.use(requireAuth);

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof FeaturedError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

router.get("/packages", async (_req: Request, res: Response) => {
  try { res.json(await listPackages(false)); } catch (err) { fail(err, res, "Багц татаж"); }
});
router.post("/packages", async (req: Request, res: Response) => {
  try { res.status(201).json(await createPackage(req.body)); } catch (err) { fail(err, res, "Багц үүсгэж"); }
});
router.patch("/packages/:id", async (req: Request, res: Response) => {
  try { res.json(await updatePackage(req.params.id, req.body)); } catch (err) { fail(err, res, "Багц засаж"); }
});
router.delete("/packages/:id", async (req: Request, res: Response) => {
  try { res.json(await deletePackage(req.params.id)); } catch (err) { fail(err, res, "Багц устгаж"); }
});

router.get("/promotions", async (req: Request, res: Response) => {
  try {
    const f = typeof req.query.group === "string" ? req.query.group : typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await listPromotions(f));
  } catch (err) { fail(err, res, "Зар татаж"); }
});
// ✅ ШИНЭ: байрлалын хуанли (өдөр бүрийн эзэлсэн/лимит)
router.get("/calendar", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getCalendar(typeof req.query.from === "string" ? req.query.from : undefined, req.query.days ? Number(req.query.days) : undefined));
  } catch (err) { fail(err, res, "Хуанли татаж"); }
});
// ✅ ШИНЭ: ЗӨВШӨӨРӨХ — байрлал нөөцлөгдөнө ({ startDate? } хүссэн огноог өөрчилж болно)
router.post("/promotions/:id/approve", async (req: Request, res: Response) => {
  try { res.json(await approvePromotion(req.params.id, req.body)); } catch (err) { fail(err, res, "Зөвшөөрч"); }
});
router.post("/promotions/:id/reject", async (req: Request, res: Response) => {
  try { res.json(await rejectPromotion(req.params.id, req.body?.reason)); } catch (err) { fail(err, res, "Татгалзаж"); }
});
router.post("/promotions/:id/refunded", async (req: Request, res: Response) => {
  try { res.json(await markRefunded(req.params.id)); } catch (err) { fail(err, res, "Буцаалт бүртгэж"); }
});
router.post("/promotions/:id/confirm", async (req: Request, res: Response) => {
  try { res.json(await confirmPromotionPayment(req.params.id, req.body)); } catch (err) { fail(err, res, "Төлбөр баталгаажуулж"); }
});
router.post("/promotions/:id/cancel", async (req: Request, res: Response) => {
  try { res.json(await cancelPromotionByStaff(req.params.id, req.body?.reason)); } catch (err) { fail(err, res, "Зар цуцалж"); }
});

export default router;
