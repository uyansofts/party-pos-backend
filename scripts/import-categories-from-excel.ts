// ============================================================================
// IMPORT CATEGORIES FROM EXCEL — Category tab-ийг мод бүтэцтэй DB рүү оруулах
// ----------------------------------------------------------------------------
// Ажиллуулах: npx tsx scripts/import-categories-from-excel.ts "C:\зам\файл.xlsx" "Category"
//   (2 дахь аргумент — tab-ийн нэр, өгөгдөөгүй бол "Category" гэж таамаглана)
//
// БАГАНЫН БҮТЭЦ: id | name | parent_id | tab name | image_url (заавал биш)
//   image_url — ангиллын дугуй зураг (storefront-д). Google Drive холбоос / FILE_ID / https:// зураг.
//   Хоосон орхивол storefront ангиллын эхний барааны зургийг автоматаар ашиглана; дахин импортод хуучин зургийг АРИЛГАХГҮЙ.
//
// АЛГОРИТМ (2 үе шаттай, дараалалаас үл хамааран зөв ажиллана):
//   1-р үе шат: Мөр бүрийг legacyId(=Excel id)-ээр upsert хийж, parentId
//               ХАРААХАН тохируулахгүй. excelId → dbId зураглал үүсгэнэ.
//   2-р үе шат: parent_id != 0 мөр бүрийн ЖИНХЭНЭ parentId-г 1-р шатны
//               зураглалаас олж, шинэчилнэ.
// Дахин ажиллуулахад аюулгүй (legacyId-ээр upsert хийдэг тул давхардахгүй).
// ============================================================================

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { resolveImageUrl } from "../src/lib/product-images";

const prisma = new PrismaClient();

async function main() {
  const filePath = process.argv[2];
  const sheetNameArg = process.argv[3] || "Category";

  if (!filePath) {
    console.error('❌ Хэрэглээ: npx tsx scripts/import-categories-from-excel.ts <файл.xlsx> ["Tab нэр"]');
    process.exit(1);
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[sheetNameArg];
  if (!sheet) {
    console.error(`❌ "${sheetNameArg}" нэртэй tab олдсонгүй. Байгаа tab-ууд: ${workbook.SheetNames.join(", ")}`);
    process.exit(1);
  }

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const headers = rows[0].map((h) => (h ?? "").toString().trim().toLowerCase());
  const idCol = headers.indexOf("id");
  const nameCol = headers.indexOf("name");
  const parentCol = headers.indexOf("parent_id");
  const imageCol = headers.indexOf("image_url");

  if (idCol === -1 || nameCol === -1 || parentCol === -1) {
    console.error(`❌ "id", "name", "parent_id" багана олдсонгүй. Толгойнууд: [${headers.join(", ")}]`);
    process.exit(1);
  }

  const excelIdToDbId = new Map<number, string>();
  const parentLinks: Array<{ excelId: number; parentExcelId: number }> = [];

  // ---------- 1-р үе шат: бүх ангиллыг parentId-гүйгээр upsert ----------
  console.log("\n📂 1-р үе шат: ангиллуудыг үүсгэж байна...");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[idCol] == null || !row[nameCol]) continue;

    const excelId = Number(row[idCol]);
    const name = row[nameCol].toString().trim();
    const parentExcelId = row[parentCol] != null ? Number(row[parentCol]) : 0;

    // ✅ ШИНЭ: ангиллын зураг (хоосон бол хуучин зургийг хөндөхгүй; буруу холбоос бол сануулна)
    let imageUrl: string | null = null;
    if (imageCol !== -1 && row[imageCol] != null && row[imageCol].toString().trim() !== "") {
      imageUrl = resolveImageUrl(row[imageCol].toString().trim());
      if (!imageUrl) console.warn(`  ⚠️  "${name}": image_url буруу (https:// эсвэл Google Drive холбоос байх ёстой) — алгасав`);
    }

    const category = await prisma.category.upsert({
      where: { legacyId: excelId },
      update: { name, ...(imageUrl ? { imageUrl } : {}) },
      create: { name, legacyId: excelId, ...(imageUrl ? { imageUrl } : {}) },
    });

    excelIdToDbId.set(excelId, category.id);
    if (parentExcelId && parentExcelId !== 0) {
      parentLinks.push({ excelId, parentExcelId });
    }
    console.log(`  ✅ ${name} (Excel id: ${excelId})${imageUrl ? " 🖼️" : ""}`);
  }

  // ---------- 2-р үе шат: parentId холбоосуудыг тохируулах ----------
  console.log("\n🔗 2-р үе шат: эцэг-хүүхэд холбоосыг тохируулж байна...");
  for (const link of parentLinks) {
    const dbId = excelIdToDbId.get(link.excelId);
    const parentDbId = excelIdToDbId.get(link.parentExcelId);

    if (!dbId || !parentDbId) {
      console.warn(`  ⚠️  Excel id ${link.excelId}-ийн эцэг (${link.parentExcelId}) олдсонгүй, алгасав`);
      continue;
    }

    await prisma.category.update({ where: { id: dbId }, data: { parentId: parentDbId } });
    console.log(`  🔗 Excel id ${link.excelId} → эцэг Excel id ${link.parentExcelId}`);
  }

  console.log(`\n🎉 Дууслаа: ${excelIdToDbId.size} ангилал импортлогдлоо.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
