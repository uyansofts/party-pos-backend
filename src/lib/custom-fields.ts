// ============================================================================
// CUSTOM FIELDS — Барааны "Хувийн мэдээллийн талбарууд" (нэр, төрсөн цаг, өндөр,
// жин г.м.). Staff бараа бүрд талбаруудыг тодорхойлно; харилцагч/кассчин захиалга
// өгөхдөө бөглөнө; сервер шалгаж, захиалгын мөрд (snapshot) хадгална.
// ----------------------------------------------------------------------------
// - Төрөл: text (текст), number (тоо), time (цаг ЦЦ:ММ)
// - Талбарын түлхүүр (key) серверт f1, f2, ... гэж дарааллаар оноогдоно
// - Хадгалсан утгад нэр/нэгжийн хуулбар (snapshot) орох тул хожим талбарыг
//   өөрчилсөн ч хуучин захиалгууд буруу харагдахгүй
// ============================================================================

export type CustomFieldType = "text" | "number" | "time";

export type CustomFieldDef = {
  key: string;
  label: string;
  type: CustomFieldType;
  unit: string | null;
  required: boolean;
  maxLength: number;
};

export type CustomFieldValue = {
  key: string;
  label: string;
  type: CustomFieldType;
  unit: string | null;
  value: string;
};

export class CustomFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomFieldError";
  }
}

export const MAX_CUSTOM_FIELDS = 12;
const TYPES: string[] = ["text", "number", "time"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Staff-ийн илгээсэн талбарын тодорхойлолтыг шалгаж, цэвэрлэж, түлхүүр оноож буцаана. */
export function normalizeCustomFieldDefs(input: unknown): CustomFieldDef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new CustomFieldError("customFields нь жагсаалт байх ёстой");
  if (input.length > MAX_CUSTOM_FIELDS) {
    throw new CustomFieldError(`Хувийн мэдээллийн талбар ${MAX_CUSTOM_FIELDS}-аас олон байж болохгүй`);
  }

  return input.map((raw: any, i: number) => {
    const label = String(raw?.label ?? "").trim();
    if (!label) throw new CustomFieldError(`${i + 1}-р талбарын нэр хоосон байна`);
    if (label.length > 40) throw new CustomFieldError(`"${label.slice(0, 15)}…" талбарын нэр 40 тэмдэгтээс ихгүй байх ёстой`);

    const type = String(raw?.type ?? "text");
    if (!TYPES.includes(type)) throw new CustomFieldError(`"${label}" талбарын төрөл text, number, time-ийн аль нэг байх ёстой`);

    const unit = String(raw?.unit ?? "").trim();
    if (unit.length > 10) throw new CustomFieldError(`"${label}" талбарын нэгж 10 тэмдэгтээс ихгүй байх ёстой`);

    const parsedMax = Math.round(Number(raw?.maxLength ?? 50));
    const maxLength = Number.isFinite(parsedMax) ? Math.min(200, Math.max(1, parsedMax)) : 50;

    return { key: `f${i + 1}`, label, type: type as CustomFieldType, unit: unit || null, required: Boolean(raw?.required), maxLength };
  });
}

/** Өгөгдлийн сангаас уншсан JSON-г уян хатан (алдаа өгөхгүй) талбарын жагсаалт болгоно. */
export function parseStoredCustomFieldDefs(json: unknown): CustomFieldDef[] {
  try {
    return normalizeCustomFieldDefs(json);
  } catch {
    return [];
  }
}

/**
 * Хэрэглэгчийн бөглөсөн утгуудыг (key → утга) талбарын тодорхойлолтоор шалгана.
 * Тодорхойлолтод байхгүй түлхүүрийг үл тооцно. Хоосон, заавал биш талбарыг алгасна.
 */
export function validateCustomFieldValues(defs: CustomFieldDef[], values: unknown): CustomFieldValue[] {
  const provided = values && typeof values === "object" && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  const result: CustomFieldValue[] = [];

  for (const def of defs) {
    const raw = provided[def.key];
    let value = raw === undefined || raw === null ? "" : String(raw).trim();

    if (value === "") {
      if (def.required) throw new CustomFieldError(`"${def.label}" талбарыг заавал бөглөнө үү`);
      continue;
    }
    if (value.length > def.maxLength) {
      throw new CustomFieldError(`"${def.label}" ${def.maxLength} тэмдэгтээс ихгүй байх ёстой`);
    }
    if (def.type === "number") {
      value = value.replace(",", ".");
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        throw new CustomFieldError(`"${def.label}" талбарт зөв тоо оруулна уу`);
      }
    }
    if (def.type === "time" && !TIME_RE.test(value)) {
      throw new CustomFieldError(`"${def.label}" талбарт цагийг ЦЦ:ММ хэлбэрээр оруулна уу (жишээ: 08:08)`);
    }

    result.push({ key: def.key, label: def.label, type: def.type, unit: def.unit, value });
  }
  return result;
}

/** Нэг мөр хураангуй — "Нэр: Анхилуун · Цаг: 08:08 · Өндөр: 52 см · Жин: 3450 грамм" */
export function summarizeCustomFieldValues(values: CustomFieldValue[]): string {
  return values.map((v) => `${v.label}: ${v.value}${v.unit ? " " + v.unit : ""}`).join(" · ");
}
