// ============================================================================
// PRODUCTION CONTROLLER — Cricut/лазер зүсэлтийн тооцоолуур, nesting, SVG экспорт, багцын боломжит тоо
// ----------------------------------------------------------------------------
// Бүгд Staff нэвтрэлттэй (requireAuth) ба DB-д БИЧИХГҮЙ (тооцоолуур). Хязгаарын шалгалт lib/ дотор.
//   POST /api/production/cutting-estimate  — материал, хаягдал, өртөг (nesting-тэй)
//   POST /api/production/nesting           — байршуулалт (+ эрэмбэлсэн хувилбарууд)
//   POST /api/production/nesting/svg       — хуудас бүрийн SVG
//   POST /api/production/bundle-availability — багцын боломжит тоо (нөөцийг DB-ээс уншина)
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { compareVariants, layoutToSvgs, nest, NestingError, validateLayout, type NestingInput } from "../lib/nesting";
import { CuttingError, estimateCutting, type CuttingInput } from "../lib/cutting";
import { BundleError, bundleAvailability, type BundleComponent } from "../lib/bundle";
import { UnitError } from "../lib/units";

const router = Router();
router.use(requireAuth);

function isClientError(err: unknown): err is Error {
  return err instanceof NestingError || err instanceof CuttingError || err instanceof UnitError || err instanceof BundleError;
}
function fail(res: Response, err: unknown, what: string) {
  if (isClientError(err)) return res.status(400).json({ error: err.message });
  console.error(`${what} алдаа:`, err);
  return res.status(500).json({ error: `${what} хийж чадсангүй` });
}

router.post("/cutting-estimate", (req: Request, res: Response) => {
  try {
    res.json(estimateCutting(req.body as CuttingInput));
  } catch (err) {
    fail(res, err, "Зүсэлтийн тооцоо");
  }
});

router.post("/nesting", (req: Request, res: Response) => {
  try {
    const body = req.body as NestingInput & { compare?: boolean };
    const result = nest(body);
    const problems = validateLayout(body, result);
    if (problems.length) return res.status(500).json({ error: "Байршуулалтын дотоод шалгалт амжилтгүй", problems });
    res.json({
      result,
      ...(body.compare ? { variants: compareVariants(body).map((v) => ({ label: v.label, sheets: v.sheetsUsed, utilization: v.utilization, unplaced: v.result.unplaced.length })) } : {}),
    });
  } catch (err) {
    fail(res, err, "Nesting");
  }
});

router.post("/nesting/svg", (req: Request, res: Response) => {
  try {
    const body = req.body as NestingInput & { labels?: boolean };
    const result = nest(body);
    const problems = validateLayout(body, result);
    if (problems.length) return res.status(500).json({ error: "Байршуулалтын дотоод шалгалт амжилтгүй", problems });
    res.json({ sheets: layoutToSvgs(body, result, { labels: !!body.labels }), unplaced: result.unplaced, warnings: result.warnings });
  } catch (err) {
    fail(res, err, "SVG экспорт");
  }
});

router.post("/bundle-availability", async (req: Request, res: Response) => {
  try {
    const components = (req.body?.components ?? []) as BundleComponent[];
    if (!Array.isArray(components) || components.length > 100) throw new BundleError("components жагсаалт буруу байна");
    const ids = components.map((c) => c?.productId).filter((x): x is string => typeof x === "string");
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sellStockQty: true } });
    const stock: Record<string, number> = {};
    for (const p of products) stock[p.id] = p.sellStockQty;
    res.json(bundleAvailability(components, stock));
  } catch (err) {
    fail(res, err, "Багцын боломжит тоо");
  }
});

export default router;
