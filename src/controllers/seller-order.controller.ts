// ============================================================================
// SELLER ORDER CONTROLLER — /api/seller-orders (Staff). Худалдагчийн өмнөөс захиалгыг зөвшөөрөх / бэлэн болгох /
// татгалзах, мөнгө буцаасан гэж тэмдэглэх. (Худалдагчийн өөрийн портал дараагийн хувилбарт.)
// ============================================================================

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  SellerOrderError,
  listSellerOrders,
  acceptSellerOrder,
  markSellerOrderReady,
  rejectSellerOrder,
  completeSellerRefund,
} from "../services/seller-order.service";

const router = Router();
router.use(requireAuth);

function fail(err: unknown, res: Response, what: string) {
  if (err instanceof SellerOrderError) return res.status(err.status).json({ error: err.message });
  console.error(`${what} алдаа гарлаа:`, err);
  return res.status(500).json({ error: `${what} чадсангүй` });
}

router.get("/", async (req: Request, res: Response) => {
  try {
    res.json(await listSellerOrders(typeof req.query.status === "string" ? req.query.status : undefined));
  } catch (err) {
    fail(err, res, "Худалдагчийн захиалга татаж");
  }
});

router.post("/:id/accept", async (req: Request, res: Response) => {
  try {
    res.json(await acceptSellerOrder(req.params.id));
  } catch (err) {
    fail(err, res, "Зөвшөөрч");
  }
});

router.post("/:id/ready", async (req: Request, res: Response) => {
  try {
    res.json(await markSellerOrderReady(req.params.id));
  } catch (err) {
    fail(err, res, "Бэлэн болгож");
  }
});

router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    res.json(await rejectSellerOrder(req.params.id, req.body?.reason));
  } catch (err) {
    fail(err, res, "Татгалзаж");
  }
});

router.post("/:id/refund-done", async (req: Request, res: Response) => {
  try {
    res.json(await completeSellerRefund(req.params.id));
  } catch (err) {
    fail(err, res, "Буцаалт тэмдэглэж");
  }
});

export default router;
