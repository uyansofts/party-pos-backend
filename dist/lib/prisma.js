"use strict";
// ============================================================================
// PRISMA CLIENT SINGLETON
// ----------------------------------------------------------------------------
// Development орчинд hot-reload хийх бүрд шинэ PrismaClient үүсгэвэл
// "too many connections" алдаа гардаг тул globalThis дээр кэшилнэ.
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ?? new client_1.PrismaClient();
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
}
//# sourceMappingURL=prisma.js.map