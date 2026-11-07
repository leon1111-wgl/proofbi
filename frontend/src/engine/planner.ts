/* Port of backend/app/agent/planner.py (RulesPlanner + validate_plan). With default options it
 * must give the same plan as the Python planner: tests/parity.test.ts checks that on every eval
 * question, including the two kept holdout failures. Browser-only additions live in understand.ts
 * and reach this file only through PlannerOptions. */
import { PACK, has, labelOf, regex, scopeLabel, type PackUser } from "./pack";
import { InvalidDate, NUM, OutOfRange, cnToInt, defaultRange, parseTime, previousPeriod, type TimeRange } from "./timeparse";

export interface Plan {
  metrics: string[]; dimensions: string[]; filters: Record<string, string[]>; time: TimeRange;
  compare: string | null; compare_time: TimeRange | null; order: string | null; order_by: string | null;
  limit: number | null; notes: string[]; inherited: string[];
}
export interface Clarification { term: string; question: string; options: { value: string; label: string; description: string }[] }
export interface Refusal { reason: string; message: string; suggestions: string[] }
export interface PlanOutcome { kind: "plan" | "clarify" | "refuse"; plan?: Plan; clarification?: Clarification; refusal?: Refusal; trace: Record<string, unknown> }

export interface Entry { surface: string; kind: "metric" | "ambiguous" | "dimension" | "value"; key: string; values: string[] }
export interface Match { start: number; end: number; entry: Entry }

export interface PlannerOptions {
  extraEntries?: Entry[];
  /** "那退款率呢" and "排个序" keep the conversation's filters and period, which the Python rules planner does not do. */
  richFollowups?: boolean;
}

const WRITE_RE = regex("WRITE_RE"), SENSITIVE_RE = regex("SENSITIVE_RE"), EXPORT_RE = regex("EXPORT_RE"), FORECAST_RE = regex("FORECAST_RE");
export const INJECTION_RE = regex("INJECTION_RE");
const HELP_RE = regex("HELP_RE");
export const UNKNOWN_METRIC_RE = regex("UNKNOWN_METRIC_RE");
const DATA_WORDS_RE = regex("DATA_WORDS_RE");
export const FOLLOWUP_RE = regex("FOLLOWUP_RE");
export const MOM_RE = regex("MOM_RE"), YOY_RE = regex("YOY_RE");
const TREND_RE = regex("TREND_RE");
const TOPN_RE = regex("TOPN_RE"), BOTTOMN_RE = regex("BOTTOMN_RE");
const SUPER_DESC_RE = regex("SUPER_DESC_RE"), SUPER_ASC_RE = regex("SUPER_ASC_RE");
const SINGULAR_RE = regex("SINGULAR_RE"), PLURAL_RE = regex("PLURAL_RE");
const RANK_DESC_RE = regex("RANK_DESC_RE"), RANK_ASC_RE = regex("RANK_ASC_RE");
void NUM;

export const normalize = (text: string) => text.normalize("NFKC").trim();

function baseEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const [key, m] of Object.entries(PACK.metrics)) {
    for (const s of new Set([m.label, ...m.synonyms])) entries.push({ surface: s, kind: "metric", key, values: [] });
  }
  for (const term of Object.keys(PACK.ambiguous)) entries.push({ surface: term, kind: "ambiguous", key: term, values: [] });
  for (const [key, d] of Object.entries(PACK.dimensions)) {
    for (const s of new Set([d.label, ...d.synonyms])) entries.push({ surface: s, kind: "dimension", key, values: [] });
    for (const v of d.values) entries.push({ surface: v, kind: "value", key, values: [v] });
    for (const [alias, targets] of Object.entries(d.value_synonyms)) entries.push({ surface: alias, kind: "value", key, values: targets });
  }
  const store = PACK.dimensions.store, city = PACK.dimensions.city;
  for (const name of store.values) {
    for (const c of city.values) {
      const short = name.slice(c.length);
      if (name.startsWith(c) && short.length >= 3) entries.push({ surface: short, kind: "value", key: "store", values: [name] });
    }
  }
  return entries;
}

export class Vocabulary {
  entries: Entry[];
  constructor(extra: Entry[] = []) { this.entries = [...baseEntries(), ...extra]; }
  match(text: string): Match[] {
    const lower = text.toLowerCase();
    const found: Match[] = [];
    for (const e of this.entries) {
      const needle = e.surface.toLowerCase();
      let start = lower.indexOf(needle);
      while (start !== -1) {
        found.push({ start, end: start + needle.length, entry: e });
        start = lower.indexOf(needle, start + 1);
      }
    }
    found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const taken: Match[] = [];
    for (const m of found) if (taken.every((t) => m.end <= t.start || m.start >= t.end)) taken.push(m);
    return taken.sort((a, b) => a.start - b.start);
  }
}

