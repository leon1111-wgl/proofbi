/* Port of backend/app/semantic/compiler.py: a plan becomes one or more SQL queries. */
import { PACK, formatOf, labelOf, unitOf } from "./pack";
import type { Plan } from "./planner";
import { periodKey, type TimeRange } from "./timeparse";

export interface ColumnSpec { key: string; label: string; role: "dimension" | "metric" | "component"; format: string; unit: string; time?: boolean }
export interface QuerySpec {
  key: string; metrics: string[]; dimensions: string[]; filters: Record<string, string[]>; time: TimeRange;
  compare_time: TimeRange | null; order: string | null; order_by: string | null; limit: number | null;
  item_grain: boolean; repurchase: boolean; columns: ColumnSpec[];
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const inList = (expr: string, values: string[]) => (values.length === 1 ? `${expr} = ${lit(values[0])}` : `${expr} IN (${values.map(lit).join(", ")})`);
const between = (col: string, tr: { start: string; end: string }) => `${col} BETWEEN ${lit(tr.start)} AND ${lit(tr.end)}`;

const aliasToTable = Object.fromEntries(Object.entries(PACK.tables).map(([name, t]) => [t.alias, name]));
function tablesIn(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.replace(/'[^']*'/g, "''").matchAll(/\b([a-z]+)\.[a-z_]+/g)) if (aliasToTable[m[1]]) out.add(aliasToTable[m[1]]);
  return out;
}
export const specTitle = (spec: QuerySpec) => spec.columns.filter((c) => c.role === "metric").map((c) => c.label).join("、");

export function splitPlan(plan: Plan): QuerySpec[] {
  const groups: [string, string[]][] = [];
  for (const key of plan.metrics) {
    const metric = PACK.metrics[key];
    if (metric.type === "repurchase") {
      groups.push([`repurchase:${key}`, [key]]);
      continue;
    }
    const group = groups.find(([g]) => g === metric.filter);
    if (group) group[1].push(key);
    else groups.push([metric.filter, [key]]);
  }
  let dims = [...plan.dimensions];
  if (plan.compare) dims = ["period", ...dims];
  const itemDims = [...plan.dimensions, ...Object.keys(plan.filters)].some((d) => PACK.dimensions[d].grain === "item");
  return groups.map(([gkey, members], i) => {
    const repurchase = gkey.startsWith("repurchase:");
    const itemGrain = !repurchase && (itemDims || members.some((m) => PACK.metrics[m].grain === "item"));
    const orderBy = plan.order_by !== null && members.includes(plan.order_by) ? plan.order_by : plan.order ? members[0] : null;
    const spec: QuerySpec = {
      key: `q${i + 1}`, metrics: members, dimensions: dims, filters: { ...plan.filters }, time: plan.time,
      compare_time: plan.compare_time, order: plan.order, order_by: orderBy, limit: plan.limit,
      item_grain: itemGrain, repurchase, columns: [],
    };
    spec.columns = columnsFor(spec);
    return spec;
  });
}

function columnsFor(spec: QuerySpec): ColumnSpec[] {
  const cols: ColumnSpec[] = spec.dimensions.map((d) => ({
    key: d, label: labelOf(d), role: "dimension", format: "text", unit: "", time: d === "period" || PACK.dimensions[d].is_time,
  }));
  const seen = new Set(cols.map((c) => c.key));
  for (const m of spec.metrics) {
    for (const comp of PACK.metrics[m].components) {
      if (!seen.has(comp) && !spec.metrics.includes(comp)) {
        cols.push({ key: comp, label: labelOf(comp), role: "component", format: formatOf(comp), unit: unitOf(comp) });
        seen.add(comp);
      }
    }
    if (!seen.has(m)) {
      cols.push({ key: m, label: labelOf(m), role: "metric", format: formatOf(m), unit: unitOf(m) });
      seen.add(m);
    }
  }
  return cols;
}

function dimensionExpr(key: string, spec: QuerySpec): string {
  if (key === "period") {
    const col = PACK.calendar.date_column;
    return `CASE WHEN ${between(col, spec.time)} THEN ${lit(periodKey(spec.time))} ELSE ${lit(periodKey(spec.compare_time!))} END`;
  }
  return PACK.dimensions[key].expr;
}

function joinPath(base: string, target: string) {
  if (base === target) return [];
  const queue: [string, typeof PACK.joins][] = [[base, []]];
  const seen = new Set([base]);
  while (queue.length) {
    const [table, path] = queue.shift()!;
    for (const j of PACK.joins) {
      if (j.from === table && !seen.has(j.to)) {
        if (j.to === target) return [...path, j];
        seen.add(j.to);
        queue.push([j.to, [...path, j]]);
      }
    }
  }
  return null;
}

function fromAndJoins(base: string, needed: Set<string>): string[] {
  const edges: typeof PACK.joins = [];
  for (const table of [...needed].filter((t) => t !== base).sort()) {
    const path = joinPath(base, table);
    if (path === null) throw new Error(`无法从 ${base} 关联到 ${table}（只允许多对一关联）`);
    for (const j of path) if (!edges.includes(j)) edges.push(j);
  }
  const joined = new Set([base]);
  const lines = [`FROM ${base} AS ${PACK.tables[base].alias}`];
  const pending = [...edges];
  while (pending.length) {
    const idx = pending.findIndex((j) => joined.has(j.from));
    if (idx === -1) throw new Error("关联路径无法排序");
    const j = pending[idx];
    lines.push(`JOIN ${j.to} AS ${PACK.tables[j.to].alias} ON ${j.on}`);
    joined.add(j.to);
    pending.splice(idx, 1);
  }
  return lines;
}

function whereParts(spec: QuerySpec, metricFilter: string): string[] {
  const col = PACK.calendar.date_column;
  const parts = [metricFilter];
  if (spec.compare_time !== null) parts.push(`(${between(col, spec.time)} OR ${between(col, spec.compare_time)})`);
  else parts.push(between(col, spec.time));
  for (const [key, values] of Object.entries(spec.filters)) parts.push(inList(PACK.dimensions[key].expr, values));
  return parts;
}

function orderClause(spec: QuerySpec, dims: string[]): string | null {
  const timeDims = dims.filter((d) => d === "period" || PACK.dimensions[d]?.is_time);
  if (spec.order && spec.order_by) return [`${spec.order_by} ${spec.order.toUpperCase()}`, ...dims].join(", ");
  if (timeDims.length) return dims.join(", ");
  if (dims.length) {
    const first = spec.columns.find((c) => c.role === "metric")!.key;
    return [`${first} DESC`, ...dims].join(", ");
  }
  return null;
}

function metricExpr(key: string, item: boolean): string | null {
  const e = PACK.metrics[key]?.expr ?? PACK.components[key]?.expr;
  if (!e) return null;
  return item ? e.item : e.order;
}

export function compileSpec(spec: QuerySpec, maxRows: number): string {
  if (spec.repurchase) return compileRepurchase(spec, maxRows);
  const base = spec.item_grain ? "order_items" : "orders";
  const metric = PACK.metrics[spec.metrics[0]];
  const dims = spec.dimensions;
  const select: string[] = [];
  const needed = new Set([base, "orders"]);
  const addAll = (s: Set<string>) => s.forEach((t) => needed.add(t));
  for (const d of dims) {
    const expr = dimensionExpr(d, spec);
    select.push(`${expr} AS ${d}`);
    addAll(tablesIn(expr));
  }
  for (const col of spec.columns) {
    if (col.role === "dimension") continue;
    const expr = metricExpr(col.key, spec.item_grain);
    if (expr === null) throw new Error(`${labelOf(col.key)} 不支持当前粒度`);
    select.push(`${expr} AS ${col.key}`);
    addAll(tablesIn(expr));
  }
  addAll(tablesIn(metric.filter));
  for (const key of Object.keys(spec.filters)) addAll(tablesIn(PACK.dimensions[key].expr));
  const lines = ["SELECT", "  " + select.join(",\n  "), ...fromAndJoins(base, needed)];
  lines.push("WHERE " + whereParts(spec, metric.filter).join("\n  AND "));
  if (dims.length) lines.push("GROUP BY " + dims.map((d) => dimensionExpr(d, spec)).join(", "));
  const order = orderClause(spec, dims);
  if (order) lines.push(`ORDER BY ${order}`);
  lines.push(`LIMIT ${Math.min(spec.limit || maxRows, maxRows)}`);
  return lines.join("\n");
}

function compileRepurchase(spec: QuerySpec, maxRows: number): string {
  const metric = PACK.metrics[spec.metrics[0]];
  const dims = spec.dimensions;
  const innerSelect = ["o.customer_id AS customer_id"];
  const needed = new Set(["orders"]);
  const addAll = (s: Set<string>) => s.forEach((t) => needed.add(t));
  for (const d of dims) {
    const expr = dimensionExpr(d, spec);
    innerSelect.push(`${expr} AS ${d}`);
    addAll(tablesIn(expr));
  }
  innerSelect.push("COUNT(DISTINCT o.order_id) AS orders_in_period");
  for (const key of Object.keys(spec.filters)) addAll(tablesIn(PACK.dimensions[key].expr));
  const inner = ["SELECT", "    " + innerSelect.join(",\n    ")];
  inner.push(...fromAndJoins("orders", needed).map((l) => "  " + l));
  inner.push("  WHERE " + whereParts(spec, metric.filter).join("\n    AND "));
  inner.push("  GROUP BY " + ["o.customer_id", ...dims.map((d) => dimensionExpr(d, spec))].join(", "));
  const repeat = "SUM(CASE WHEN t.orders_in_period >= 2 THEN 1 ELSE 0 END)";
  const outer = [...dims.map((d) => `t.${d} AS ${d}`), `${repeat} AS repeat_buyers`, "COUNT(*) AS buyer_count", `ROUND(${repeat} * 1.0 / NULLIF(COUNT(*), 0), 4) AS ${spec.metrics[0]}`];
  const lines = ["SELECT", "  " + outer.join(",\n  "), "FROM (", ...inner, ") AS t"];
  if (dims.length) lines.push("GROUP BY " + dims.map((d) => `t.${d}`).join(", "));
  const order = orderClause(spec, dims);
  if (order) lines.push(`ORDER BY ${order}`);
  lines.push(`LIMIT ${Math.min(spec.limit || maxRows, maxRows)}`);
  return lines.join("\n");
}
