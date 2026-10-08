// ============================================================================
// DEBUG SCRIPT — Сүүлийн GatewayTransaction-уудыг хэвлэх
// ----------------------------------------------------------------------------
// Prisma Studio (CLI) эвдэрсэн үед ашиглана — @prisma/client (runtime) нь
// бүрэн ажиллаж байгаа тул үүгээр DB-г шууд харах боломжтой.
// Ажиллуулах: npx tsx scripts/list-recent-transactions.ts
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const transactions = await prisma.gatewayTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  console.log("\n📋 Сүүлийн 10 GatewayTransaction:\n");
  for (const tx of transactions) {
    console.log(
      `[${tx.status}] ${tx.purpose} | invoiceId: ${tx.invoiceId} | amount: ${tx.amount} | created: ${tx.createdAt.toISOString()}`
    );
  }
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
