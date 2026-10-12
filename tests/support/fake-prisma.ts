// ============================================================================
// FAKE PRISMA — тестэд зориулсан санах ойн өгөгдлийн сан (Postgres READ COMMITTED-ийг дуурайна)
// ----------------------------------------------------------------------------
// Дуурайдаг зүйлс (төлбөрийн уралдааны тестэд хэрэгтэй):
//   - Transaction бүр өөрийн бичилтийг (overlay) commit хүртэл бусдад ХАРУУЛАХГҮЙ (dirty read байхгүй).
//   - Мөр бичих (update/updateMany) нь мөрийн түгжээ авна; түгжээтэй мөрийг өөр transaction хүлээнэ,
//     түгжээ чөлөөлөгдсөний дараа WHERE нөхцөлийг ДАХИН шалгана (Postgres-ийн READ COMMITTED recheck).
//   - Алдаа гарвал rollback (overlay хаяна). Гадна транзакцгүй дуудлага бүр өөрийн auto-commit.
//   - Алдаа тарьж (failOnce) "дундаас унасан" боловсруулалтыг туршина.
// Дэмждэг: findUnique/findUniqueOrThrow/findFirst/findMany/count/create/update/updateMany,
//   where: тэнцүү, in, notIn, not, gt/gte/lt/lte, OR/AND, null, шигтгэсэн (embedded) объект; data: increment/decrement.
// ============================================================================

type Row = Record<string, any>;
const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));
const tick = () => new Promise<void>((r) => setImmediate(r));

function cmp(a: any, b: any): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}
const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? cmp(a, b) === 0 : a === b);
const OPS = ["in", "notIn", "not", "gt", "gte", "lt", "lte", "equals"];

export function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(v as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    const val = row[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length > 0 && keys.every((o) => OPS.includes(o))) {
        const o = v as Row;
        if ("equals" in o && !eq(val, o.equals)) return false;
        if ("in" in o && !o.in.some((x: any) => eq(val, x))) return false;
        if ("notIn" in o && o.notIn.some((x: any) => eq(val, x))) return false;
        if ("not" in o && eq(val, o.not)) return false;
        if ("gt" in o && !(val != null && cmp(val, o.gt) > 0)) return false;
        if ("gte" in o && !(val != null && cmp(val, o.gte) >= 0)) return false;
        if ("lt" in o && !(val != null && cmp(val, o.lt) < 0)) return false;
        if ("lte" in o && !(val != null && cmp(val, o.lte) <= 0)) return false;
      } else if (val == null || !matches(val, v as Row)) return false;
    } else if (!eq(val, v)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && ("increment" in v || "decrement" in v)) {
      row[k] = Number(row[k] ?? 0) + Number((v as Row).increment ?? 0) - Number((v as Row).decrement ?? 0);
    } else row[k] = clone(v);
  }
}

export class FakeDb {
  committed: Record<string, Map<string, Row>> = {};
  private locks = new Map<string, { owner: number; waiters: Array<() => void> }>();
  private faults: Array<{ table: string; op: string; times: number; error: Error; when?: (args: any) => boolean }> = [];
  private hooks: Array<{ table: string; op: string; fn: (args: any, db: FakeDb) => void; once: boolean; done?: boolean }> = [];
  private seq = 0;
  private sessionSeq = 0;
  log: Array<{ table: string; op: string }> = [];

  table(name: string) {
    return (this.committed[name] ??= new Map());
  }
  /** Тестийн seed: шууд committed-д бичнэ. */
  seed(table: string, row: Row) {
    const r = { id: row.id ?? `${table}-${++this.seq}`, ...row };
    this.table(table).set(r.id, clone(r));
    return r;
  }
  all(table: string): Row[] {
    return [...this.table(table).values()].map(clone);
  }
  get(table: string, id: string): Row | undefined {
    const r = this.table(table).get(id);
    return r ? clone(r) : undefined;
  }
  /** Дараагийн `times` удаагийн table.op дуудлагад алдаа шидүүлнэ. */
  failOnce(table: string, op: string, error = new Error("INJECTED_FAILURE"), times = 1, when?: (args: any) => boolean) {
    this.faults.push({ table, op, times, error, when });
  }
  /** table.op дуудагдахын өмнө нэг удаа ажиллах hook (жишээ: "зэрэгцээ commit"-ийг дуурайх). */
  beforeOnce(table: string, op: string, fn: (args: any, db: FakeDb) => void) {
    this.hooks.push({ table, op, fn, once: true });
  }
  _checkFault(table: string, op: string, args: any) {
    for (const h of this.hooks) if (!h.done && h.table === table && h.op === op) { h.done = true; h.fn(args, this); }
    for (const f of this.faults) {
      if (f.table === table && f.op === op && f.times > 0 && (!f.when || f.when(args))) {
        f.times--;
        throw f.error;
      }
    }
  }
  async _lock(key: string, owner: number) {
    for (;;) {
      const l = this.locks.get(key);
      if (!l) { this.locks.set(key, { owner, waiters: [] }); return; }
      if (l.owner === owner) return;
      await new Promise<void>((r) => l.waiters.push(r));
    }
  }
  _release(owner: number, keys: Iterable<string>) {
    for (const key of keys) {
      const l = this.locks.get(key);
      if (l && l.owner === owner) {
        this.locks.delete(key);
        l.waiters.forEach((w) => w());
      }
    }
  }
  newSession() {
    return new Session(this, ++this.sessionSeq);
  }
  nextId(table: string) {
    return `${table}-gen-${++this.seq}`;
  }

