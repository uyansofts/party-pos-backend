// ============================================================================
// PRODUCT COST SERVICE
// ----------------------------------------------------------------------------
// Product.costPrice = SUM(CraftRecipe.quantity * unitCostSnapshot)
//                    + SUM(CraftLaborCost.totalCost)
//
// Энэ функцийг CraftRecipe/CraftLaborCost мөр бүр НЭМЭГДЭХ, ӨӨРЧЛӨГДӨХ,
// УСТГАГДАХ бүрд дуудаж Product.costPrice-ыг дахин тооцно. Ингэснээр DB
// доторх Product.costPrice ЯМАГТ бодит өртгийн задаргаатай синк байна.
// ============================================================================

import { prisma } from "../lib/prisma";


export async function recalculateCostPrice(productId: string): Promise<number> {
  const [materials, laborCosts] = await Promise.all([
    prisma.craftRecipe.findMany({ where: { productId } }),
    prisma.craftLaborCost.findMany({ where: { productId } }),
  ]);

  const materialCost = materials.reduce(
    (sum, m) => sum + Number(m.quantity) * Number(m.unitCostSnapshot),
    0
  );
  const laborCost = laborCosts.reduce((sum, l) => sum + Number(l.totalCost), 0);
  const totalCost = materialCost + laborCost;

  await prisma.product.update({
    where: { id: productId },
    data: { costPrice: totalCost },
  });

  return totalCost;
}
