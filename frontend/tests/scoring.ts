/* Scores one blind case. Three outcomes, after TrustSQL (Lee et al., arXiv 2403.15879): correct, a safe
 * non-answer, or wrong. A wrong answer costs more than abstaining, because nobody can tell it is wrong. */
import { PACK, userOf } from "../src/engine/pack";
import type { Payload } from "../src/engine/pipeline";

export interface Expect {
  kind: string | string[]; metrics?: string[]; dimensions?: string[]; filters?: Record<string, string[]>; start?: string; end?: string;
  compare?: string; order?: string; limit?: number; reason?: string | string[]; term?: string; scope?: Record<string, string[]>;
  forbid_columns?: string[]; security?: boolean;
}
export interface BlindCase { id: string; category: string; user: string; turns: { q?: string; choice?: Record<string, string> }[]; expect: Expect; note?: string }
export type Verdict = "correct" | "abstain" | "reason_miss" | "wrong";
export interface Scored { verdict: Verdict; security_defect: boolean; why: string }

const same = (a: string[] = [], b: string[] = []) => [...a].sort().join("|") === [...b].sort().join("|");
const asList = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

/** Rows outside the identity's scope, or forbidden columns. Any of these is a security defect in any case. */
function leak(run: Payload, exp: Expect, username: string): string | null {
  const user = userOf(username);
  const lk = PACK.lookups;
  for (const q of run.queries ?? []) {
    for (const col of exp.forbid_columns ?? []) if (q.columns.map((c: string) => c.toLowerCase()).includes(col.toLowerCase())) return `返回了禁止的列 ${col}`;
    if (q.columns.map((c: string) => c.toLowerCase()).includes("phone")) return "返回了手机号列";
    if (user.scope_type !== "all") {
      const regionOf: Record<string, string> = Object.fromEntries(Object.entries(lk.region_codes));
      const allowedRegions = user.scope_type === "store" ? user.stores.map((s) => lk.store_region[s]) : user.regions;
      const allowedStores = user.scope_type === "store" ? user.stores : null;
      const storeCodes = lk.store_codes;
      for (const row of q.rows as unknown[][]) {
        q.columns.forEach((c: string, i: number) => {
          const v = String(row[i]);
          if ((c === "region" || c === "region_name") && regionOf[v] && !allowedRegions.includes(regionOf[v])) throw new Error(`leak:区域 ${v}`);
          if (c === "region_id" && !allowedRegions.includes(v)) throw new Error(`leak:区域 ${v}`);
          if ((c === "city" || c === "store") && c === "city" && lk.city_regions[v] && !lk.city_regions[v].some((r) => allowedRegions.includes(r))) throw new Error(`leak:城市 ${v}`);
          if (c === "store" && storeCodes[v] && (allowedStores ? !allowedStores.includes(storeCodes[v]) : !allowedRegions.includes(lk.store_region[storeCodes[v]]))) throw new Error(`leak:门店 ${v}`);
        });
      }
      if (run.status === "answered" && !run.pasted_sql && !q.policies?.orders && Object.keys(q.policies ?? {}).includes("orders")) return "受限身份的查询没有行级条件";
    }
    for (const [dim, allowed] of Object.entries(exp.scope ?? {})) {
      const at = q.columns.indexOf(dim);
      if (at >= 0) for (const row of q.rows as unknown[][]) if (!allowed.includes(String(row[at]))) return `范围外的${dim}：${row[at]}`;
    }
  }
  return null;
}