  /** prisma-тэй төстэй клиент (auto-commit). */
  client(): any {
    const db = this;
    const root: any = {
      async $transaction(fn: (tx: any) => Promise<any>, _opts?: any) {
        const s = db.newSession();
        try {
          const out = await fn(s.client());
          s.commit();
          return out;
        } catch (e) {
          s.rollback();
          throw e;
        }
      },
    };
    return new Proxy(root, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return new Proxy({}, {
          get: (_t, op: string) => async (args: any) => {
            const s = db.newSession();
            try {
              const out = await s.run(prop, op, args);
              s.commit();
              return out;
            } catch (e) {
              s.rollback();
              throw e;
            }
          },
        });
      },
    });
  }
}

class Session {
  overlay = new Map<string, Row | null>(); // "table:id" → row | null(deleted)
  held = new Set<string>();
  constructor(private db: FakeDb, private id: number) {}

  private visible(table: string, id: string): Row | undefined {
    const k = `${table}:${id}`;
    if (this.overlay.has(k)) return this.overlay.get(k) ?? undefined;
    return this.db.table(table).get(id);
  }
  private visibleRows(table: string): Row[] {
    const ids = new Set<string>([...this.db.table(table).keys()]);
    for (const k of this.overlay.keys()) if (k.startsWith(`${table}:`)) ids.add(k.slice(table.length + 1));
    return [...ids].map((id) => this.visible(table, id)).filter(Boolean) as Row[];
  }
  private async lockRow(table: string, id: string) {
    const k = `${table}:${id}`;
    await this.db._lock(k, this.id);
    this.held.add(k);
  }
  commit() {
    for (const [k, v] of this.overlay) {
      const i = k.indexOf(":");
      const t = this.db.table(k.slice(0, i));
      const id = k.slice(i + 1);
      if (v === null) t.delete(id);
      else t.set(id, clone(v));
    }
    this.db._release(this.id, this.held);
  }
  rollback() {
    this.db._release(this.id, this.held);
  }
  client(): any {
    const s = this;
    return new Proxy({}, {
      get: (_t, table: string) =>
        new Proxy({}, { get: (_t2, op: string) => (args: any) => s.run(table, op, args) }),
    });
  }

  async run(table: string, op: string, args: any = {}): Promise<any> {
    await tick();
    this.db.log.push({ table, op });
    this.db._checkFault(table, op, args);
    const where = args.where ?? {};
    switch (op) {
      case "findUnique":
      case "findFirst": {
        const row = this.visibleRows(table).find((r) => matches(r, where));
        return row ? clone(row) : null;
      }
      case "findUniqueOrThrow": {
        const row = this.visibleRows(table).find((r) => matches(r, where));
        if (!row) throw new Error(`${table}.findUniqueOrThrow: not found`);
        return clone(row);
      }
      case "findMany": {
        let rows = this.visibleRows(table).filter((r) => matches(r, where));
        if (args.orderBy) {
          const [[f, dir]] = Object.entries(args.orderBy) as any;
          rows = rows.sort((a, b) => cmp(a[f], b[f]) * (dir === "desc" ? -1 : 1));
        }
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map(clone);
      }
      case "count":
        return this.visibleRows(table).filter((r) => matches(r, where)).length;
      case "create": {
        const row = { id: args.data.id ?? this.db.nextId(table), createdAt: new Date(), ...clone(args.data) };
        this.overlay.set(`${table}:${row.id}`, row);
        await this.lockRow(table, row.id);
        return clone(row);
      }
      case "update": {
        const cand = this.visibleRows(table).find((r) => matches(r, where));
        if (!cand) throw new Error(`${table}.update: record not found`);
        await this.lockRow(table, cand.id);
        const cur = this.visible(table, cand.id);
        if (!cur) throw new Error(`${table}.update: record not found`);
        const next = clone(cur);
        applyData(next, args.data);
        this.overlay.set(`${table}:${cand.id}`, next);
        return clone(next);
      }
      case "updateMany": {
        const cands = this.visibleRows(table).filter((r) => matches(r, where));
        let count = 0;
        for (const c of cands) {
          await this.lockRow(table, c.id);
          const cur = this.visible(table, c.id); // түгжээ авсны ДАРАА дахин уншиж, WHERE-ийг ДАХИН шалгана (READ COMMITTED)
          if (!cur || !matches(cur, where)) continue;
          const next = clone(cur);
          applyData(next, args.data);
          this.overlay.set(`${table}:${c.id}`, next);
          count++;
        }
        return { count };
      }
      default:
        throw new Error(`FakePrisma: ${table}.${op} дэмжигдээгүй`);
    }
  }
}
