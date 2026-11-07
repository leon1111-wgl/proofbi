/* Third line of defence, on the real engine: official SQLite compiled to WebAssembly.
 *
 * - The database is deserialized read-only and `PRAGMA query_only` is on.
 * - Each identity gets TEMP views named like the tables, so SQLite's own name resolution sends every
 *   reference, in any syntactic position, through that identity's row filter and column list.
 * - The authorizer sees what SQLite says each statement really reads and allows SELECT, whitelisted
 *   columns and functions only. A physical table may be read only from inside a policy view.
 * - A progress handler stops long queries, and at most max_rows rows are fetched. */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { PACK, allowedColumns, predicate, type PackUser } from "./pack";
import type { Cell } from "./verifier";

export class QueryError extends Error {
  constructor(message: string, public kind: "execution" | "timeout" | "denied") { super(message); }
}
export interface QueryResult { columns: string[]; rows: Cell[][]; row_count: number; truncated: boolean; elapsed_ms: number; result_hash: string; executed_at: string }

export async function sha256(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const resultHash = (columns: string[], rows: Cell[][]) => sha256(JSON.stringify({ columns, rows }));

export const WAREHOUSE_SQLITE_VERSION = () => loaded?.version.libVersion ?? null;

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let loaded: Sqlite3 | null = null;

async function initSqlite(): Promise<Sqlite3> {
  if (loaded) return loaded;
  // SQLite reports refused statements on the console; they are expected here and shown in the answer instead
  const quiet = () => undefined;
  (globalThis as unknown as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { warn: quiet, error: quiet, log: quiet, debug: quiet };
  loaded = await (sqlite3InitModule as unknown as (opts: unknown) => Promise<Sqlite3>)({ print: quiet, printErr: quiet });
  return loaded;
}

const TEXT = (wasm: Sqlite3["wasm"], x: unknown): string | null =>
  x === null || x === undefined || x === 0 ? null : typeof x === "string" ? x : wasm.cstrToJs(x as never);

export class Warehouse {
  private identity: string | null = null;
  private strict = false;
  private allowed: Record<string, Set<string>> = {};
  private unfiltered = new Set<string>();
  private denied: string[] = [];
  private constructor(private sqlite3: Sqlite3, private db: InstanceType<Sqlite3["oo1"]["DB"]>) {}

  static async open(bytes: Uint8Array): Promise<Warehouse> {
    const sqlite3 = await initSqlite();
    const { capi, wasm, oo1 } = sqlite3;
    const db = new oo1.DB(":memory:");
    const data = wasm.allocFromTypedArray(new Uint8Array(bytes));
    const rc = capi.sqlite3_deserialize(db.pointer!, "main", data, bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY);
    if (rc !== 0) throw new Error(`warehouse failed to load: sqlite rc ${rc}`);
    const w = new Warehouse(sqlite3, db);
    w.installAuthorizer();
    return w;
  }

  private installAuthorizer() {
    const { capi, wasm } = this.sqlite3;
    const functions = new Set(PACK.guard.authorizer_functions);
    capi.sqlite3_set_authorizer(this.db.pointer!, (_ud: unknown, action: number, a1: unknown, a2: unknown, dbName: unknown, source: unknown) => {
      if (!this.strict) return capi.SQLITE_OK;
      const arg1 = TEXT(wasm, a1), arg2 = TEXT(wasm, a2), schema = TEXT(wasm, dbName), via = TEXT(wasm, source);
      if (action === capi.SQLITE_SELECT) return capi.SQLITE_OK;
      if (action === capi.SQLITE_READ) {
        const table = (arg1 ?? "").toLowerCase(), column = (arg2 ?? "").toLowerCase();
        const known = this.allowed[table];
        if (known && (column === "" || known.has(column))) {
          // A physical table is readable only from inside the identity's policy view. SQLite flattens a view
          // with no WHERE, and then reports a row-count read with no column and no view: harmless only where
          // this identity has no row filter on that table.
          if (schema === "temp" || (schema === "main" && via !== null)) return capi.SQLITE_OK;
          if (schema === "main" && column === "" && this.unfiltered.has(table)) return capi.SQLITE_OK;
          this.denied.push(`绕过策略视图读取 ${schema}.${table}`);
          return capi.SQLITE_DENY;
        }
        this.denied.push(`读取 ${table}.${column}`);
        return capi.SQLITE_DENY;
      }
      if (action === capi.SQLITE_FUNCTION) {
        if (functions.has((arg2 ?? "").toLowerCase())) return capi.SQLITE_OK;
        this.denied.push(`函数 ${arg2}`);
        return capi.SQLITE_DENY;
      }
      this.denied.push(`操作码 ${action}`);
      return capi.SQLITE_DENY;
    }, 0);
  }

  /** Create this identity's policy views. Values come from the identity, never from a question. */
  useIdentity(user: PackUser) {
    if (this.identity === user.username) return;
    const allowed = allowedColumns(user);
    this.strict = false;
    this.db.exec("PRAGMA query_only = 0");
    for (const table of Object.keys(PACK.tables)) {
      this.db.exec(`DROP VIEW IF EXISTS temp.${table}`);
      const pred = predicate(table, user);
      const where = pred ? ` WHERE ${pred.replace(/\bFROM (\w+)/g, "FROM main.$1")}` : "";
      this.db.exec(`CREATE TEMP VIEW ${table} AS SELECT ${allowed[table].join(", ")} FROM main.${table}${where}`);
    }
    this.db.exec("PRAGMA query_only = 1");
    this.allowed = Object.fromEntries(Object.entries(allowed).map(([t, cols]) => [t, new Set(cols)]));
    this.unfiltered = new Set(Object.keys(PACK.tables).filter((t) => predicate(t, user) === null));
    this.identity = user.username;
    this.strict = true;
  }

  /** The compile error for this SQL, if any. Nothing runs. */
  parseCheck(sql: string): string | null {
    try {
      this.db.prepare(sql).finalize();
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      this.denied = [];
    }
  }

  async execute(sql: string, user: PackUser): Promise<QueryResult> {
    this.useIdentity(user);
    const { capi } = this.sqlite3;
    const { max_rows, timeout_ms } = PACK.limits;
    this.denied = [];
    const started = performance.now();
    const deadline = started + timeout_ms;
    capi.sqlite3_progress_handler(this.db.pointer!, 2000, () => (performance.now() > deadline ? 1 : 0), 0);
    const rows: Cell[][] = [];
    let columns: string[] = [];
    let stmt: ReturnType<typeof this.db.prepare> | null = null;
    try {
      stmt = this.db.prepare(sql);
      if (!capi.sqlite3_stmt_readonly(stmt.pointer!)) throw new QueryError("执行层拒绝：不是只读语句", "denied");
      columns = stmt.getColumnNames();
      while (rows.length <= max_rows && stmt.step()) rows.push(stmt.get([]) as Cell[]);
    } catch (e) {
      if (e instanceof QueryError) throw e;
      const message = (e as Error).message;
      if (/interrupted/i.test(message)) throw new QueryError(`查询超过 ${timeout_ms} ms 被中止`, "timeout");
      if (this.denied.length || /not authorized|prohibited/i.test(message)) throw new QueryError(`执行层拒绝：${this.denied.join("；") || message}`, "denied");
      throw new QueryError(message.replace(/^SQLITE_\w+:\s*sqlite3 result code \d+:\s*/, ""), "execution");
    } finally {
      stmt?.finalize();
      capi.sqlite3_progress_handler(this.db.pointer!, 0, 0, 0);
    }
    const truncated = rows.length > max_rows;
    const kept = rows.slice(0, max_rows);
    return {
      columns, rows: kept, row_count: kept.length, truncated, elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      result_hash: await resultHash(columns, kept), executed_at: new Date().toISOString(),
    };
  }
}