function rank(text: string, hasDims: boolean): [string | null, number | null] {
  let m = text.match(TOPN_RE);
  if (m) return ["desc", Math.min(cnToInt(m[1]), 100)];
  m = text.match(BOTTOMN_RE);
  if (m) return ["asc", Math.min(cnToInt(m[1]), 100)];
  if (!hasDims) return [null, null];
  const singular = SINGULAR_RE.test(text), plural = PLURAL_RE.test(text);
  const limit = singular ? 1 : plural ? 5 : null;
  if (SUPER_DESC_RE.test(text)) return ["desc", limit];
  if (SUPER_ASC_RE.test(text)) return ["asc", limit];
  if (RANK_ASC_RE.test(text)) return ["asc", null];
  if (RANK_DESC_RE.test(text)) return ["desc", null];
  return [null, null];
}

const refuse = (reason: string, message: string, suggestions: string[] = [], trace: Record<string, unknown> = {}): PlanOutcome =>
  ({ kind: "refuse", refusal: { reason, message, suggestions }, trace });

const metricLabels = () => Object.values(PACK.metrics).map((m) => m.label);

export class RulesPlanner {
  vocab: Vocabulary;
  constructor(private opts: PlannerOptions = {}) { this.vocab = new Vocabulary(opts.extraEntries ?? []); }

  screen(question: string, clarifications: Record<string, string> = {}): PlanOutcome | null {
    const text = normalize(question);
    const trace = { planner: "rules" };
    if (WRITE_RE.test(text)) return refuse("write", "ProofBI 是只读的问数工具，不能修改、删除或写入数据。", [], trace);
    if (SENSITIVE_RE.test(text)) return refuse("sensitive", "手机号、地址等个人敏感信息不在可查询范围内，ProofBI 只提供聚合指标。", [], trace);
    if (EXPORT_RE.test(text)) return refuse("export", "ProofBI 只回答聚合指标，不提供订单或客户明细导出。明细需求请走数据团队的审批流程。", [], trace);
    if (FORECAST_RE.test(text)) return refuse("forecast", `ProofBI 只回答已经发生的数据（截至 ${PACK.calendar.data_end}），不做预测。`, [], trace);
    if (HELP_RE.test(text)) {
      const metrics = Object.values(PACK.metrics).map((m) => m.label).join("、");
      return refuse("off_topic", `可以问这些指标：${metrics}；可按区域、城市、门店、渠道、品类、会员等级、月份等拆分。`, [], trace);
    }
    for (const m of this.vocab.match(text)) {
      if (m.entry.kind !== "ambiguous") continue;
      const term = m.entry.key;
      const options = PACK.ambiguous[term];
      if (!options.includes(clarifications[term])) {
        return {
          kind: "clarify",
          clarification: {
            term,
            question: `“${term}”有不同口径，你想看哪一个？`,
            options: options.map((k) => ({ value: k, label: PACK.metrics[k].label, description: PACK.metrics[k].description })),
          },
          trace,
        };
      }
    }
    return null;
  }

