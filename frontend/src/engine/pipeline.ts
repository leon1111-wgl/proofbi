/* The ask pipeline in the browser: the same steps and the same payload as backend/app/agent/pipeline.py,
 * so the console renders both alike. Each run is kept in tab memory so that provenance, traces and
 * replay work for it. Nothing leaves the tab. */
import { compileSpec, specTitle, splitPlan, type QuerySpec } from "./compiler";
import { alignColumns, chartFor, narrate, type ColumnMeta, type QueryOutput } from "./narrator";
import { PACK, scopeLabel, type PackUser } from "./pack";
import type { Plan } from "./planner";
import { applyRowPolicies, checkSql } from "./sqlguard";
import { pastedSql, understand, type Conversation } from "./understand";
import { verifyAnswer, type Cell, type ResultTable } from "./verifier";
import { QueryError, sha256, type Warehouse } from "./warehouse";

export const ENGINE_LABEL = "浏览器规则引擎（规则解析 + 模板 SQL + SQLite WASM）";

export interface Step { type: "step"; step: string; status: string; title: string; detail?: unknown }
export interface Span { seq: number; kind: string; name: string; status: string; start_ms: number; duration_ms: number; input: unknown; output: unknown }
/* The payload mirrors RunPayload in ../types.ts; it is loosely typed here so the engine has no UI dependency. */
export type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hex = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

function planView(plan: Plan) {
  return {
    metrics: plan.metrics.map((k) => ({ key: k, label: PACK.metrics[k].label, description: PACK.metrics[k].description, filter: PACK.metrics[k].filter })),
    dimensions: plan.dimensions.map((d) => ({ key: d, label: PACK.dimensions[d].label })),
    filters: Object.entries(plan.filters).map(([k, v]) => ({ key: k, label: PACK.dimensions[k].label, values: v })),
    time: plan.time,
    compare: plan.compare && plan.compare_time ? { kind: plan.compare, label: plan.compare === "yoy" ? "同比" : "环比", time: plan.compare_time } : null,
    order: plan.order, limit: plan.limit, notes: plan.notes, inherited: plan.inherited,
  };
}

interface Attempt {
  id: string; key: string; attempt: number; status: string; sql_generated: string; title: string; sql_checked: string | null; sql_executed: string | null;
  error: string | null; violations: unknown[]; lint: unknown[]; notes: string[]; columns: string[]; column_meta: ColumnMeta[]; rows: Cell[][]; row_count: number;
  truncated: boolean; elapsed_ms: number; sql_hash: string | null; result_hash: string | null; executed_at: string | null; policies: Record<string, string | null>;
}
export interface StoredRun { payload: Payload; spans: Span[]; attempts: Attempt[]; username: string }

const summary = (a: Attempt) => ({ id: a.id, attempt: a.attempt, status: a.status, error: a.error, violations: a.violations, lint: a.lint, notes: a.notes, sql: a.sql_generated });

export class Engine {
  runs = new Map<string, StoredRun>();
  queries = new Map<string, { attempt: Attempt; run: StoredRun }>();
  constructor(public warehouse: Warehouse) {}

