// ============================================================================
// SEED SCRIPT — Postman/curl-аар туршихад зориулсан демо өгөгдөл
// ----------------------------------------------------------------------------
// Ажиллуулах: npx ts-node prisma/seed.ts
// (эсвэл package.json-д "prisma": { "seed": "ts-node prisma/seed.ts" }
//  нэмээд npx prisma db seed)
//
// Скрипт ажиллаж дуусахад консол дээр хэвлэгдэх ID-нуудыг Postman
// Environment-ийн orderId / rentalOrderItemId / rentalDetailId
// хувьсагчид гараар хуулж тавина.
// ============================================================================

import { PrismaClient, OrderType, PayStatus, OrderItemType, RentalStatus } from "@prisma/client";
import { hashPassword } from "../src/services/auth.service";

const prisma = new PrismaClient();

async function main() {
  const cashierPasswordHash = await hashPassword("demo1234"); // ⚠️ ЗӨВХӨН тест — production-д хатуу нууц үг ашиглана

  // ---------- 1. Ажилтан ----------
  const staff = await prisma.staff.upsert({
    where: { email: "demo-cashier@diyparty.mn" },
    update: { passwordHash: cashierPasswordHash }, // дахин seed хийх бүрд ч ЗӨВ hash-аар шинэчилнэ
    create: {
      name: "Демо Кассчин",
      email: "demo-cashier@diyparty.mn",
      passwordHash: cashierPasswordHash,
      role: "CASHIER",
    },
  });

  // ---------- 2. Харилцагч ----------
  const customer = await prisma.customer.upsert({
    where: { phone: "99001122" },
    update: {},
    create: { name: "Болд", phone: "99001122" },
  });

  // ---------- 3. Зарах бараа (SALE тестэд) ----------
  const retailProduct = await prisma.product.upsert({
    where: { sku: "DEMO-BALLOON-001" },
    update: {},
    create: {
      name: "Алтан баллон (демо)",
      sku: "DEMO-BALLOON-001",
      sellPrice: 5000,
      sellStockQty: 100,
      isRental: false,
      isCraft: false,
    },
  });

  // ---------- 4. Түрээслэгддэг бараа (RENTAL тестэд) ----------
  const rentalProduct = await prisma.product.upsert({
    where: { sku: "DEMO-PHOTOZONE-001" },
    update: {},
    create: {
      name: "Фото зон (демо)",
      sku: "DEMO-PHOTOZONE-001",
      rentalPricePerDay: 15000,
      depositAmount: 50000,
      rentalStockQty: 3,
      isRental: true,
      isCraft: false,
    },
  });

  // ---------- 5. ONLINE захиалга (ORDER_PAYMENT тестэд) ----------
  const onlineOrder = await prisma.order.create({
    data: {
      orderNumber: `DEMO-ORD-${Date.now()}`,
      customerId: customer.id,
      staffId: staff.id,
      orderType: OrderType.ONLINE,
      storeId: "default",
      totalAmount: 25000,
      paidAmount: 0,
      paymentStatus: PayStatus.PENDING,
      items: {
        create: [
          {
            productId: retailProduct.id,
            itemType: OrderItemType.SALE,
            quantity: 5,
            unitPrice: 5000,
            subtotal: 25000,
          },
        ],
      },
    },
    include: { items: true },
  });

  // ---------- 6. RENTAL захиалга + RentalDetail (DEPOSIT тестэд) ----------
  const rentalOrder = await prisma.order.create({
    data: {
      orderNumber: `DEMO-RENT-${Date.now()}`,
      customerId: customer.id,
      staffId: staff.id,
      orderType: OrderType.POS,
      storeId: "default",
      totalAmount: 30000, // 2 хоног * 15000
      paidAmount: 0,
      paymentStatus: PayStatus.PENDING,
      items: {
        create: [
          {
            productId: rentalProduct.id,
            itemType: OrderItemType.RENTAL,
            quantity: 1,
            unitPrice: 15000,
            subtotal: 30000,
          },
        ],
      },
    },
    include: { items: true },
  });

  const rentalOrderItem = rentalOrder.items[0];

  const rentalDetail = await prisma.rentalDetail.create({
    data: {
      orderItemId: rentalOrderItem.id,
      startDate: new Date("2026-10-15"),
      endDate: new Date("2026-10-17"),
      rentalDays: 2,
      dailyRate: 15000,
      depositAmount: 50000,
      rentalStatus: RentalStatus.BOOKED,
    },
  });

  // ---------- Үр дүнг хэвлэх ----------
  console.log("\n✅ Демо өгөгдөл амжилттай үүслээ! Доорх ID-нуудыг Postman Environment-д тавина уу:\n");
  console.log("retailProductId      =", retailProduct.id);
  console.log("rentalProductId      =", rentalProduct.id);
  console.log("orderId (ONLINE)     =", onlineOrder.id);
  console.log("rentalOrderId (POS)  =", rentalOrder.id);
  console.log("rentalOrderItemId    =", rentalOrderItem.id);
  console.log("rentalDetailId       =", rentalDetail.id);
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