  plan(question: string, user: PackUser, context: Plan | null = null, clarifications: Record<string, string> = {}): PlanOutcome {
    const text = normalize(question);
    const trace: Record<string, unknown> = { planner: "rules" };
    const screened = this.screen(question, clarifications);
    if (screened) return screened;
    const injection = INJECTION_RE.test(text);
    const matches = this.vocab.match(text);
    trace.matches = matches.map((m) => ({ text: text.slice(m.start, m.end), kind: m.entry.kind, key: m.entry.key }));

    const metrics: string[] = [];
    let notes: string[] = [];
    for (const m of matches) {
      if (m.entry.kind === "metric" && !metrics.includes(m.entry.key)) metrics.push(m.entry.key);
      else if (m.entry.kind === "ambiguous") {
        const chosen = clarifications[m.entry.key];
        if (!metrics.includes(chosen)) metrics.push(chosen);
        notes.push(`“${m.entry.key}”按${PACK.metrics[chosen].label}口径统计（已确认）。`);
      }
    }

    let dims: string[] = [];
    const filters: Record<string, string[]> = {};
    const mentions: Record<string, number> = {};
    const multiValue = new Set<string>();
    for (const m of matches) {
      if (m.entry.kind !== "value") continue;
      const vals = (filters[m.entry.key] ??= []);
      for (const v of m.entry.values) if (!vals.includes(v)) vals.push(v);
      mentions[m.entry.key] = (mentions[m.entry.key] ?? 0) + 1;
      if (m.entry.values.length > 1) multiValue.add(m.entry.key);
    }
    matches.forEach((m, i) => {
      if (m.entry.kind !== "dimension") return;
      const key = m.entry.key;
      if (dims.includes(key)) return;
      const dim = PACK.dimensions[key];
      const prev = i > 0 ? matches[i - 1] : null;
      if (prev && prev.entry.kind === "value" && prev.entry.key === key && m.start - prev.end <= 1) return;
      const before = text.slice(Math.max(0, m.start - 4), m.start);
      const after = text.slice(m.end, m.end + 6).toLowerCase();
      if (dim.is_time || PACK.group_prefixes.some((p) => before.endsWith(p)) || PACK.group_suffixes.some((s) => after.includes(s))) dims.push(key);
      else if (!(key in filters)) dims.push(key);
    });
    for (const [key, count] of Object.entries(mentions)) {
      if (count >= 2 && !dims.includes(key) && !multiValue.has(key)) dims.push(key);
    }
    if (TREND_RE.test(text) && !dims.some((d) => PACK.dimensions[d].is_time)) dims.push("month");

    const inherited: string[] = [];
    const prev = context;
    const followupWords = FOLLOWUP_RE.test(text);
    const asksTime = () => { try { return parseTime(text) !== null; } catch (e) { return e instanceof OutOfRange; } };
    let isFollowup = prev !== null && metrics.length === 0 && (Object.keys(filters).length > 0 || dims.length > 0 || followupWords || asksTime());
    const opts = this.opts;
    if (opts.richFollowups && prev && !isFollowup) {
      const rankOnly = metrics.length === 0 && (RANK_DESC_RE.test(text) || RANK_ASC_RE.test(text) || TOPN_RE.test(text) || BOTTOMN_RE.test(text) || SUPER_DESC_RE.test(text) || SUPER_ASC_RE.test(text) || MOM_RE.test(text) || YOY_RE.test(text));
      if (rankOnly || (metrics.length > 0 && followupWords)) isFollowup = true;
    }
    if (metrics.length === 0) {
      if (isFollowup) {
        metrics.push(...prev!.metrics);
        inherited.push("metrics");
      } else if (injection) {
        return refuse("off_topic", "没有识别到要查询的指标。数据权限由系统强制执行，不能通过提问绕过。", [], trace);
      } else if (UNKNOWN_METRIC_RE.test(text) || DATA_WORDS_RE.test(text)) {
        return refuse("unknown_metric", "语义层里没有定义这个指标，为了避免口径不一致，ProofBI 不会临时编一个口径。", metricLabels(), trace);
      } else {
        return refuse("off_topic", "我只回答 Leon优选 经营数据相关的问题，例如“上个月华东区的复购率是多少？”", [], trace);
      }
    }
    if (isFollowup) {
      for (const [key, vals] of Object.entries(prev!.filters)) if (!(key in filters)) filters[key] = [...vals];
      if (dims.length === 0) {
        dims = prev!.dimensions.filter((d) => !(d in filters));
        if (dims.length) inherited.push("dimensions");
      }
      if (inherited.length === 1 && inherited[0] === "metrics") notes.push(`沿用上一个问题的指标：${metrics.map(labelOf).join("、")}。`);
    }

    const stripped = text.replace(MOM_RE_G, " ").replace(YOY_RE_G, " ");
    let time: TimeRange | null;
    try {
      time = parseTime(stripped);
    } catch (e) {
      if (e instanceof OutOfRange) return refuse("out_of_range", e.message, [], trace);
      if (e instanceof InvalidDate) return refuse("out_of_range", e.message, [], trace);
      throw e;
    }
    if (time === null) {
      if (isFollowup) {
        time = prev!.time;
        inherited.push("time");
      } else {
        time = defaultRange(dims.some((d) => PACK.dimensions[d].is_time));
      }
    }
    if (inherited.includes("time")) notes.push(`沿用上一个问题的时间：${time.label}。`);
    else notes = [...time.notes, ...notes];

    let compare: string | null = MOM_RE.test(text) ? "mom" : YOY_RE.test(text) ? "yoy" : null;
    if (compare === null && isFollowup && prev!.compare && inherited.includes("time")) compare = prev!.compare;
    let compareTime: TimeRange | null = null;
    if (compare) {
      const dropped = dims.filter((d) => PACK.dimensions[d].is_time);
      if (dropped.length) {
        dims = dims.filter((d) => !dropped.includes(d));
        notes.push(`${compare === "yoy" ? "同比" : "环比"}按整个统计周期对比，不再按${labelOf(dropped[0])}拆分。`);
      }
      compareTime = previousPeriod(time, compare);
      if (compareTime.start < PACK.calendar.data_start) {
        notes.push(`对比期（${compareTime.start} 起）没有完整数据，本次不做${compare === "yoy" ? "同比" : "环比"}。`);
        compare = null;
        compareTime = null;
      }
    }

    let [order, limit] = rank(text, dims.length > 0);
    if (order === null && isFollowup && prev!.order && inherited.includes("dimensions")) [order, limit] = [prev!.order, prev!.limit];
    if (injection) notes.push("检测到“忽略权限 / 规则”之类的表述：已忽略，数据权限由系统强制执行。");

    const plan: Plan = {
      metrics, dimensions: dims, filters, time, compare, compare_time: compareTime, order,
      order_by: order ? metrics[0] : null, limit, notes, inherited,
    };
    return validatePlan(plan, user, trace);
  }
}

