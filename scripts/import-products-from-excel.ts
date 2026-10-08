// ============================================================================
// IMPORT PRODUCTS FROM EXCEL — category_id (Category.legacyId)-ээр холбоно
// ----------------------------------------------------------------------------
// ЗААВАЛ ЭХЛЭЭД АЖИЛЛУУЛАХ: import-categories-from-excel.ts
//
// Ажиллуулах: npx tsx scripts/import-products-from-excel.ts "C:\зам\файл.xlsx"
//
// ШИНЭЧЛЭГДСЭН БАГАНЫН БҮТЭЦ:
//   sku | Barcode Number | Product Name | category_id | Purchase_price |
//   Is Rental | Is Craft | Selling_price | Stock | Minimum_stock |
//   Color | Size | Location | unit | Image_url | Image_url_2 … Image_url_10 | Description
//
// ✅ ОЛОН ЗУРАГ: Image_url (түлхүүр зураг) + Image_url_2 … Image_url_10 баганад тус бүрд нэг зураг, ЭСВЭЛ нэг нүдэнд
//   олныг шинэ мөр / таслал / | / ; -ээр тусгаарлан бичиж болно. Google Drive холбоос, FILE_ID, https:// зураг бүгд болно.
//   Нийт хамгийн ихдээ 10. Нүд хоосон бол дахин импортод бараанд өмнө байгаа зургийг АРИЛГАХГҮЙ.
// ✅ Description — харилцагчид storefront-д харагдах тайлбар (Байршил, Баркод зэрэг дотоод мэдээлэл ОРОХГҮЙ).
//
// "Is Rental" / "Is Craft" баганад TRUE/FALSE (Excel checkbox), Y/N,
// эсвэл 1/0 — аль ч хэлбэрээр бичсэн ч зөв танина.
//
// category_id баганад Category tab-ын "id" (legacyId)-г ШУУД бичнэ —
// ингэснээр нэрний алдаа/давхардлын эрсдэлгүй, найдвартай FK холболт болно.
// ============================================================================

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { extractRowImages } from "../src/lib/product-images";
import { generateSku } from "../src/lib/sku";

const prisma = new PrismaClient();

function normalizeHeader(h: any): string {
  return (h ?? "").toString().trim().toLowerCase();
}

function findCol(headers: string[], name: string): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.indexOf(name.toLowerCase());
}

// ✅ ШИНЭЧЛЭГДСЭН: "Type" баганын regex-ийн оронд 2 тусдаа Y/N (эсвэл
// TRUE/FALSE, checkbox) багана ашиглана — илүү найдвартай, алдаанд
// өртөмтгий бус.
function parseBoolean(value: any): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value; // Excel-ийн жинхэнэ checkbox TRUE/FALSE
  const s = value.toString().trim().toLowerCase();
  return ["true", "y", "yes", "тийм", "1"].includes(s);
}

function isYes(value: any): boolean {
  const s = (value ?? "").toString().trim().toLowerCase();
  return ["yes", "y", "true", "1", "тийм"].includes(s);
}

/**
 * "Category" tab-аас "import or not" / "import tab_name" баганыг уншиж,
 * ЗӨВХӨН "yes" тэмдэгтэй мөрийн заасан tab-уудын нэрийг цуглуулна.
 * Олон ангилал НЭГ ижил tab-ыг зааж болно (Set ашигласнаар давхардахгүй).
 */
