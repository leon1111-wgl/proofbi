/* The port must give what the Python pipeline gives: same plan, same SQL, same rows, same sentence,
 * same number checks. The core planner is used without any browser addition, so the two kept holdout
 * failures stay failures here too. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileSpec, narrowToRows, specTitle, splitPlan } from "../src/engine/compiler";
import { alignColumns, chartFor, narrate, type QueryOutput } from "../src/engine/narrator";
import { PACK, userOf } from "../src/engine/pack";
import { RulesPlanner, type Plan } from "../src/engine/planner";
import { applyRowPolicies, checkSql } from "../src/engine/sqlguard";
import { verifyAnswer } from "../src/engine/verifier";
import { engine } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parity: { cases: any[] } = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf-8"));
const core = new RulesPlanner();

async function runCase(c: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const user = userOf(c.user);
  let context: Plan | null = null;
  if (c.context) {
    const ctx = core.plan(c.context, user);
    context = ctx.plan ?? null;
  }
  const outcome = core.plan(c.question, user, context, c.clarifications);
  const status = outcome.kind === "plan" ? "answered" : outcome.kind === "clarify" ? "clarify" : "refused";
  expect(status, c.question).toBe(c.status);
  if (outcome.kind === "clarify") {
    expect(outcome.clarification).toEqual(c.clarification);
    return;
  }
  if (outcome.kind === "refuse") {
    expect(outcome.refusal!.reason, c.question).toBe(c.refusal.reason);
    expect(outcome.refusal!.message, c.question).toBe(c.refusal.message);
    expect(outcome.refusal!.suggestions, c.question).toEqual(c.refusal.suggestions);
    return;
  }
  const plan = outcome.plan!;
  expect(plan, c.question).toEqual(c.plan);
  const e = await engine();
  const outputs: QueryOutput[] = [];
  const specs = splitPlan(plan);
  expect(specs.length, c.question).toBe(c.queries.length);
  for (const [i, spec] of specs.entries()) {
    if (outputs.length) narrowToRows(spec, plan, outputs[0].columns, outputs[0].rows);
    const sql = compileSpec(spec, PACK.limits.max_rows);
    expect(sql, c.question).toBe(c.queries[i].sql);
    expect(specTitle(spec)).toBe(c.queries[i].title);
    const checked = checkSql(sql, user);
    expect(checked.ok, `${c.question}: ${checked.error}`).toBe(true);
    const rewritten = applyRowPolicies(checked, user);
    expect(rewritten.policies, c.question).toEqual(c.queries[i].policies);
    const result = await e.warehouse.execute(rewritten.sql, user);
    expect(result.columns, c.question).toEqual(c.queries[i].columns);
    expect(result.rows, c.question).toEqual(c.queries[i].rows);
    const meta = alignColumns(spec, result.columns);
    expect(meta.map(({ key, label, role, format, unit }) => ({ key, label, role, format, unit }))).toEqual(
      c.queries[i].meta.map(({ key, label, role, format, unit }: Record<string, unknown>) => ({ key, label, role, format, unit })));
    outputs.push({ spec, query_id: `q${i}`, columns: result.columns, rows: result.rows, meta });
  }
  const tables = outputs.map((o) => ({ query_id: o.query_id, columns: o.columns, rows: o.rows, labels: Object.fromEntries(o.meta.map((m) => [m.key, m.label])) }));
  if (c.fault === "number_hallucination") {
    // the perturbed sentence comes from Python; the port must flag exactly what Python flags
    const report = verifyAnswer(c.answer, tables);
    expect(report.verdict).toBe("fail");
    expect(report.numbers.map((n) => [n.text, n.status])).toEqual(c.verification.numbers.map((n: { text: string; status: string }) => [n.text, n.status]));
    return;
  }
  const text = narrate(plan, outputs);
  expect(text, c.question).toBe(c.answer);
  const report = verifyAnswer(text, tables, [plan.time.label]);
  expect(report.verdict, c.question).toBe(c.verification.verdict);
  expect(report.numbers.map((n) => ({ text: n.text, start: n.start, end: n.end, status: n.status, formula: n.formula, cell: n.ref ? [n.ref.row, n.ref.column] : null }))).toEqual(
    c.verification.numbers.map((n: any) => ({ text: n.text, start: n.start, end: n.end, status: n.status, formula: n.formula, cell: n.ref ? [n.ref.row, n.ref.column] : null }))); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(outputs.map(chartFor).map(({ query_id: _q, ...rest }) => rest)).toEqual(c.charts.map(({ query_id: _q, ...rest }: Record<string, unknown>) => rest));
}

describe("browser port matches the Python pipeline", () => {
  it("covers a real number of questions", () => expect(parity.cases.length).toBeGreaterThan(100));
  for (const c of parity.cases) {
    it(`${c.user}: ${c.question}${c.context ? ` (after ${c.context})` : ""}${c.fault ? ` [${c.fault}]` : ""}${Object.keys(c.clarifications).length ? " [clarified]" : ""}`, async () => {
      await runCase(c);
    });
  }
});
