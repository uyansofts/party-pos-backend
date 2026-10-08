// ============================================================================
// REVIEW CONTROLLER — /api/reviews (Staff): зохисгүй сэтгэгдлийг нуух/сэргээх. Нуусан үнэлгээ дундаж, жагсаалтад орохгүй.
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { ReviewError } from "../lib/reviews";
import { listReviewsForModeration, setReviewHidden } from "../services/review.service";

const router = Router();
router.use(requireAuth);

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof ReviewError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const h = req.query.hidden;
    res.json(await listReviewsForModeration(h === "true" ? true : h === "false" ? false : undefined));
  } catch (err) {
    fail(err, res, "Үнэлгээ татаж");
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    res.json(await setReviewHidden(req.params.id, req.body?.hidden));
  } catch (err) {
    fail(err, res, "Үнэлгээ шинэчилж");
  }
});

export default router;