  async *ask(input: { question: string; user: PackUser; convo: Conversation; clarifications?: Record<string, string>; conversationId?: number | null }): AsyncGenerator<Step | { type: "result"; result: Payload }> {
    const { question, user, convo } = input;
    const clarifications = input.clarifications ?? {};
    const started = performance.now();
    const spans: Span[] = [];
    const span = (kind: string, name: string, t0: number, status: string, inp: unknown, output: unknown) => {
      spans.push({ seq: spans.length + 1, kind, name, status, start_ms: Math.round((t0 - started) * 100) / 100, duration_ms: Math.round((performance.now() - t0) * 100) / 100, input: inp, output });
    };
    const scope = { type: user.scope_type, label: scopeLabel(user), restricted: user.scope_type !== "all" };
    const attempts: Attempt[] = [];
    const finals: Attempt[] = [];
    const payload: Payload = {
      run_id: `r_${hex()}`, conversation_id: input.conversationId ?? null, question, username: user.username, status: "failed",
      created_at: new Date().toISOString(), model: ENGINE_LABEL, engine: "browser", latency_ms: 0, plan: null, plan_view: null, scope,
      answer: null, clarification: null, refusal: null, error: null, queries: [], corrections: 0, failed_attempts: [], fault: null, usage: {},
    };
    const finish = async (): Promise<Payload> => {
      payload.latency_ms = Math.round((performance.now() - started) * 100) / 100;
      payload.queries = finals.map((a) => ({
        query_id: a.id, key: a.key, title: a.title, status: a.status, sql: a.sql_checked ?? a.sql_generated, executed_sql: a.sql_executed,
        columns: a.columns, column_meta: a.column_meta, rows: a.rows.slice(0, 200), row_count: a.row_count, truncated: a.truncated, elapsed_ms: a.elapsed_ms,
        sql_hash: a.sql_hash, result_hash: a.result_hash, executed_at: a.executed_at, policies: a.policies, dataset_fingerprint: PACK.dataset.fingerprint,
        attempts: attempts.filter((x) => x.key === a.key).map(summary),
      }));
      payload.failed_attempts = attempts.filter((a) => a.status !== "ok").map((a) => ({ ...summary(a), key: a.key }));
      const stored: StoredRun = { payload, spans, attempts, username: user.username };
      this.runs.set(payload.run_id, stored);
      for (const a of attempts) this.queries.set(a.id, { attempt: a, run: stored });
      return payload;
    };

    const sql = Object.keys(clarifications).length ? null : pastedSql(question);
    if (sql !== null) {
      yield* this.runPasted(sql, user, attempts, finals, span, payload);
      yield { type: "result", result: await finish() };
      return;
    }

    yield { type: "step", step: "plan", status: "running", title: "理解问题，映射到语义层" };
    const t0 = performance.now();
    const read = understand(question, user, convo, clarifications);
    const outcome = read.outcome;
    span("plan", "问题解析（语义层映射）", t0, outcome.kind === "refuse" ? "refused" : "ok",
      { question, rewritten: read.rewritten, planner: "browser-rules", context: convo.lastPlan, clarifications },
      { kind: outcome.kind, trace: outcome.trace, plan: outcome.plan ?? null, clarification: outcome.clarification ?? null, refusal: outcome.refusal ?? null });

    if (outcome.kind === "clarify") {
      const c = outcome.clarification!;
      payload.status = "clarify";
      payload.clarification = c;
      convo.pending = { question: read.asked, term: c.term, options: c.options.map((o) => o.value), clarifications };
      yield { type: "step", step: "plan", status: "clarify", title: "口径有歧义，需要确认" };
      yield { type: "result", result: await finish() };
      return;
    }
    convo.pending = null;
    if (outcome.kind === "refuse") {
      const r = outcome.refusal!;
      const label = PACK.refusal_text[r.reason] ?? (r.reason === "unknown_term" ? "语义层无法表达这个条件" : "");
      payload.status = "refused";
      payload.refusal = { ...r, label, next_steps: read.nextSteps };
      yield { type: "step", step: "plan", status: "refused", title: label };
      yield { type: "result", result: await finish() };
      return;
    }

    const plan = outcome.plan!;
    payload.plan = plan;
    payload.plan_view = planView(plan);
    if (scope.restricted) payload.plan_view.notes = [...payload.plan_view.notes, `数据范围：${scope.label}（行级权限由系统强制执行，结果只包含你有权限的数据）。`];
    yield { type: "step", step: "plan", status: "ok", title: "已映射到语义层", detail: payload.plan_view };

    const outputs: QueryOutput[] = [];
    for (const spec of splitPlan(plan)) {
      const result = yield* this.runCompiled(spec, user, attempts, finals, span, payload);
      if (!result) {
        yield { type: "result", result: await finish() };
        return;
      }
      outputs.push(result);
    }

    yield { type: "step", step: "answer", status: "running", title: "生成结论" };
    let t = performance.now();
    const text = narrate(plan, outputs);
    span("narrate", "生成结论（模板）", t, "ok", { queries: outputs.map((o) => o.query_id) }, { text });
    t = performance.now();
    const tables: ResultTable[] = outputs.map((o) => ({ query_id: o.query_id, columns: o.columns, rows: o.rows, labels: Object.fromEntries(o.meta.map((m) => [m.key, m.label])) }));
    const report = verifyAnswer(text, tables, [plan.time.label]); // a period's name ("2026年618") is not a data point
    span("verify", "数字核对", t, report.verdict !== "fail" ? "ok" : "error", { text }, report);
    payload.answer = { text, verification: report, charts: outputs.map(chartFor) };
    payload.status = "answered";
    convo.lastPlan = plan;
    yield { type: "step", step: "verify", status: report.verdict !== "fail" ? "ok" : "error", title: report.verdict !== "fail" ? "数字全部可核对" : "有数字在结果中找不到", detail: report.counts };
    yield { type: "result", result: await finish() };
  }

