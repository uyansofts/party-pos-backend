// ============================================================================
// DEBUG SCRIPT — Барааны imageUrl утгыг шууд хэвлэх (auth/endpoint шаардахгүй)
// Ажиллуулах: npx tsx scripts/list-product-images.ts
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: { imageUrl: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { name: true, imageUrl: true, updatedAt: true },
  });

  console.log("\n📷 Сүүлд шинэчлэгдсэн, зурагтай эхний 5 бараа:\n");
  for (const p of products) {
    console.log(`${p.name} (${p.updatedAt.toISOString()})\n  ${p.imageUrl}\n`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
