// ============================================================================
// IMAGE UPLOAD — Зураг файлаар upload хийх: шалгалт + хадгалалт (local диск эсвэл Supabase Storage).
//   • Файлын ТӨРЛИЙГ "magic bytes"-аар шалгана (Content-Type, өргөтгөлд ИТГЭХГҮЙ). JPEG/PNG/WebP л — SVG/HTML/GIF хориотой (XSS, хэт том).
//   • Нэр санамсаргүй (u_ + 24 hex) — таах боломжгүй, зам-инжекцгүй. Манай /api/images/:id proxy-гоор үйлчилнэ (nosniff).
//   • Хамаарал нэмэхгүй (multer/sharp-гүй): хэмжээг хөтөч/утсан дээр шахаж, сервер зөвхөн шалгана.
// ============================================================================

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import axios from "axios";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ImageExt = "jpg" | "png" | "webp";

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MIN_UPLOAD_BYTES = 100;
export const UPLOADED_ID = /^u_[a-f0-9]{24}$/;
const EXT_BY_MIME: Record<ImageMime, ImageExt> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME_BY_EXT: Record<ImageExt, ImageMime> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function detectImage(buf: Buffer): { mime: ImageMime; ext: ImageExt } | null {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export function newImageId(): string {
  return "u_" + crypto.randomBytes(12).toString("hex");
}

export interface ImageStore {
  put(id: string, buf: Buffer, mime: ImageMime): Promise<void>;
  get(id: string): Promise<{ buf: Buffer; mime: ImageMime } | null>;
}

/** Local диск: `${dir}/${id}.${ext}`. АНХААР: Render/Railway/Heroku шиг түр диск дээр redeploy хийхэд файл устна — persistent volume эсвэл Supabase ашиглана. */
export class LocalImageStore implements ImageStore {
  constructor(private readonly dir: string) {}
  async put(id: string, buf: Buffer, mime: ImageMime): Promise<void> {
    if (!UPLOADED_ID.test(id)) throw new UploadError("Буруу зургийн id");
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${id}.${EXT_BY_MIME[mime]}`), buf, { flag: "wx" }); // wx — давхар бичихгүй
  }
  async get(id: string) {
    if (!UPLOADED_ID.test(id)) return null; // зам-инжекц ("../") боломжгүй
    for (const ext of ["jpg", "png", "webp"] as ImageExt[]) {
      try {
        return { buf: await fs.readFile(path.join(this.dir, `${id}.${ext}`)), mime: MIME_BY_EXT[ext] };
      } catch {
        /* дараагийн өргөтгөл */
      }
    }
    return null;
  }
}

/** Supabase Storage (REST). Bucket private байж болно — манай proxy service key-ээр уншиж, кэшлэж үйлчилнэ. */
export class SupabaseImageStore implements ImageStore {
  constructor(private readonly cfg: { url: string; key: string; bucket: string }, private readonly http: any = axios) {}
  private base() {
    return `${this.cfg.url.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(this.cfg.bucket)}`;
  }
  async put(id: string, buf: Buffer, mime: ImageMime): Promise<void> {
    if (!UPLOADED_ID.test(id)) throw new UploadError("Буруу зургийн id");
    await this.http.post(`${this.base()}/${id}.${EXT_BY_MIME[mime]}`, buf, {
      headers: { Authorization: `Bearer ${this.cfg.key}`, apikey: this.cfg.key, "Content-Type": mime, "x-upsert": "false" },
      maxBodyLength: MAX_UPLOAD_BYTES + 1024,
      timeout: 15_000,
    });
  }
  async get(id: string) {
    if (!UPLOADED_ID.test(id)) return null;
    for (const ext of ["jpg", "png", "webp"] as ImageExt[]) {
      try {
        const r = await this.http.get(`${this.base()}/${id}.${ext}`, { headers: { Authorization: `Bearer ${this.cfg.key}`, apikey: this.cfg.key }, responseType: "arraybuffer", timeout: 10_000 });
        return { buf: Buffer.from(r.data), mime: MIME_BY_EXT[ext] };
      } catch (err: any) {
        if (err?.response?.status && err.response.status !== 400 && err.response.status !== 404) throw err; // 400/404 = олдсонгүй; бусад нь жинхэнэ алдаа
      }
    }
    return null;
  }
}

export function createImageStoreFromEnv(env: Record<string, string | undefined> = process.env): ImageStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return new SupabaseImageStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, bucket: env.SUPABASE_BUCKET || "product-images" });
  }
  return new LocalImageStore(env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
}

let sharedStore: ImageStore | null = null;
/** Нэг л хадгалалтын объект (env-ээс). Тестэд setImageStoreForTests-ээр солино. */
export function getImageStore(): ImageStore {
  return (sharedStore ??= createImageStoreFromEnv());
}
export function setImageStoreForTests(store: ImageStore | null) {
  sharedStore = store;
}

/** Нийтийн хаяг — манай image-proxy (resolveImageUrl, listing-ийн шалгалт хоёулаа "өөрийн proxy" гэж таньдаг). */
export function publicImageUrl(id: string, env: Record<string, string | undefined> = process.env): string {
  return `${(env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/+$/, "")}/api/images/${id}`;
}

export async function saveUploadedImage(store: ImageStore, buf: unknown, env: Record<string, string | undefined> = process.env) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new UploadError("Зураг илгээгдсэнгүй — Content-Type image/jpeg, image/png эсвэл image/webp байх ёстой", 415);
  if (buf.length < MIN_UPLOAD_BYTES) throw new UploadError("Файл хэт жижиг — зураг биш байна");
  if (buf.length > MAX_UPLOAD_BYTES) throw new UploadError(`Зураг ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB-аас их байна — жижигрүүлж шахаад дахин оруулна уу`, 413);
  const kind = detectImage(buf);
  if (!kind) throw new UploadError("Зөвхөн JPEG, PNG, WebP зураг оруулна (файлын агуулга зураг биш байна)", 415);
  const id = newImageId();
  await store.put(id, buf, kind.mime);
  return { id, url: publicImageUrl(id, env), mime: kind.mime, bytes: buf.length };
}

/** Хөтөч/утсан дээр шахах хэмжээ: урт тал нь max-аас хэтрэхгүйгээр харьцааг хадгална (томруулахгүй). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
