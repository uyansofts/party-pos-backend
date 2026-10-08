// ============================================================================
// CUSTOMER CONTROLLER
// ----------------------------------------------------------------------------
// Кассчин захиалга үүсгэхийн өмнө утасны дугаараар харилцагч ХАЙЖ, олдохгүй
// бол ШИНЭЭР үүсгэдэг энгийн урсгалд зориулав. Customer-д login/нууц үг
// шаардлагагүй (зөвхөн Staff л нэвтэрдэг — Customer бол зөвхөн бүртгэлийн
// мэдээлэл).
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();
router.use(requireAuth);

// ============================================================================
// GET /api/customers?search=утас-эсвэл-нэр
// ----------------------------------------------------------------------------
// search дутуу бол сүүлийн 20 харилцагчийг буцаана (кассчин түгээмэл
// харилцагчаа хурдан олоход тус болно).
// ============================================================================
router.get("/", async (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string | undefined)?.trim();

    const customers = await prisma.customer.findMany({
      where: search
        ? {
            OR: [
              { phone: { contains: search } },
              { name: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    // ✅ ШИНЭ: Харилцагч бүрийн ЦУЦЛАГДСАН захиалгын тоог нэмж буцаана —
    // кассчин "хуурамч захиалгын эрсдэлтэй" эсэхийг шууд харна.
    const withCancelledCounts = await Promise.all(
      customers.map(async (c) => {
        const cancelledCount = await prisma.order.count({
          where: { customerId: c.id, paymentStatus: "CANCELLED" },
        });
        return { ...c, cancelledOrderCount: cancelledCount };
      })
    );

    res.json(withCancelledCounts);
  } catch (err) {
    console.error("Харилцагч хайхад алдаа гарлаа:", err);
    res.status(500).json({ error: "Харилцагч хайж чадсангүй" });
  }
});

// ============================================================================
// POST /api/customers — Шинэ харилцагч үүсгэх
// body: { name, phone, address?, idCardRef? }
// ----------------------------------------------------------------------------
// phone нь @unique тул давхардвал ОДОО БАЙГАА харилцагчийг буцаана
// (кассчин "шинэ" гэж дарсан ч, өмнө нь бүртгэгдсэн бол алдаа өгөхгүй,
// зүгээр л тэр хүнийг олж өгнө — UX-д илүү зөв).
// ============================================================================
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, phone, address, idCardRef } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: "name болон phone заавал шаардлагатай" });
    }

    const customer = await prisma.customer.upsert({
      where: { phone },
      update: {}, // Аль хэдийн байгаа бол мэдээллийг нь дарж бичихгүй — зөвхөн олж өгнө
      create: { name, phone, address, idCardRef },
    });

    // ✅ ШИНЭ: Энд ч мөн адил цуцлалтын тоог нэмж буцаана
    const cancelledOrderCount = await prisma.order.count({
      where: { customerId: customer.id, paymentStatus: "CANCELLED" },
    });

    res.status(201).json({ ...customer, cancelledOrderCount });
  } catch (err) {
    console.error("Харилцагч үүсгэхэд алдаа гарлаа:", err);
    res.status(500).json({ error: "Харилцагч үүсгэж чадсангүй" });
  }
});

export default router;
