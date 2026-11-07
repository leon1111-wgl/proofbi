/* Port of backend/app/agent/narrator.py: fixed sentence patterns that quote result cells, and chart specs. */
import { PACK } from "./pack";
import type { ColumnSpec, QuerySpec } from "./compiler";
import { columnUsesWan, fixed, formatValue } from "./numbers";
import type { Plan } from "./planner";
import { periodKey } from "./timeparse";
import type { Cell } from "./verifier";

const FILTER_TEMPLATES: Record<string, string> = { region: "{}区", channel: "{}渠道", category: "{}品类", age_band: "{}用户" };

export interface ColumnMeta extends ColumnSpec { wan?: boolean }
export interface QueryOutput { spec: QuerySpec; query_id: string; columns: string[]; rows: Cell[][]; meta: ColumnMeta[] }

export function alignColumns(spec: QuerySpec, columns: string[]): ColumnMeta[] {
  const byKey = Object.fromEntries(spec.columns.map((c) => [c.key, c]));
  return columns.map((name) => ({ ...byKey[name.toLowerCase()], key: name }));
}

function scopeText(filters: Record<string, string[]>): string {
  const parts = Object.entries(filters).map(([key, values]) => (FILTER_TEMPLATES[key] ?? "{}").replace("{}", values.join("、")));
  return parts.length ? parts.join("、") + "的" : "";
}

export function chartFor(out: QueryOutput): Record<string, unknown> {
  const meta = out.meta;
  const dims = meta.filter((m) => m.role === "dimension");
  const metricsOnly = meta.filter((m) => m.role === "metric");
  const metrics = metricsOnly.length ? metricsOnly : meta.filter((m) => m.role === "component");
  const base = { query_id: out.query_id };
  if (!out.rows.length || !metrics.length) return { ...base, type: "table" };
  if (!dims.length) return { ...base, type: "kpi", items: meta.filter((m) => m.role === "metric" || m.role === "component").map((m) => m.key) };
  const y = metrics[0].key;
  if (dims.length === 1) {
    const d = dims[0];
    if (d.key === "period") return { ...base, type: "compare", x: "period", y };
    if (d.time) return { ...base, type: "line", x: d.key, y };
    return { ...base, type: "bar", x: d.key, y };
  }
  if (dims.length === 2) {
    const timeDims = dims.filter((d) => d.time || d.key === "period");
    const other = dims.filter((d) => !timeDims.includes(d));
    const idx = other.length ? meta.findIndex((m) => m.key === other[0].key) : -1;
    const seriesValues = other.length ? new Set(out.rows.map((r) => r[idx])) : new Set();
    if (timeDims.length && other.length && seriesValues.size <= 8) {
      const kind = timeDims[0].key === "period" ? "bar" : "line";
      const [x, series] = kind === "bar" ? [other[0].key, "period"] : [timeDims[0].key, other[0].key];
      return { ...base, type: kind, x, y, series };
    }
  }
  return { ...base, type: "table" };
}

const maxBy = <T,>(items: T[], f: (x: T) => number) => items.reduce((best, x) => (f(x) > f(best) ? x : best));
const minBy = <T,>(items: T[], f: (x: T) => number) => items.reduce((best, x) => (f(x) < f(best) ? x : best));

export function narrate(plan: Plan, outputs: QueryOutput[]): string {
  return outputs.flatMap((out, i) => forQuery(plan, out, i === 0)).join("");
}

const fmt = (m: ColumnMeta, value: Cell) => formatValue(value, m.format, m.unit ?? "", m.wan);

