"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateCostPrice = recalculateCostPrice;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function recalculateCostPrice(productId) {
    const [materials, laborCosts] = await Promise.all([
        prisma.craftRecipe.findMany({ where: { productId } }),
        prisma.craftLaborCost.findMany({ where: { productId } }),
    ]);
    const materialCost = materials.reduce((sum, m) => sum + Number(m.quantity) * Number(m.unitCostSnapshot), 0);
    const laborCost = laborCosts.reduce((sum, l) => sum + Number(l.totalCost), 0);
    const totalCost = materialCost + laborCost;
    await prisma.product.update({
        where: { id: productId },
        data: { costPrice: totalCost },
    });
    return totalCost;
}
//# sourceMappingURL=product-cost.service.js.map