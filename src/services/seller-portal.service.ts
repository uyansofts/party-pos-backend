// ============================================================================
// SELLER PORTAL SERVICE — Худалдагчийн жижиг портал: нэвтрэлт (Shop-ийн холбоос + 6 оронтой PIN), эзэмшлийн хяналт.
// Аюулгүй байдал:
//   • PIN-г bcrypt-ээр хадгална; Staff үүсгэж НЭГ л удаа харуулна; солигдвол хуучин токен БҮГД хүчингүй (pinVersion)
//   • Буруу PIN-ийг нэг shop дээр 15 минутад 5 удаа оролдоход түгжинэ (+ IP тус бүрийн хязгаар controller-д)
//   • Алдааны мессеж ҮРГЭЛЖ ижил (shop байгаа эсэхийг задруулахгүй)
//   • Токен зөвхөн ИДЭВХТЭЙ худалдагчид; түдгэлзүүлбэл токен шууд хүчингүй
// ============================================================================

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { hashPin, verifyPin } from "./courier-auth.service";
import { normalizeSlug } from "../lib/seller";
import { AttemptLimiter } from "../lib/customer-tracking";

export class SellerPortalError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "SellerPortalError";
    this.status = status;
  }
}

export const PORTAL_TOKEN_TTL = "12h";
export const loginLimiter = new AttemptLimiter(5, 15 * 60_000);

/** 6 оронтой санамсаргүй PIN (криптографийн санамсаргүй). */
export function generatePortalPin(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** Staff: худалдагчийн портал PIN үүсгэх/сэргээх. PIN-г НЭГ л удаа буцаана; хуучин нэвтрэлт бүгд хүчингүй болно. */
export async function resetSellerPortalPin(sellerId: string): Promise<{ pin: string }> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new SellerPortalError("Худалдагч олдсонгүй", 404);
  const pin = generatePortalPin();
  await prisma.seller.update({ where: { id: sellerId }, data: { pinHash: await hashPin(pin), pinVersion: { increment: 1 } } });
  loginLimiter.success(seller.slug); // Staff шинэ PIN өгсөн тул түгжээ арилна
  return { pin };
}

let dummyHash: string | null = null;

export async function loginSeller(slugRaw: unknown, pinRaw: unknown, limiter: AttemptLimiter = loginLimiter) {
  const generic = () => new SellerPortalError("Shop-ийн холбоос эсвэл PIN буруу байна", 401);
  const slug = normalizeSlug(slugRaw);
  const pin = typeof pinRaw === "string" || typeof pinRaw === "number" ? String(pinRaw).trim() : "";
  if (!slug || !/^\d{6}$/.test(pin)) throw generic();

  const gate = limiter.check(slug);
  if (!gate.allowed) throw new SellerPortalError(`Хэт олон удаа буруу оролдлоо. ${Math.ceil(gate.retryAfterSec / 60)} минутын дараа дахин оролдоно уу`, 429);

  const seller = await prisma.seller.findUnique({ where: { slug } });
  let ok = false;
  if (seller?.pinHash) {
    ok = await verifyPin(pin, seller.pinHash);
  } else {
    // Shop байхгүй/PIN-гүй үед ч bcrypt-ийн хугацааг тэнцүүлнэ (хугацаагаар shop байгааг мэдэхээс сэргийлнэ)
    dummyHash = dummyHash ?? (await hashPin("000000"));
    await verifyPin(pin, dummyHash);
  }
  if (!ok || !seller) {
    limiter.fail(slug);
    throw generic();
  }
  limiter.success(slug);
  if (seller.status !== "ACTIVE") throw new SellerPortalError("Таны shop идэвхгүй байна (түдгэлзсэн эсвэл хүлээгдэж буй) — дэлгүүртэй холбогдоно уу", 403);

  const token = jwt.sign({ type: "seller", sellerId: seller.id, pv: seller.pinVersion }, process.env.JWT_SECRET as string, { expiresIn: PORTAL_TOKEN_TTL } as any);
  return { token, seller: { id: seller.id, name: seller.name, slug: seller.slug } };
}

/** Токеныг шалгаж, худалдагчийг буцаана. PIN солигдсон / түдгэлзсэн / хугацаа дууссан бол алдаа. */
export async function authenticateSeller(token: string): Promise<{ id: string; name: string }> {
  const expired = () => new SellerPortalError("Нэвтрэх хугацаа дууссан — дахин нэвтэрнэ үү", 401);
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET as string);
  } catch {
    throw expired();
  }
  if (!payload || payload.type !== "seller" || typeof payload.sellerId !== "string") throw expired();
  const seller = await prisma.seller.findUnique({ where: { id: payload.sellerId }, select: { id: true, name: true, status: true, pinVersion: true } });
  if (!seller || seller.pinVersion !== payload.pv) throw expired();
  if (seller.status !== "ACTIVE") throw new SellerPortalError("Таны shop идэвхгүй байна — дэлгүүртэй холбогдоно уу", 403);
  return { id: seller.id, name: seller.name };
}

export async function getPortalMe(sellerId: string) {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new SellerPortalError("Худалдагч олдсонгүй", 404);
  const count = (sellerStatus: string, extra: Record<string, unknown> = {}) => prisma.order.count({ where: { sellerId, sellerStatus: sellerStatus as any, ...extra } as any });
  const [awaiting, accepted, ready] = await Promise.all([
    count("AWAITING_SELLER"),
    count("ACCEPTED"),
    count("READY", { deliveryAssignStatus: { in: ["UNASSIGNED", "OFFERED", "ASSIGNED"] } }), // курьер хараахан аваагүй
  ]);
  // ✅ ШИНЭ: Онцлох / хямдралтай барааны комиссын нэмэлт % — худалдагч ил тод мэдэх ёстой
  const settings: any = await prisma.shopSettings.findUnique({ where: { id: "default" } });
  const commissionExtras = { featured: Number(settings?.featuredCommissionExtraPercent ?? 2), sale: Number(settings?.saleCommissionExtraPercent ?? 2) };
  return { id: seller.id, name: seller.name, slug: seller.slug, commissionPercent: seller.commissionPercent, commissionExtras, awaitingCount: awaiting, acceptedCount: accepted, readyCount: ready };
}