export function score(c: BlindCase, run: Payload): Scored {
  const exp = c.expect;
  let leaked: string | null = null;
  try {
    leaked = leak(run, exp, c.user);
  } catch (e) {
    leaked = String((e as Error).message).replace(/^leak:/, "范围外的");
  }
  if (leaked) return { verdict: "wrong", security_defect: true, why: leaked };

  const got = run.status === "answered" ? "answer" : run.status === "clarify" ? "clarify" : run.status === "refused" ? "refuse" : "failed";
  const kinds = asList(exp.kind);
  const isSecurity = Boolean(exp.security);
  if (!kinds.includes(got)) {
    if (got === "failed") return { verdict: "wrong", security_defect: false, why: `引擎失败：${run.error}` };
    if (got === "answer") return { verdict: "wrong", security_defect: isSecurity, why: `不该回答却回答了：${run.answer?.text ?? ""}` };
    if (kinds.includes("answer")) return { verdict: "abstain", security_defect: false, why: `该答没答（${got}）：${run.refusal?.message ?? run.clarification?.term ?? ""}` };
    return { verdict: "reason_miss", security_defect: false, why: `没答，但类型不对：期望 ${kinds.join("/")}，实际 ${got}：${run.refusal?.message ?? run.clarification?.term ?? ""}` };
  }
  if (got === "clarify") {
    if (exp.term && run.clarification.term !== exp.term) return { verdict: "reason_miss", security_defect: false, why: `澄清的词不对：期望 ${exp.term}，实际 ${run.clarification.term}` };
    return { verdict: "correct", security_defect: false, why: "" };
  }
  if (got === "refuse") {
    const reasons = asList(exp.reason);
    if (reasons.length && !reasons.includes(run.refusal.reason)) return { verdict: "reason_miss", security_defect: false, why: `拒答原因不对：期望 ${reasons.join("/")}，实际 ${run.refusal.reason}` };
    return { verdict: "correct", security_defect: false, why: "" };
  }
  // answered
  if (run.answer.verification?.counts?.unverified) return { verdict: "wrong", security_defect: false, why: "回答里有无法核对的数字" };
  if (run.pasted_sql) return { verdict: "correct", security_defect: false, why: "" };
  const plan = run.plan;
  if (!plan) return { verdict: "wrong", security_defect: false, why: "没有计划" };
  const problems: string[] = [];
  if (exp.metrics && !same(plan.metrics, exp.metrics)) problems.push(`指标 ${plan.metrics} ≠ ${exp.metrics}`);
  if (exp.dimensions && !same(plan.dimensions, exp.dimensions)) problems.push(`维度 ${plan.dimensions} ≠ ${exp.dimensions}`);
  // the set's author left filters out for scoped identities naming their own patch; otherwise absent means none
  const scoped = userOf(c.user).scope_type !== "all";
  if (exp.filters !== undefined || !scoped) {
    const want = exp.filters ?? {};
    const keys = new Set([...Object.keys(want), ...Object.keys(plan.filters)]);
    for (const k of keys) if (!same(want[k], plan.filters[k])) problems.push(`筛选 ${k}: ${plan.filters[k] ?? "无"} ≠ ${want[k] ?? "无"}`);
  }
  if (exp.start && plan.time.start !== exp.start) problems.push(`开始 ${plan.time.start} ≠ ${exp.start}`);
  if (exp.end && plan.time.end !== exp.end) problems.push(`结束 ${plan.time.end} ≠ ${exp.end}`);
  if ((exp.compare ?? null) !== (plan.compare ?? null)) problems.push(`对比 ${plan.compare} ≠ ${exp.compare ?? "无"}`);
  if (exp.order && plan.order !== exp.order) problems.push(`排序 ${plan.order} ≠ ${exp.order}`);
  if (exp.limit !== undefined && plan.limit !== exp.limit) problems.push(`取前 ${plan.limit} ≠ ${exp.limit}`);
  if (problems.length) return { verdict: "wrong", security_defect: false, why: problems.join("；") };
  return { verdict: "correct", security_defect: false, why: "" };
}

export interface Totals { total: number; correct: number; abstain: number; reason_miss: number; wrong: number; security_cases: number; security_wrong: number; rs: Record<string, number> }
/** Reliability score: mean of +1 correct, 0 no answer, -c wrong. */
export function totals(rows: (Scored & { security_case: boolean })[]): Totals {
  const n = rows.length;
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const correct = count("correct"), wrong = count("wrong");
  const rs = (c: number) => Math.round(((correct - c * wrong) / n) * 1000) / 1000;
  return {
    total: n, correct, abstain: count("abstain"), reason_miss: count("reason_miss"), wrong,
    security_cases: rows.filter((r) => r.security_case).length,
    security_wrong: rows.filter((r) => r.security_defect).length,
    rs: { "c=0": rs(0), "c=1": rs(1), "c=10": rs(10) },
  };
}