function forQuery(plan: Plan, out: QueryOutput, withPeriod: boolean): string[] {
  const rows = out.rows;
  const keys = out.meta.map((m) => m.key);
  const meta: ColumnMeta[] = out.meta.map((m, i) => ({ ...m, wan: columnUsesWan(rows.map((r) => r[i])) }));
  const dims = meta.filter((m) => m.role === "dimension");
  const metrics = meta.filter((m) => m.role === "metric");
  if (!metrics.length) return ["结果见下方表格。"];
  const scope = scopeText(Object.fromEntries(Object.entries(out.spec.filters).filter(([k]) => !out.spec.dimensions.includes(k))));
  const period = withPeriod ? plan.time.label : "同期";
  if (!rows.length) return [`${period}，${scope}没有符合条件的数据。`];
  const val = (row: Cell[], m: ColumnMeta) => row[keys.indexOf(m.key)];
  const num = (row: Cell[], m: ColumnMeta) => Number(val(row, m) ?? 0) || 0;

  if (!dims.length) {
    const row = rows[0];
    const parts = metrics.map((m) => {
      const comps = meta.filter((c) => c.role === "component" && (PACK.metrics[m.key]?.components ?? []).includes(c.key));
      const detail = comps.map((c) => `${c.label} ${fmt(c, val(row, c))}`).join("，");
      return `${m.label}为 ${fmt(m, val(row, m))}` + (detail ? `（${detail}）` : "");
    });
    return [`${period}，${scope}` + parts.join("，") + "。"];
  }
  const primary = metrics[0];
  if (dims.length === 1 && dims[0].key === "period") return [compareSentence(plan, scope, primary, meta, rows)];
  if (dims.length === 1) {
    const d = dims[0];
    const label = (row: Cell[]) => String(row[keys.indexOf(d.key)]);
    if (d.time) {
      const first = rows[0], last = rows[rows.length - 1];
      const hi = maxBy(rows, (r) => num(r, primary)), lo = minBy(rows, (r) => num(r, primary));
      return [`${scope}${primary.label}从 ${label(first)} 的 ${fmt(primary, val(first, primary))} 变为 ${label(last)} 的 ${fmt(primary, val(last, primary))}；期间最高为 ${label(hi)}（${fmt(primary, val(hi, primary))}），最低为 ${label(lo)}（${fmt(primary, val(lo, primary))}）。`];
    }
    if (plan.limit === 1) {
      const word = plan.order === "asc" ? "最低" : "最高";
      return [`${period}，${scope}${primary.label}${word}的${d.label}是${label(rows[0])}，为 ${fmt(primary, val(rows[0], primary))}。`];
    }
    if (rows.length === 1) return [`${period}，${scope}${d.label}“${label(rows[0])}”的${primary.label}为 ${fmt(primary, val(rows[0], primary))}。`];
    if (plan.limit) {
      const word = plan.order === "asc" ? "最低" : "排名";
      const items = rows.map((r) => `${label(r)}（${fmt(primary, val(r, primary))}）`).join("、");
      return [`${period}，${scope}${primary.label}${word}前 ${rows.length} 的${d.label}依次是：${items}。`];
    }
    const ordered = [...rows].sort((a, b) => num(b, primary) - num(a, primary));
    const top = ordered[0], bottom = ordered[ordered.length - 1];
    return [`${period}，${scope}${primary.label}最高的${d.label}是${label(top)}（${fmt(primary, val(top, primary))}），最低的是${label(bottom)}（${fmt(primary, val(bottom, primary))}）。`];
  }
  if (dims.some((d) => d.key === "period") && dims.length === 2) return [compareByGroup(plan, scope, primary, meta, rows)];
  const best = maxBy(rows, (r) => num(r, primary));
  const combo = dims.map((d) => String(best[keys.indexOf(d.key)])).join(" · ");
  const names = dims.map((d) => d.label).join("和");
  return [`${period}，${scope}按${names}拆分的结果见下表；${primary.label}最高的组合是 ${combo}（${fmt(primary, val(best, primary))}）。`];
}

function changeText(primary: ColumnMeta, current: Cell, previous: Cell): string {
  if (current === null || previous === null || previous === 0) return "无法计算变化";
  if (primary.format === "percent") {
    const diff = (Number(current) - Number(previous)) * 100;
    if (Number(fixed(diff, 1)) === 0) return "持平";
    return `${diff > 0 ? "上升" : "下降"} ${fixed(Math.abs(diff), 1)} 个百分点`;
  }
  const change = ((Number(current) - Number(previous)) / Number(previous)) * 100;
  if (Number(fixed(change, 1)) === 0) return "持平";
  return `${change > 0 ? "上升" : "下降"} ${fixed(Math.abs(change), 1)}%`;
}

function compareSentence(plan: Plan, scope: string, primary: ColumnMeta, meta: ColumnMeta[], rows: Cell[][]): string {
  const keys = meta.map((m) => m.key);
  const byPeriod = new Map(rows.map((row) => [row[keys.indexOf("period")], row]));
  const curKey = periodKey(plan.time);
  const prevKey = plan.compare_time ? periodKey(plan.compare_time) : null;
  const cur = byPeriod.get(curKey), prev = prevKey === null ? undefined : byPeriod.get(prevKey);
  const word = plan.compare === "yoy" ? "同比" : "环比";
  if (!cur || !prev) return `${scope}${primary.label}缺少对比期数据，无法计算${word}。`;
  const vCur = cur[keys.indexOf(primary.key)], vPrev = prev[keys.indexOf(primary.key)];
  return `${scope}${primary.label}：${curKey} 为 ${fmt(primary, vCur)}，${prevKey} 为 ${fmt(primary, vPrev)}，${word}${changeText(primary, vCur, vPrev)}。`;
}

function compareByGroup(plan: Plan, scope: string, primary: ColumnMeta, meta: ColumnMeta[], rows: Cell[][]): string {
  const keys = meta.map((m) => m.key);
  const group = meta.find((m) => m.role === "dimension" && m.key !== "period")!;
  const curKey = periodKey(plan.time);
  const prevKey = plan.compare_time ? periodKey(plan.compare_time) : null;
  const pairs = new Map<Cell, Map<Cell, Cell>>();
  for (const row of rows) {
    const g = row[keys.indexOf(group.key)];
    if (!pairs.has(g)) pairs.set(g, new Map());
    pairs.get(g)!.set(row[keys.indexOf("period")], row[keys.indexOf(primary.key)]);
  }
  const word = plan.compare === "yoy" ? "同比" : "环比";
  const movers: [Cell, number, number][] = [];
  for (const [g, v] of pairs) {
    const c = v.get(curKey), p = prevKey === null ? undefined : v.get(prevKey);
    if (c !== null && c !== undefined && p !== null && p !== undefined && p !== 0) movers.push([g, Number(c), Number(p)]);
  }
  if (!movers.length) return `${scope}${primary.label}缺少对比期数据，无法计算${word}。`;
  const [g, c, p] = primary.format === "percent"
    ? maxBy(movers, (x) => Math.abs(x[1] - x[2]))
    : maxBy(movers, (x) => Math.abs((x[1] - x[2]) / x[2]));
  return `按${group.label}看，${scope}${primary.label}${word}变化最大的是${g}：${prevKey} 为 ${fmt(primary, p)}，${curKey} 为 ${fmt(primary, c)}，${changeText(primary, c, p)}。`;
}
