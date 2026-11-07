/* The browser's first line of defence, the counterpart of backend/app/sqlsafe/guard.py.
 *
 * The server parses with sqlglot, which is Python. Here a tokenizer that follows SQLite's own
 * lexical rules drives the same rules, and SQLite's prepare step is the parser of last resort: what
 * cannot be read structurally is rejected, and the authorizer in warehouse.ts decides on what SQLite
 * says the statement really reads. tests/guard.test.ts runs the backend's attack list through this
 * file and requires the same verdict and the same security class. */
import { PACK, allowedColumns, blockedColumns, predicate, type PackUser } from "./pack";

export interface Violation { code: string; message: string; security: boolean }
export interface GuardResult {
  ok: boolean; sql: string | null; violations: Violation[]; tables: string[]; notes: string[];
  security: boolean; error: string; tableRefs: TableRef[];
}
/** A physical table reference, by character offsets into the checked SQL. */
export interface TableRef { name: string; start: number; end: number; alias: string }

type Kind = "word" | "quoted" | "string" | "number" | "op" | "param";
interface Token { kind: Kind; text: string; upper: string; start: number; end: number }

const STATEMENT_VERBS = new Set(["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REPLACE", "REINDEX", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "EXPLAIN", "TRUNCATE"]);
const WRITE_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "TRUNCATE"]);
const NOT_FUNCTIONS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "ON", "USING", "AS", "JOIN", "OVER", "FILTER", "VALUES", "BY", "HAVING",
  "WHEN", "THEN", "ELSE", "CASE", "UNION", "ALL", "INTERSECT", "EXCEPT", "WITH", "LIKE", "GLOB", "BETWEEN", "IS", "PARTITION",
  "DISTINCT", "ORDER", "GROUP", "LIMIT", "OFFSET", "END", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "NATURAL", "FULL",
]);
const CLAUSE_END = new Set(["WHERE", "GROUP", "ORDER", "LIMIT", "HAVING", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "OFFSET"]);
const JOIN_WORDS = new Set(["JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "NATURAL", "FULL"]);
const NOT_ALIAS = new Set([...CLAUSE_END, ...JOIN_WORDS, "ON", "USING", "AS", "INDEXED", "NOT", "SELECT", "FROM", "AND", "OR"]);

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

class LexError extends Error {}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: Kind, start: number, end: number, text?: string) => {
    const t = text ?? sql.slice(start, end);
    out.push({ kind, text: t, upper: t.toUpperCase(), start, end });
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    // SQLite stops reading at NUL, so anything after it would run unseen by this scanner
    if (c < " ") throw new LexError("SQL 中有控制字符");
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const start = i++;
      let text = "";
      for (;;) {
        if (i >= sql.length) throw new LexError("引号没有闭合");
        if (sql[i] === c) {
          if (sql[i + 1] === c) { text += c; i += 2; continue; }
          i++;
          break;
        }
        text += sql[i++];
      }
      push(c === "'" ? "string" : "quoted", start, i, text);
      continue;
    }
    if (c === "[") {
      const end = sql.indexOf("]", i);
      if (end === -1) throw new LexError("方括号没有闭合");
      push("quoted", i, end + 1, sql.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      const end = sql.indexOf("'", i + 2);
      if (end === -1) throw new LexError("引号没有闭合");
      push("string", i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const start = i;
      while (i < sql.length && /[0-9A-Za-z_.]/.test(sql[i])) {
        if (/[eE]/.test(sql[i]) && /[+-]/.test(sql[i + 1] ?? "")) i++;
        i++;
      }
      push("number", start, i);
      continue;
    }
    if (isWordStart(c)) {
      const start = i;
      while (i < sql.length && isWordChar(sql[i])) i++;
      push("word", start, i);
      continue;
    }
    if (c === "?" || c === ":" || c === "@" || c === "$" || c === "#") {
      const start = i++;
      while (i < sql.length && isWordChar(sql[i])) i++;
      push("param", start, i);
      continue;
    }
    const two = sql.slice(i, i + 3) === "->>" ? "->>" : sql.slice(i, i + 2);
    if (["->>", "||", "<=", ">=", "<>", "!=", "==", "->", "<<", ">>"].includes(two)) {
      push("op", i, i + two.length);
      i += two.length;
      continue;
    }
    if ("()+-*/%=<>,;.&|~!".includes(c)) { push("op", i, i + 1); i++; continue; }
    throw new LexError(`无法识别的字符 ${c}`);
  }
  return out;
}

export function checkSql(sql: string, user: PackUser, parseCheck?: (sql: string) => string | null): GuardResult {
  const blocked = blockedColumns(user);
  const { max_rows, max_joins, max_sql_chars } = PACK.limits;
  const { system_prefixes, internal_tables, allowed_functions, dangerous_functions } = PACK.guard;
  const physical = new Set(Object.keys(PACK.tables));
  const fail = (...vs: Violation[]): GuardResult => ({
    ok: false, sql: null, violations: vs, tables: [], notes: [], security: vs.some((v) => v.security), error: vs.map((v) => v.message).join("；"), tableRefs: [],
  });
  if (!sql || !sql.trim()) return fail({ code: "empty", message: "没有生成 SQL", security: false });
  if (sql.length > max_sql_chars) return fail({ code: "too_long", message: `SQL 超过 ${max_sql_chars} 个字符`, security: false });

  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (e) {
    return fail({ code: "parse_error", message: `SQL 语法错误：${(e as Error).message}`, security: false });
  }
  const statements = tokens.reduce((n, t, i) => n + (t.text === ";" && t.kind === "op" && tokens.slice(i + 1).length > 0 ? 1 : 0), 1);
  if (statements !== 1) return fail({ code: "multiple_statements", message: `只允许一条语句，检测到 ${statements} 条`, security: true });
  const body = tokens.filter((t) => !(t.kind === "op" && t.text === ";"));
  if (!body.length) return fail({ code: "empty", message: "没有生成 SQL", security: false });
  const first = body[0];
  if (!(first.kind === "word" && (first.upper === "SELECT" || first.upper === "WITH"))) {
    if (first.kind === "word" && STATEMENT_VERBS.has(first.upper)) return fail({ code: "not_select", message: `只允许 SELECT 查询，检测到 ${first.upper}`, security: true });
    return fail({ code: "parse_error", message: `SQL 语法错误：不能以 ${first.text} 开头`, security: false });
  }

  const violations: Violation[] = [];
  const notes: string[] = [];
  const add = (code: string, message: string, security: boolean) => {
    if (!violations.some((v) => v.code === code && v.message === message)) violations.push({ code, message, security });
  };
  const word = (t: Token | undefined, w: string) => t?.kind === "word" && t.upper === w;
  const op = (t: Token | undefined, w: string) => t?.kind === "op" && t.text === w;
  const isName = (t: Token | undefined) => t?.kind === "quoted" || t?.kind === "word";
  /** index just past the parenthesis group opening at i */
  const skipParen = (i: number) => {
    let depth = 0;
    for (let k = i; k < body.length; k++) {
      if (op(body[k], "(")) depth++;
      else if (op(body[k], ")") && --depth === 0) return k + 1;
    }
    return body.length;
  };

  // CTE names first: a table reference may appear before the WITH it belongs to in the scan order
  const cteNames = new Set<string>();
  body.forEach((t, i) => {
    if (!word(t, "WITH")) return;
    let k = i + 1;
    if (word(body[k], "RECURSIVE")) { add("recursive_cte", "不允许递归 CTE（WITH RECURSIVE）", true); k++; }
    for (;;) {
      const name = body[k];
      if (!isName(name)) break;
      cteNames.add(name.text.toLowerCase());
      k++;
      if (op(body[k], "(")) k = skipParen(k);
      if (!word(body[k], "AS")) break;
      k++;
      if (word(body[k], "NOT")) k++;
      if (word(body[k], "MATERIALIZED")) k++;
      if (!op(body[k], "(")) break;
      const bodyEnd = skipParen(k);
      // SQLite treats a CTE that reads itself as recursive even without the keyword
      if (body.slice(k, bodyEnd).some((b) => (b.kind === "word" || b.kind === "quoted") && b.text.toLowerCase() === name.text.toLowerCase())) {
        add("recursive_cte", "不允许递归 CTE（CTE 引用了它自己）", true);
      }
      k = bodyEnd;
      if (!op(body[k], ",")) break;
      k++;
    }
  });
  for (const name of cteNames) {
    if (physical.has(name) || system_prefixes.some((p) => name.startsWith(p)) || internal_tables.includes(name)) {
      add("cte_shadows_table", `CTE 名称 ${name} 与数据表重名`, true);
    }
  }

  const tables = new Set<string>();
  const tableRefs: TableRef[] = [];
  /** A table-or-subquery at i. Returns the index after its alias. */
  const readSource = (i: number): number => {
    const t = body[i];
    if (op(t, "(")) {
      const inner = body[i + 1];
      if (!(word(inner, "SELECT") || word(inner, "WITH") || word(inner, "VALUES"))) {
        add("unsupported_from", "FROM 或 JOIN 里的括号只能放子查询，表名不要放在括号里", false);
      }
      i = skipParen(i);
      if (word(body[i], "AS")) i++;
      if (isName(body[i]) && !NOT_ALIAS.has(body[i].upper)) i++;
      return i;
    }
    if (!isName(t)) {
      add("parse_error", "SQL 语法错误：FROM 或 JOIN 后面缺少表名", false);
      return i + 1;
    }
    const name = t.text.toLowerCase();
    if (op(body[i + 1], ".")) {
      const second = body[i + 2];
      const qualified = `${t.text}.${second?.text ?? ""}`;
      const security = system_prefixes.some((p) => name.startsWith(p) || (second?.text ?? "").toLowerCase().startsWith(p));
      add("schema_qualified", `不要使用库名前缀：${qualified}`, security);
      return i + 3;
    }
    if (op(body[i + 1], "(")) {
      add("table_function", `不允许表函数 ${t.text}()`, true);
      return skipParen(i + 1);
    }
    let k = i + 1;
    let alias = t.text;
    if (word(body[k], "AS")) {
      k++;
      if (isName(body[k])) { alias = body[k].text; k++; }
    } else if (isName(body[k]) && !NOT_ALIAS.has(body[k].upper)) {
      alias = body[k].text;
      k++;
    }
    if (word(body[k], "INDEXED") || word(body[k], "NOT")) add("unsupported_from", "不支持 INDEXED BY", false);
    if (cteNames.has(name)) return k;
    if (system_prefixes.some((p) => name.startsWith(p)) || internal_tables.includes(name)) add("system_table", `不允许访问系统表 ${name}`, true);
    else if (!physical.has(name)) add("unknown_table", `表 ${name} 不存在或不在白名单中，可用表：${[...physical].sort().join(", ")}`, false);
    else {
      tables.add(name);
      tableRefs.push({ name, start: t.start, end: body[k - 1].end, alias });
    }
    return k;
  };
  const columnEquality = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (!(op(body[k], "=") || op(body[k], "=="))) continue;
      const left = body[k - 1], right = body[k + 1];
      const isCol = (t: Token | undefined) => t?.kind === "quoted" || (t?.kind === "word" && !NOT_FUNCTIONS.has(t.upper) && t.upper !== "NULL" && t.upper !== "TRUE" && t.upper !== "FALSE");
      if (isCol(left) && isCol(right)) return true;
    }
    return false;
  };

  let joins = 0;
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.kind === "word") {
      if (WRITE_WORDS.has(t.upper) && !op(body[i + 1], "(")) add("forbidden_statement", `不允许 ${t.upper}`, true);
      if (t.upper === "INTO") add("forbidden_statement", "不允许 SELECT ... INTO", true);
      if (t.upper === "FROM") {
        const before = body[i - 1], before2 = body[i - 2];
        if (word(before, "DISTINCT") && (word(before2, "IS") || word(before2, "NOT"))) continue;
        let k = readSource(i + 1);
        while (op(body[k], ",")) {
          add("cartesian_join", "不允许 CROSS JOIN、逗号连接或 NATURAL JOIN，请写明关联条件", false);
          k = readSource(k + 1);
        }
        continue;
      }
      if (t.upper === "JOIN") {
        joins++;
        const before = body[i - 1], before2 = body[i - 2];
        const cartesian = word(before, "CROSS") || word(before, "NATURAL") || word(before2, "NATURAL");
        if (cartesian) add("cartesian_join", "不允许 CROSS JOIN、逗号连接或 NATURAL JOIN，请写明关联条件", false);
        let k = readSource(i + 1);
        if (word(body[k], "USING")) continue;
        if (!word(body[k], "ON")) {
          if (!cartesian) add("cartesian_join", "JOIN 缺少“字段 = 字段”的关联条件", false);
          continue;
        }
        const onStart = ++k;
        let depth = 0;
        for (; k < body.length; k++) {
          if (op(body[k], "(")) depth++;
          else if (op(body[k], ")")) { if (depth === 0) break; depth--; }
          else if (depth === 0 && (op(body[k], ",") || (body[k].kind === "word" && (CLAUSE_END.has(body[k].upper) || JOIN_WORDS.has(body[k].upper))))) break;
        }
        if (!columnEquality(onStart, k)) add("cartesian_join", "JOIN 缺少“字段 = 字段”的关联条件", false);
        if (op(body[k], ",")) add("cartesian_join", "不允许 CROSS JOIN、逗号连接或 NATURAL JOIN，请写明关联条件", false);
        continue;
      }
      if (t.upper === "IN" && isName(body[i + 1]) && !op(body[i + 1], "(")) add("unsupported_from", "IN 后面请写取值列表或子查询，不要直接写表名", false);
    }
    // a function call: a name followed by "(". SQLite also accepts a quoted name here.
    if ((t.kind === "word" || t.kind === "quoted") && op(body[i + 1], "(") && !(t.kind === "word" && NOT_FUNCTIONS.has(t.upper))) {
      const name = t.text.toLowerCase();
      const fromContext = word(body[i - 1], "FROM") || word(body[i - 1], "JOIN");
      const cteHeader = cteNames.has(name) && (word(body[i - 1], "WITH") || word(body[i - 1], "RECURSIVE") || op(body[i - 1], ",")) && word(body[skipParen(i + 1)], "AS");
      if (!fromContext && !cteHeader && !allowed_functions.includes(name)) {
        add("function_not_allowed", `函数 ${name}() 不在白名单中`, dangerous_functions.includes(name));
      }
    }
    if (t.kind === "word" || t.kind === "quoted") {
      const reason = blocked[t.text.toLowerCase()];
      if (reason) add("blocked_column", reason, true);
    }
    if (op(t, "*")) {
      const prev = body[i - 1];
      if (op(prev, ".")) add("select_star", "请显式列出字段，不要使用 t.*", false);
      else if (word(prev, "SELECT") || word(prev, "DISTINCT") || word(prev, "ALL") || (op(prev, ",") && !op(body[i + 1], ")"))) {
        add("select_star", "请显式列出字段，不要使用 SELECT *", false);
      }
    }
    if (t.kind === "param") add("parse_error", "SQL 语法错误：不接受参数占位符", false);
  }
  if (joins > max_joins) add("too_many_joins", `JOIN 数量 ${joins} 超过上限 ${max_joins}`, false);

  // LIMIT at the top level of the statement
  let depth = 0;
  let limitAt = -1;
  for (let i = 0; i < body.length; i++) {
    if (op(body[i], "(")) depth++;
    else if (op(body[i], ")")) depth--;
    else if (depth === 0 && word(body[i], "LIMIT")) limitAt = i;
  }
  let output = stripComments(sql, tokens);
  const offsetMap = commentOffsets(sql, tokens);
  let limitPatch: { start: number; end: number; text: string } | null = null;
  if (limitAt >= 0) {
    const value = body[limitAt + 1];
    const after = body[limitAt + 2];
    const isInt = value?.kind === "number" && /^\d+$/.test(value.text);
    if (!isInt) add("limit_not_literal", "LIMIT 必须是整数常量", false);
    else if (op(after, ",")) add("limit_not_literal", "LIMIT 请写成 LIMIT n OFFSET m", false);
    else {
      if (word(after, "OFFSET") && !(body[limitAt + 3]?.kind === "number" && /^\d+$/.test(body[limitAt + 3].text))) add("limit_not_literal", "OFFSET 必须是整数常量", false);
      if (Number(value.text) > max_rows) {
        notes.push(`LIMIT ${value.text} 超过上限，已收紧为 ${max_rows}`);
        limitPatch = { start: offsetMap(value.start), end: offsetMap(value.end), text: String(max_rows) };
      }
    }
  } else {
    notes.push(`未写 LIMIT，已自动加上 LIMIT ${max_rows}`);
  }

  if (violations.length) {
    const hasSecurity = violations.some((v) => v.security);
    return { ok: false, sql: null, violations, tables: [...tables].sort(), notes, security: hasSecurity, error: violations.map((v) => v.message).join("；"), tableRefs: [] };
  }

  const refs = tableRefs.map((r) => ({ ...r, start: offsetMap(r.start), end: offsetMap(r.end) }));
  if (limitPatch) {
    const delta = limitPatch.text.length - (limitPatch.end - limitPatch.start);
    output = output.slice(0, limitPatch.start) + limitPatch.text + output.slice(limitPatch.end);
    for (const r of refs) if (r.start > limitPatch.start) { r.start += delta; r.end += delta; }
  }
  output = output.replace(/[\s;]+$/, "");
  if (limitAt < 0) output += `\nLIMIT ${max_rows}`;

  if (parseCheck) {
    const problem = parseCheck(output);
    if (problem && /syntax error|incomplete input|near "|unrecognized token/i.test(problem)) {
      return fail({ code: "parse_error", message: `SQL 语法错误：${problem.replace(/^SQLITE_\w+:\s*sqlite3 result code \d+:\s*/, "")}`, security: false });
    }
  }
  return { ok: true, sql: output, violations: [], tables: [...tables].sort(), notes, security: false, error: "", tableRefs: refs };
}