function getAllowedTabNames(workbook: XLSX.WorkBook): Set<string> | null {
  const categorySheet = workbook.Sheets["Category"];
  if (!categorySheet) return null; // Category tab байхгүй бол хязгаарлалт хийхгүй (бүх tab-ыг боловсруулна)

  const rows: any[][] = XLSX.utils.sheet_to_json(categorySheet, { header: 1 });
  if (rows.length < 2) return null;

  const headers = rows[0].map((h) => (h ?? "").toString());
  const importCol = findCol(headers, "import or not");
  const tabNameCol = findCol(headers, "import tab_name");

  if (importCol === -1 || tabNameCol === -1) return null; // баганууд байхгүй бол хязгаарлахгүй

  const allowed = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (isYes(row[importCol]) && row[tabNameCol]) {
      allowed.add(row[tabNameCol].toString().trim());
    }
  }
  return allowed;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("❌ Хэрэглээ: npx tsx scripts/import-products-from-excel.ts <файлын-зам.xlsx>");
    process.exit(1);
  }

  // ---- legacyId (Excel-ийн Category.id) → DB category.id зураглал ----
  const allCategories = await prisma.category.findMany();
  const categoryByLegacyId = new Map<number, string>();
  for (const cat of allCategories) {
    if (cat.legacyId != null) categoryByLegacyId.set(cat.legacyId, cat.id);
  }
  if (allCategories.length === 0) {
    console.warn("⚠️  Category хүснэгт хоосон байна! Эхлээд import-categories-from-excel.ts-ийг ажиллуулна уу.\n");
  }

  const workbook = XLSX.readFile(filePath);
  let totalImported = 0;
  let totalSkipped = 0;
  let categoryNotFoundCount = 0;

  const allowedTabs = getAllowedTabNames(workbook);
  if (allowedTabs) {
    console.log(`\n🎯 "Category" tab-ын "import or not"=yes мөрүүдээс зөвшөөрөгдсөн tab-ууд: ${[...allowedTabs].join(", ")}\n`);

    // ---- ✅ ШИНЭ: "yes" гэж заасан ч БОДИТООР олдоогүй tab-уудыг тод харуулна ----
    // Ихэнхдээ Excel sheet-ийн нэрэнд "/" зэрэг ХОРИГЛОСОН тэмдэгт орсон
    // байдаг (Excel үүнийг зөвшөөрдөггүй ч, текст нүдэнд орж болдог тул
    // 2 нэр чимээгүй зөрдөг) — иймд яг ЭНЭ ТОХИОЛДЛЫГ тусад нь илрүүлнэ.
    const missingTabs = [...allowedTabs].filter((name) => !workbook.SheetNames.includes(name));
    if (missingTabs.length > 0) {
      console.log("⚠️  ДООРХ tab-ууд 'yes' гэж заасан ч Excel файлаас ОЛДСОНГҮЙ:");
      for (const missing of missingTabs) {
        console.log(`   ❌ "${missing}" — магадгүй бодит tab-ын нэр өөр бичигдсэн (жишээ нь "/" тэмдэгт Excel sheet-ийн нэрэнд хориотой тул арилсан байж болно)`);
      }
      console.log(`   Бодит байгаа tab-ууд: ${workbook.SheetNames.join(", ")}\n`);
    }
  } else {
    console.log(`\n⚠️  "import or not"/"import tab_name" багана олдсонгүй — БҮХ tab боловсруулагдана\n`);
  }

  for (const sheetName of workbook.SheetNames) {
    if (sheetName.toLowerCase() === "category") continue;
    if (allowedTabs && !allowedTabs.has(sheetName)) {
      console.log(`⏭️  "${sheetName}" tab "import or not"=yes-ээр зөвшөөрөгдөөгүй тул алгасав`);
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      console.log(`⏭️  "${sheetName}" tab хоосон байна, алгасав`);
      continue;
    }

    const headers = rows[0].map((h) => (h ?? "").toString());

    const col = {
      sku: findCol(headers, "sku"),
      barcode: findCol(headers, "Barcode Number"),
      name: findCol(headers, "Product Name"),
      categoryId: findCol(headers, "category_id"),
      purchasePrice: findCol(headers, "Purchase_price"),
      isRental: findCol(headers, "Is Rental"),
      isCraft: findCol(headers, "Is Craft"),
      sellingPrice: findCol(headers, "Selling_price"),
      stock: findCol(headers, "Stock"),
      minStock: findCol(headers, "Minimum_stock"),
      color: findCol(headers, "Color"),
      size: findCol(headers, "Size"),
      location: findCol(headers, "Location"),
      unit: findCol(headers, "unit"),
      publicDescription: findCol(headers, "Description"), // ✅ ШИНЭ — харилцагчид харагдах тайлбар
    };

    if (col.name === -1 || col.sku === -1) {
      console.warn(`⚠️  "${sheetName}" tab-д "sku" эсвэл "Product Name" багана олдсонгүй — алгасав`);
      continue;
    }
    if (col.categoryId === -1) {
      console.warn(`⚠️  "${sheetName}" tab-д "category_id" багана олдсонгүй — бараа ангилалгүйгээр импортлогдоно`);
    }

    console.log(`\n📂 "${sheetName}" tab боловсруулж байна (${rows.length - 1} мөр)...`);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[col.name]) continue; // SKU хоосон байж болно (автоматаар үүснэ)

      const name = row[col.name].toString().trim();
      const skuRaw = col.sku !== -1 && row[col.sku] != null ? row[col.sku].toString().trim() : "";
      const sku = skuRaw !== "" ? skuRaw : generateSku(); // ✅ хоосон бол автоматаар үүснэ

      // ---- category_id (тоон)-оор ХАТУУ холбоно — нэрний алдаанд өртдөггүй ----
      const categoryIdRaw = col.categoryId !== -1 ? row[col.categoryId] : undefined;
      const excelCategoryId = categoryIdRaw != null && categoryIdRaw !== "" ? Number(categoryIdRaw) : undefined;
      const categoryId = excelCategoryId != null ? categoryByLegacyId.get(excelCategoryId) : undefined;
      if (excelCategoryId != null && !categoryId) {
        console.warn(`  ⚠️  "${name}": category_id ${excelCategoryId} Category хүснэгтээс олдсонгүй`);
        categoryNotFoundCount++;
      }

      const purchasePrice = col.purchasePrice !== -1 && row[col.purchasePrice] != null && row[col.purchasePrice] !== ""
        ? Number(row[col.purchasePrice])
        : undefined;
      const sellingPrice = col.sellingPrice !== -1 && row[col.sellingPrice] != null && row[col.sellingPrice] !== ""
        ? Number(row[col.sellingPrice])
        : undefined;
      const stock = col.stock !== -1 && row[col.stock] != null && row[col.stock] !== ""
        ? Number(row[col.stock])
        : 0;
      const minStock = col.minStock !== -1 && row[col.minStock] != null && row[col.minStock] !== ""
        ? Number(row[col.minStock])
        : 3;

      const isRental = col.isRental !== -1 ? parseBoolean(row[col.isRental]) : false;
      const isCraft = col.isCraft !== -1 ? parseBoolean(row[col.isCraft]) : false;

      // ✅ ШИНЭ: олон зураг — Image_url, Image_url_2 … Image_url_10 (мөн нэг нүдэнд олон). Түлхүүр зураг = эхнийх.
      const { images, invalid: invalidImages } = extractRowImages(headers, row);
      if (invalidImages.length > 0) {
        console.warn(`  ⚠️  "${name}": ${invalidImages.length} зургийн холбоос хүчингүй (https:// эсвэл Google Drive байх ёстой) — алгасав: ${invalidImages.slice(0, 2).join(", ")}`);
      }
      const publicDescription =
        col.publicDescription !== -1 && row[col.publicDescription] != null && row[col.publicDescription].toString().trim() !== ""
          ? row[col.publicDescription].toString().trim().slice(0, 2000)
          : undefined;

      const extraParts: string[] = [];
      // ✅ ЗАСВАР: Color, Size одоо ТУСДАА баганад хадгалагдах тул
      // description-д ДАВХАР бичихгүй (зөвхөн Location/unit/Barcode л
      // description-д нэгтгэгдсэн хэвээр — эдгээрт тусдаа багана байхгүй).
      if (col.location !== -1 && row[col.location] != null && row[col.location] !== "") extraParts.push(`Байршил: ${row[col.location]}`);
      if (col.unit !== -1 && row[col.unit] != null && row[col.unit] !== "") extraParts.push(`Нэгж: ${row[col.unit]}`);
      if (col.barcode !== -1 && row[col.barcode] != null && row[col.barcode] !== "") extraParts.push(`Баркод: ${row[col.barcode]}`);
      const description = extraParts.length > 0 ? extraParts.join(" | ") : undefined;

      // ✅ ЗАСВАР: `row[col.size]` тоон 0 байвал JavaScript үүнийг "falsy"
      // гэж үздэг тул урьдын `row[col.size] ? ... : undefined` шалгалт
      // "0"-ийг алдагдуулж байсан (жишээ нь "0" тоот лаа). Одоо `!= null`
      // ашигласнаар 0 (тоо) болон "0" (текст) хоёулаа ЗӨВ хадгалагдана.
      const colorValue =
        col.color !== -1 && row[col.color] != null && row[col.color].toString().trim() !== ""
          ? row[col.color].toString().trim()
          : undefined;
      const sizeValue =
        col.size !== -1 && row[col.size] != null && row[col.size].toString().trim() !== ""
          ? row[col.size].toString().trim()
          : undefined;

      // ============================================================================
      // ✅ ЗАСВАР: isRental эсэхээс хамааруулж ЗӨВ талбар руу зурагладаг
      // болгов — өмнө нь БҮХ мөр (Түрээс ч, Зарах ч) адилхан sellPrice/
      // costPrice/sellStockQty руу орж, rentalStockQty ХЭЗЭЭ Ч тохируулагдаагүй
      // байсан тул импортолсон бүх ТҮРЭЭСИЙН бараа 0 үлдэгдэлтэй (=ХЭЗЭЭ Ч
      // захиалагдахгүй) болчихсон байсан.
      //
      //   isRental=true  → Selling_price → rentalPricePerDay (өдрийн үнэ)
      //                     Purchase_price → depositAmount (барьцаа)
      //                     Stock → rentalStockQty (түрээслэгдэх нийт ширхэг)
      //                     sellPrice/sellStockQty = хоосон/0 (харшихгүй)
      //
      //   isRental=false → Selling_price → sellPrice (зарах үнэ)
      //                     Purchase_price → costPrice (өртөг)
      //                     Stock → sellStockQty (зарагдах үлдэгдэл)
      // ============================================================================
      const variableFields: Record<string, unknown> = {};
      if (isRental) {
        if (sellingPrice != null) variableFields.rentalPricePerDay = sellingPrice;
        if (purchasePrice != null) variableFields.depositAmount = purchasePrice;
        variableFields.rentalStockQty = stock;
        variableFields.sellStockQty = 0;
      } else {
        if (sellingPrice != null) variableFields.sellPrice = sellingPrice;
        if (purchasePrice != null) variableFields.costPrice = purchasePrice;
        variableFields.sellStockQty = stock;
      }

      try {
        await prisma.product.upsert({
          where: { sku },
          update: {
            name,
            categoryId,
            description,
            color: colorValue,
            size: sizeValue,
            isCraft,
            isRental,
            minStockAlert: minStock,
            ...(images.length > 0 && { imageUrl: images[0], imageUrls: images }),
            ...(publicDescription !== undefined && { publicDescription }),
            ...variableFields,
          },
          create: {
            name,
            sku,
            categoryId,
            description,
            color: colorValue,
            size: sizeValue,
            minStockAlert: minStock,
            imageUrl: images[0] ?? null,
            imageUrls: images,
            publicDescription,
            isCraft,
            isRental,
            costPrice: 0, // ✅ Заавал default — variableFields нь isRental бол costPrice-ыг орхигдуулдаг
            ...variableFields,
          },
        });
        totalImported++;
        console.log(`  ✅ ${name} (${sku})${images.length > 0 ? ` 🖼️×${images.length}` : ""}`);
      } catch (err) {
        totalSkipped++;
        console.error(`  ❌ ${name} импортлоход алдаа гарлаа:`, (err as Error).message);
      }
    }
  }

  console.log(`\n🎉 Дууслаа: ${totalImported} бараа импортлогдлоо, ${totalSkipped} алгасагдлаа.`);
  if (categoryNotFoundCount > 0) {
    console.log(`⚠️  ${categoryNotFoundCount} мөрийн category_id олдоогүй тул categoryId=null болсон.\n`);
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
