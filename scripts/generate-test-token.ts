// ============================================================================
// TEST TOKEN GENERATOR — Socket.io холболтод зориулсан JWT туршилтын токен
// ----------------------------------------------------------------------------
// Ажиллуулах: npx tsx scripts/generate-test-token.ts
// Консол дээр гарч ирэх токеныг realtime-test-client.html файлд тавина.
// ============================================================================

import "dotenv/config";
import jwt from "jsonwebtoken";

const payload = {
  staffId: "test-staff-001",
  storeId: "default",
};

const token = jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "30d" });

console.log("\n✅ Туршилтын JWT токен (30 хоног хүчинтэй):\n");
console.log(token);
console.log("\nЭнэ токеныг realtime-test-client.html файл доторх AUTH_TOKEN хувьсагчид тавина уу.\n");
