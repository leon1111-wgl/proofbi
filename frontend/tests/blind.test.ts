/* The blind set in backend/evals/blind/cases.jsonl, through the real path (planner, SQL, guard, row policies,
 * SQLite WASM, narrator, verifier). BLIND_REPORT=<path> writes the per-case results. */
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ask, newConvo } from "./helpers";
import { score, totals, type BlindCase } from "./scoring";

const cases: BlindCase[] = readFileSync(new URL("../../backend/evals/blind/cases.jsonl", import.meta.url), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The page shows these numbers, so a change in the score must change them too. The set is seen by now:
// see docs/EVALUATION.md. BLIND_UPDATE=1 rewrites them after an intended change.
const REPORT_URL = new URL("../src/engine/blind-report.json", import.meta.url);
const shown = JSON.parse(readFileSync(REPORT_URL, "utf-8"));

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
  if (process.env.BLIND_UPDATE) {
    shown.after_fixes.totals = report.totals;
    writeFileSync(REPORT_URL, JSON.stringify(shown, null, 1) + "\n");
    return;
  }
  expect(report.totals).toEqual(shown.after_fixes.totals);
});
