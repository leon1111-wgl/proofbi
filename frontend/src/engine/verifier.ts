/* Port of backend/app/agent/verifier.py: every number in an answer must come from a query result.
 * verified = equals a result cell; derived = a disclosed calculation over one column; anything
 * else is unverified and flagged red. */
import { candidates, extractNumbers, money, type NumberMention } from "./numbers";

const MAX_ROWS_FOR_DERIVED = 50;
export type Cell = number | string | null;
export interface ResultTable { query_id: string; columns: string[]; rows: Cell[][]; labels: Record<string, string> }
export interface CellRef { query_id: string; row: number; column: string; label: string; value: Cell }
export interface NumberCheck {
  text: string; start: number; end: number; value: number; unit: string; status: "verified" | "derived" | "unverified";
  ref: CellRef | null; refs: CellRef[]; formula: string | null;
}
export interface VerificationReport { verdict: "pass" | "fail" | "none"; counts: { verified: number; derived: number; unverified: number }; numbers: NumberCheck[] }

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
const numericColumns = (t: ResultTable) => t.columns.map((_, i) => i).filter((i) => t.rows.some((r) => typeof r[i] === "number"));
const cellRef = (t: ResultTable, row: number, col: number): CellRef => {
  const name = t.columns[col];
  return { query_id: t.query_id, row, column: name, label: t.labels[name] ?? name, value: t.rows[row][col] };
};

function direct(m: NumberMention, tables: ResultTable[]): CellRef | null {
  for (const [value, tol] of candidates(m)) {
    for (const t of tables) {
      for (const col of numericColumns(t)) {
        for (let r = 0; r < t.rows.length; r++) {
          const cell = t.rows[r][col];
          if (typeof cell === "number" && close(cell, value, tol)) return cellRef(t, r, col);
        }
      }
    }
  }
  return null;
}

function derived(m: NumberMention, tables: ResultTable[]): [string, CellRef[]] | null {
  const half = 0.5 * 10 ** -m.decimals;
  for (const t of tables) {
    if (t.rows.length > MAX_ROWS_FOR_DERIVED) continue;
    for (const col of numericColumns(t)) {
      const cells = t.rows.map((row, r) => [r, row[col]] as const).filter(([, v]) => typeof v === "number") as [number, number][];
      const name = t.columns[col];
      const label = t.labels[name] ?? name;
      const total = cells.reduce((s, [, v]) => s + v, 0);
      for (let i = 0; i < cells.length; i++) {
        for (let j = 0; j < cells.length; j++) {
          if (i === j) continue;
          const [ra, a] = cells[i], [rb, b] = cells[j];
          const refs = [cellRef(t, ra, col), cellRef(t, rb, col)];
          if (m.unit === "%" && a) {
            if (close(Math.abs((b - a) / a), Math.abs(m.value) / 100, half / 100)) return [`变化率 = (${label} B − A) ÷ A`, refs];
          }
          if (m.unit === "pp") {
            if (close(Math.abs(b - a) * 100, Math.abs(m.value), half)) return [`百分点差 = (${label} B − A) × 100`, refs];
          }
          if (m.unit === "" || m.unit === "万" || m.unit === "亿") {
            const scale = { "": 1, 万: 1e4, 亿: 1e8 }[m.unit]!;
            if (close(Math.abs(b - a), Math.abs(m.value) * scale, half * scale) && m.value !== 0) return [`差值 = ${label} B − A`, refs];
          }
        }
      }
      if (m.unit === "%" && total) {
        for (const [r, v] of cells) {
          if (close(v / total, m.value / 100, half / 100)) return [`占比 = ${label} ÷ 列合计 ${money(total)}`, [cellRef(t, r, col)]];
        }
      }
      if ((m.unit === "" || m.unit === "万" || m.unit === "亿") && cells.length > 1) {
        const scale = { "": 1, 万: 1e4, 亿: 1e8 }[m.unit]!;
        if (close(total, m.value * scale, half * scale)) return [`合计 = ${label} 列求和`, cells.map(([r]) => cellRef(t, r, col))];
      }
    }
    if (m.unit === "" && m.decimals === 0 && m.value === t.rows.length && t.rows.length > 1) return [`行数 = ${t.query_id} 结果行数`, []];
  }
  return null;
}

/** A sentence that states shares: check a percentage as a share first, so a coincidence with some change rate cannot label it. */
function asShare(m: NumberMention, tables: ResultTable[]): [string, CellRef[]] | null {
  if (m.unit !== "%") return null;
  const half = 0.5 * 10 ** -m.decimals;
  for (const t of tables) {
    for (const col of numericColumns(t)) {
      const cells = t.rows.map((row, r) => [r, row[col]] as const).filter(([, v]) => typeof v === "number") as [number, number][];
      const total = cells.reduce((s, [, v]) => s + v, 0);
      if (!total) continue;
      const name = t.columns[col];
      for (const [r, v] of cells) {
        if (close(v / total, m.value / 100, half / 100)) return [`占比 = ${t.labels[name] ?? name} ÷ 列合计 ${money(total)}`, [cellRef(t, r, col)]];
      }
    }
  }
  return null;
}

export function verifyAnswer(text: string, tables: ResultTable[], extraLabels: string[] = [], opts: { shares?: boolean } = {}): VerificationReport {
  const labels = [...extraLabels, ...tables.flatMap((t) => t.rows.flatMap((row) => row.filter((c): c is string => typeof c === "string")))];
  const numbers: NumberCheck[] = [];
  for (const m of extractNumbers(text, labels)) {
    const base = { text: m.text, start: m.start, end: m.end, value: m.value, unit: m.unit };
    const share = opts.shares ? asShare(m, tables) : null;
    if (share) {
      numbers.push({ ...base, status: "derived", formula: share[0], refs: share[1], ref: share[1][0] ?? null });
      continue;
    }
    const ref = direct(m, tables);
    if (ref) {
      numbers.push({ ...base, status: "verified", ref, refs: [ref], formula: null });
      continue;
    }
    const d = derived(m, tables);
    if (d) {
      numbers.push({ ...base, status: "derived", formula: d[0], refs: d[1], ref: d[1][0] ?? null });
      continue;
    }
    numbers.push({ ...base, status: "unverified", ref: null, refs: [], formula: null });
  }
  const counts = { verified: 0, derived: 0, unverified: 0 };
  for (const n of numbers) counts[n.status]++;
  return { verdict: numbers.length === 0 ? "none" : counts.unverified ? "fail" : "pass", counts, numbers };
}