/** The statement without comments: what runs is never the raw text. */
function stripComments(sql: string, tokens: Token[]): string {
  let out = "";
  let cursor = 0;
  for (const t of tokens) {
    const gap = sql.slice(cursor, t.start);
    out += gap.trim() === "" ? gap : gap.replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, " ");
    out += sql.slice(t.start, t.end);
    cursor = t.end;
  }
  return out;
}

/** Maps an offset in the raw SQL to the matching offset after stripComments. */
function commentOffsets(sql: string, tokens: Token[]): (offset: number) => number {
  const starts = new Map<number, number>();
  let out = 0;
  let cursor = 0;
  for (const t of tokens) {
    const gap = sql.slice(cursor, t.start);
    out += (gap.trim() === "" ? gap : gap.replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, " ")).length;
    starts.set(t.start, out);
    out += t.end - t.start;
    starts.set(t.end, out);
    cursor = t.end;
  }
  return (offset) => starts.get(offset) ?? offset;
}

/** Second line: every physical table reference becomes a policy view, as the server's rewrite does. */
export function applyRowPolicies(checked: GuardResult, user: PackUser): { sql: string; policies: Record<string, string | null> } {
  const allowed = allowedColumns(user);
  const policies: Record<string, string | null> = {};
  let sql = checked.sql!;
  for (const ref of [...checked.tableRefs].sort((a, b) => b.start - a.start)) {
    const pred = predicate(ref.name, user);
    // on its own lines, so the row condition is visible without scrolling past the column list
    const view = `(\n    SELECT ${allowed[ref.name].join(", ")}\n    FROM ${ref.name}${pred ? `\n    WHERE ${pred}` : ""}\n  ) AS ${ref.alias}`;
    sql = sql.slice(0, ref.start) + view + sql.slice(ref.end);
    policies[ref.name] = pred;
  }
  return { sql, policies };
}