  private async *runCompiled(spec: QuerySpec, user: PackUser, attempts: Attempt[], finals: Attempt[], span: SpanFn, payload: Payload): AsyncGenerator<Step, QueryOutput | null> {
    const title = specTitle(spec);
    yield { type: "step", step: "sql", status: "running", title: `生成 SQL：${spec.key} · ${title}` };
    let t = performance.now();
    const written = compileSpec(spec, PACK.limits.max_rows);
    span("sql", `生成 SQL：${spec.key} · ${title}`, t, "ok", { spec, writer: "template" }, { sql: written, note: null });
    const att = newAttempt(spec.key, title, written);
    attempts.push(att);
    const executed = yield* this.guardAndRun(att, written, user, span, payload, spec.key);
    if (!executed) return null;
    att.column_meta = alignColumns(spec, att.columns);
    finals.push(att);
    return { spec, query_id: att.id, columns: att.columns, rows: att.rows, meta: att.column_meta };
  }

  private async *runPasted(sql: string, user: PackUser, attempts: Attempt[], finals: Attempt[], span: SpanFn, payload: Payload): AsyncGenerator<Step> {
    yield { type: "step", step: "sql", status: "ok", title: "这是一条 SQL：跳过规划器，按不可信 SQL 处理" };
    const att = newAttempt("q1", "粘贴的 SQL", sql);
    attempts.push(att);
    const executed = yield* this.guardAndRun(att, sql, user, span, payload, "q1");
    if (!executed) return;
    att.column_meta = att.columns.map((name, i) => {
      const numeric = att.rows.some((r) => typeof r[i] === "number");
      return { key: name, label: name, role: numeric ? "metric" : "dimension", format: numeric ? "number" : "text", unit: "" } as ColumnMeta;
    });
    finals.push(att);
    const text = `这条 SQL 通过了安全校验，在“${scopeLabel(user)}”的数据权限下执行，结果见下表。行级权限和字段权限都已生效；它不走语义层，所以没有口径保证。`;
    payload.answer = { text, verification: { verdict: "none", counts: { verified: 0, derived: 0, unverified: 0 }, numbers: [] }, charts: [{ query_id: att.id, type: "table" }] };
    payload.status = "answered";
    payload.pasted_sql = true;
  }

  /** Guard, row policies, then the engine. Shared by compiled and pasted SQL. */
  private async *guardAndRun(att: Attempt, sql: string, user: PackUser, span: SpanFn, payload: Payload, key: string): AsyncGenerator<Step, boolean> {
    let t = performance.now();
    this.warehouse.useIdentity(user);
    const checked = checkSql(sql, user, (s) => this.warehouse.parseCheck(s));
    span("guard", `SQL 安全校验：${key}`, t, checked.ok ? "ok" : checked.security ? "refused" : "error", { sql }, { ok: checked.ok, violations: checked.violations, tables: checked.tables, notes: checked.notes });
    att.violations = checked.violations;
    att.notes.push(...checked.notes);
    if (!checked.ok) {
      att.status = checked.security ? "security" : "rejected";
      payload.status = "refused";
      payload.refusal = checked.security
        ? { reason: "security", label: PACK.refusal_text.security, message: `这条 SQL 未通过安全校验，已拒绝执行：${checked.error}`, suggestions: [], next_steps: [] }
        : { reason: "sql_rejected", label: "SQL 未通过校验", message: `这条 SQL 没有执行：${checked.error}。在完整服务里这类可修复错误会交回模型修正。`, suggestions: [], next_steps: [] };
      yield { type: "step", step: "guard", status: "refused", title: checked.security ? "安全校验未通过，已拒绝执行" : "SQL 未通过校验，没有执行", detail: checked.violations };
      return false;
    }
    att.sql_checked = checked.sql;
    span("lint", `口径校验：${key}`, performance.now(), "ok", {}, { issues: [], note: payload.plan ? "SQL 由语义层编译，和计划一一对应；模型写的 SQL 才需要这一步（后端实现）" : "粘贴的 SQL 不走语义层，这一步不适用" });

    t = performance.now();
    const rewritten = applyRowPolicies(checked, user);
    span("rls", `行级权限改写：${key}`, t, "ok", { user: user.username }, { policies: rewritten.policies, sql: rewritten.sql });
    att.sql_executed = rewritten.sql;
    att.policies = rewritten.policies;
    att.sql_hash = await sha256(rewritten.sql);

    yield { type: "step", step: "execute", status: "running", title: `执行查询：${key}` };
    t = performance.now();
    try {
      const result = await this.warehouse.execute(rewritten.sql, user);
      span("execute", `执行查询：${key}`, t, "ok", { sql_hash: att.sql_hash }, { rows: result.row_count, elapsed_ms: result.elapsed_ms, truncated: result.truncated, result_hash: result.result_hash });
      att.status = "ok";
      att.columns = result.columns;
      att.rows = result.rows;
      att.row_count = result.row_count;
      att.truncated = result.truncated;
      att.elapsed_ms = result.elapsed_ms;
      att.result_hash = result.result_hash;
      att.executed_at = result.executed_at;
      yield { type: "step", step: "execute", status: "ok", title: `${key} 返回 ${result.row_count} 行，用时 ${result.elapsed_ms} ms` };
      return true;
    } catch (e) {
      const err = e as QueryError;
      att.error = err.message;
      att.status = err.kind === "denied" ? "security" : "error";
      span("execute", `执行查询：${key}`, t, "error", { sql_hash: att.sql_hash }, { error: err.message, kind: err.kind });
      payload.status = "refused";
      payload.refusal = err.kind === "denied"
        ? { reason: "security", label: PACK.refusal_text.security, message: `执行层拒绝了这条查询：${err.message}`, suggestions: [], next_steps: [] }
        : { reason: "sql_rejected", label: err.kind === "timeout" ? "查询超时" : "SQL 执行报错", message: `这条 SQL 没有结果：${err.message}`, suggestions: [], next_steps: [] };
      yield { type: "step", step: "execute", status: "refused", title: err.kind === "denied" ? "执行层拒绝" : "执行报错" };
      return false;
    }
  }

