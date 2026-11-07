/* The backend's definitions, exported by scripts/build_browser_pack.py. The browser engine
 * ports logic only: metrics, dimensions, policies and planner regexes come from this file. */
import raw from "./pack.json";

export interface PackExpr { order: string | null; item: string | null }
export interface PackMetric {
  label: string; description: string; filter: string; format: string; type: string; unit: string;
  components: string[]; synonyms: string[]; grain: string; requires: string | null;
  expr: PackExpr; allowed_dimensions: string[];
}
export interface PackComponent { label: string; format: string; unit: string; expr: PackExpr }
export interface PackDimension {
  label: string; expr: string; table: string; synonyms: string[]; values: string[];
  value_synonyms: Record<string, string[]>; grain: string; is_time: boolean;
}
export interface PackUser {
  username: string; name: string; title: string; role: string; scope_type: "all" | "region" | "store";
  regions: string[]; stores: string[]; permissions: string[];
}
export interface PackColumn { label: string; sensitive: boolean; requires: string | null }
export interface Pack {
  calendar: { today: string; data_start: string; data_end: string; date_column: string; default_range_days: number; default_trend_months: number };
  tables: Record<string, { alias: string; label: string; columns: Record<string, PackColumn> }>;
  joins: { from: string; to: string; on: string }[];
  dimensions: Record<string, PackDimension>;
  metrics: Record<string, PackMetric>;
  components: Record<string, PackComponent>;
  ambiguous: Record<string, string[]>;
  users: PackUser[];
  row_policies: Record<string, Record<string, string>>;
  lookups: {
    region_codes: Record<string, string>; store_codes: Record<string, string>; store_region: Record<string, string>;
    store_city: Record<string, string>; city_regions: Record<string, string[]>;
  };
  patterns: Record<string, { source: string; flags: string }>;
  group_prefixes: string[];
  group_suffixes: string[];
  guard: { allowed_functions: string[]; dangerous_functions: string[]; authorizer_functions: string[]; system_prefixes: string[]; internal_tables: string[] };
  limits: { max_rows: number; timeout_ms: number; max_joins: number; max_sql_chars: number };
  refusal_text: Record<string, string>;
  products: string[];
  dataset: { name: string; fingerprint: string; total_rows: number };
}

export const PACK = raw as unknown as Pack;

export const regex = (name: string, global = false): RegExp => {
  const p = PACK.patterns[name];
  return new RegExp(p.source, p.flags + (global ? "g" : ""));
};

export const userOf = (username: string): PackUser => {
  const found = PACK.users.find((u) => u.username === username);
  if (!found) throw new Error(`unknown demo identity: ${username}`);
  return found;
};

export const has = (user: PackUser, permission: string): boolean => user.permissions.includes(permission);

export function labelOf(key: string): string {
  return PACK.metrics[key]?.label ?? PACK.components[key]?.label ?? PACK.dimensions[key]?.label ?? (key === "period" ? "统计周期" : key);
}
export const formatOf = (key: string): string => PACK.metrics[key]?.format ?? PACK.components[key]?.format ?? "text";
export const unitOf = (key: string): string => PACK.metrics[key]?.unit ?? PACK.components[key]?.unit ?? "";

/** Columns a user may read: everything except sensitive columns and those whose permission is missing. */
export function allowedColumns(user: PackUser): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, table] of Object.entries(PACK.tables)) {
    out[name] = Object.entries(table.columns)
      .filter(([, c]) => !c.sensitive && (c.requires === null || has(user, c.requires)))
      .map(([c]) => c)
      .sort();
  }
  return out;
}

/** column name -> reason, for the guard's error message. */
export function blockedColumns(user: PackUser): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of Object.values(PACK.tables)) {
    for (const [name, c] of Object.entries(table.columns)) {
      if (c.sensitive) out[name] = `${table.label}.${c.label} 是敏感字段，不允许查询`;
      else if (c.requires && !has(user, c.requires)) out[name] = `${table.label}.${c.label} 需要“${c.requires}”数据权限`;
    }
  }
  return out;
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Row filter for a table, or null when this identity sees every row. Values come from the identity, never the question. */
export function predicate(table: string, user: PackUser): string | null {
  if (user.scope_type === "all") return null;
  const template = PACK.row_policies[user.scope_type]?.[table];
  if (template === undefined) return null; // e.g. products: a shared catalogue
  return template
    .replace("{regions}", user.regions.map(lit).join(", ") || "NULL")
    .replace("{stores}", user.stores.map(lit).join(", ") || "NULL");
}

export function scopeLabel(user: PackUser): string {
  const { region_codes, store_codes } = PACK.lookups;
  const regionNames = Object.fromEntries(Object.entries(region_codes).map(([k, v]) => [v, k]));
  const storeNames = Object.fromEntries(Object.entries(store_codes).map(([k, v]) => [v, k]));
  if (user.scope_type === "all") return "全部区域";
  if (user.scope_type === "region") return user.regions.map((r) => regionNames[r] ?? r).join("、");
  return user.stores.map((s) => storeNames[s] ?? s).join("、");
}
