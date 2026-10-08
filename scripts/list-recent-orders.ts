// ============================================================================
// DEBUG SCRIPT — Сүүлийн Order-уудыг Customer-тэй нь хамт хэвлэх
// Ажиллуулах: npx tsx scripts/list-recent-orders.ts
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { customer: true },
  });

  console.log("\n📋 Сүүлийн 10 Order:\n");
  for (const order of orders) {
    console.log(
      `orderNumber: ${order.orderNumber} | customerId: ${order.customerId ?? "NULL"} | customer: ${
        order.customer ? `${order.customer.name} (${order.customer.phone})` : "ТАНИХГҮЙ"
      } | created: ${order.createdAt.toISOString()}`
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
