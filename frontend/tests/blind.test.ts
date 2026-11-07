/* The blind set in backend/evals/blind/cases.jsonl, through the real path (planner, SQL, guard, row policies,
 * SQLite WASM, narrator, verifier). BLIND_REPORT=<path> writes the per-case results. */
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ask, newConvo } from "./helpers";
import { score, totals, type BlindCase } from "./scoring";

const cases: BlindCase[] = readFileSync(new URL("../../backend/evals/blind/cases.jsonl", import.meta.url), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Floors, set after the first run and its one round of fixes: see docs/EVALUATION.md. Not blind any more.
const FLOOR = JSON.parse(readFileSync(new URL("./blind-floor.json", import.meta.url), "utf-8")) as { correct: number; wrong: number };

it("blind set", async () => {
  const rows = [];
  for (const c of cases) {
    const convo = newConvo();
    let run = null;
    let last = "";
    for (const turn of c.turns) {
      const q = turn.q ?? last;
      run = await ask(c.user, q, convo, turn.choice);
      last = q;
    }
    const s = score(c, run!);
    rows.push({ id: c.id, category: c.category, user: c.user, question: c.turns.map((t) => t.q ?? "(按钮)").join(" → "), security_case: Boolean(c.expect.security), ...s, status: run!.status, answer: run!.answer?.text ?? run!.refusal?.message ?? run!.clarification?.term ?? null });
  }
  const byCategory: Record<string, ReturnType<typeof totals>> = {};
  for (const cat of new Set(rows.map((r) => r.category))) byCategory[cat] = totals(rows.filter((r) => r.category === cat));
  const report = { totals: totals(rows), by_category: byCategory, rows };
  if (process.env.BLIND_REPORT) writeFileSync(process.env.BLIND_REPORT, JSON.stringify(report, null, 1));
  expect(report.totals.security_wrong).toBe(0);
  expect(report.totals.wrong).toBeLessThanOrEqual(FLOOR.wrong);
  expect(report.totals.correct).toBeGreaterThanOrEqual(FLOOR.correct);
});
