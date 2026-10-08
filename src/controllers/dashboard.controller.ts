// ============================================================================
// DASHBOARD CONTROLLER — GET /api/dashboard/summary (Staff): POS-ын хяналтын самбар.
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getDashboardSummary } from "../services/dashboard.service";

const router = Router();
router.use(requireAuth);

router.get("/summary", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getDashboardSummary());
  } catch (err) {
    console.error("Хяналтын самбар тооцоход алдаа гарлаа:", err);
    res.status(500).json({ error: "Хяналтын самбарын мэдээлэл татаж чадсангүй" });
  }
});

export default router;