const MOM_RE_G = regex("MOM_RE", true), YOY_RE_G = regex("YOY_RE", true);

export function validatePlan(plan: Plan, user: PackUser, trace: Record<string, unknown> = {}): PlanOutcome {
  if (!plan.metrics.length) return refuse("unknown_metric", "没有识别到语义层中的指标。", metricLabels(), trace);
  for (const key of plan.metrics) {
    const metric = PACK.metrics[key];
    if (!metric) return refuse("unknown_metric", `语义层中没有指标 ${key}。`, metricLabels(), trace);
    if (metric.requires && !has(user, metric.requires)) {
      return refuse("permission", `${metric.label}涉及成本数据，你的账号没有“${metric.requires}”权限。如需查看请联系财务或数据平台负责人。`, [], trace);
    }
  }
  for (const key of plan.dimensions) {
    if (!PACK.dimensions[key]) return refuse("unsupported", `语义层中没有维度 ${key}。`, [], trace);
    for (const m of plan.metrics) {
      const allowed = PACK.metrics[m].allowed_dimensions;
      if (!allowed.includes(key)) {
        return refuse("unsupported", `${PACK.metrics[m].label}的口径不支持按${PACK.dimensions[key].label}拆分（可用维度：${allowed.map(labelOf).join("、")}）。`, [], trace);
      }
    }
  }
  for (const [key, values] of Object.entries(plan.filters)) {
    const dim = PACK.dimensions[key];
    if (!dim) return refuse("unsupported", `语义层中没有维度 ${key}。`, [], trace);
    const bad = values.filter((v) => dim.values.length > 0 && !dim.values.includes(v));
    if (bad.length) return refuse("unsupported", `${dim.label}中没有取值 ${bad.join("、")}。`, [], trace);
    for (const m of plan.metrics) {
      if (!PACK.metrics[m].allowed_dimensions.includes(key)) {
        return refuse("unsupported", `${PACK.metrics[m].label}的口径不支持按${dim.label}筛选。`, [], trace);
      }
    }
  }
  const denied = outOfScope(plan, user);
  if (denied) return refuse("permission", `你的数据权限是“${scopeLabel(user)}”，无法查询${denied}的数据。`, [], trace);
  if (plan.limit !== null) plan.limit = Math.max(1, Math.min(Math.trunc(plan.limit), 100));
  return { kind: "plan", plan, trace };
}

function outOfScope(plan: Plan, user: PackUser): string | null {
  if (user.scope_type === "all") return null;
  const lk = PACK.lookups;
  const allowedRegions = new Set(user.scope_type === "store" ? user.stores.map((s) => lk.store_region[s] ?? "") : user.regions);
  for (const name of plan.filters.region ?? []) if (!allowedRegions.has(lk.region_codes[name])) return name;
  for (const name of plan.filters.store ?? []) {
    const code = lk.store_codes[name];
    if (user.scope_type === "store" && !user.stores.includes(code)) return name;
    if (user.scope_type === "region" && !allowedRegions.has(lk.store_region[code ?? ""] ?? "")) return name;
  }
  for (const name of plan.filters.city ?? []) {
    if (user.scope_type === "store") {
      if (!user.stores.map((s) => lk.store_city[s]).includes(name)) return name;
    } else if (!(lk.city_regions[name] ?? []).some((r) => allowedRegions.has(r))) return name;
  }
  return null;
}