  trace(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      summary: this.summary(run), payload: run.payload, spans: run.spans,
      attempts: run.attempts.map((a) => ({ ...summary(a), key: a.key, executed_sql: a.sql_executed, elapsed_ms: a.elapsed_ms, row_count: a.row_count })),
    };
  }

  summary(run: StoredRun) {
    const p = run.payload;
    return {
      run_id: p.run_id, question: p.question, username: p.username, source: "chat", status: p.status, verdict: p.answer?.verification.verdict ?? null,
      corrections: 0, latency_ms: p.latency_ms, model: p.model, created_at: p.created_at, conversation_id: p.conversation_id,
      metrics: p.plan?.metrics ?? [], refusal: p.refusal?.reason ?? null, engine: "browser",
    };
  }

  query(queryId: string) {
    const found = this.queries.get(queryId);
    if (!found) return null;
    const { attempt: a, run } = found;
    return {
      query_id: a.id, run_id: run.payload.run_id, key: a.key, attempt: a.attempt, status: a.status, title: a.title, username: run.username, question: run.payload.question,
      sql: a.sql_checked ?? a.sql_generated, sql_generated: a.sql_generated, executed_sql: a.sql_executed, error: a.error, violations: a.violations, lint: a.lint, notes: a.notes,
      columns: a.columns, column_meta: a.column_meta, rows: a.rows, row_count: a.row_count, truncated: a.truncated, elapsed_ms: a.elapsed_ms, sql_hash: a.sql_hash, result_hash: a.result_hash,
      executed_at: a.executed_at, policies: a.policies, dataset_fingerprint: PACK.dataset.fingerprint, run_created_at: run.payload.created_at, engine: "browser",
      attempts: run.attempts.filter((x) => x.key === a.key).map(summary),
    };
  }

  /** Runs the stored SQL again and compares fingerprints, after checking the SQL was not altered. */
  async replay(queryId: string, user: PackUser) {
    const found = this.queries.get(queryId);
    if (!found || !found.attempt.sql_executed) return null;
    const a = found.attempt;
    if ((await sha256(a.sql_executed!)) !== a.sql_hash) throw new Error("SQL 指纹不一致，记录可能被修改，拒绝重放");
    const result = await this.warehouse.execute(a.sql_executed!, user);
    return {
      query_id: a.id, match: result.result_hash === a.result_hash, original_hash: a.result_hash, replay_hash: result.result_hash, row_count: result.row_count,
      elapsed_ms: result.elapsed_ms, executed_at: result.executed_at, dataset_fingerprint: PACK.dataset.fingerprint, dataset_changed: false,
    };
  }
}

type SpanFn = (kind: string, name: string, t0: number, status: string, inp: unknown, output: unknown) => void;

function newAttempt(key: string, title: string, sql: string): Attempt {
  return {
    id: `q_${hex()}`, key, attempt: 1, status: "rejected", sql_generated: sql, title, sql_checked: null, sql_executed: null, error: null, violations: [], lint: [], notes: [],
    columns: [], column_meta: [], rows: [], row_count: 0, truncated: false, elapsed_ms: 0, sql_hash: null, result_hash: null, executed_at: null, policies: {},
  };
}
