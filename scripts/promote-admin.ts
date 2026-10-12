// ============================================================================
// PROMOTE ADMIN — нэг ажилтныг ADMIN болгоно (role шалгалтыг идэвхжүүлэх анхны алхам).
// ----------------------------------------------------------------------------
// Анхдагч нь DRY-RUN (юу ч бичихгүй). Бодитоор хэрэгжүүлэхийг ЗӨВХӨН --apply гэж өгөхөд л бичнэ.
//   npx tsx scripts/promote-admin.ts owner@example.com            # dry-run
//   npx tsx scripts/promote-admin.ts owner@example.com --apply    # бодит өөрчлөлт (өөрөө шийдэж ажиллуулна)
// ⚠️ Production DB-д ажиллуулахаасаа өмнө хэрэглэгчийн зөвшөөрөл/нөөц хуулбар шаардлагатай.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

async function main() {
  const email = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!email || email.startsWith("--")) {
    console.error("Хэрэглээ: npx tsx scripts/promote-admin.ts <email> [--apply]");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const staff = await prisma.staff.findUnique({ where: { email }, select: { id: true, name: true, role: true, isActive: true } });
    if (!staff) throw new Error(`Ажилтан олдсонгүй: ${email}`);
    console.log(`Одоогийн: ${staff.name} role=${staff.role} active=${staff.isActive}`);
    if (!staff.isActive) throw new Error("Идэвхгүй ажилтныг ADMIN болгохгүй");
    if (staff.role === "ADMIN") return console.log("Аль хэдийн ADMIN — өөрчлөлт шаардлагагүй.");
    if (!apply) return console.log("DRY-RUN: --apply өгөөгүй тул юу ч өөрчилсөнгүй.");
    await prisma.staff.update({ where: { id: staff.id }, data: { role: "ADMIN" } });
    console.log("✅ ADMIN болголоо. Одоо server-ийн role шалгалт идэвхтэй ADMIN-тай болсон тул ADMIN route-ууд нээгдэнэ.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
