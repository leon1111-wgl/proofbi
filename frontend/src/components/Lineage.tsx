import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { CellRef, NumberCheck, PlanView, QueryView } from "../types";
import { columnUsesWan, formatCell, highlightSql } from "./ui";

export type LineageQuery = Pick<QueryView, "query_id" | "key" | "title" | "sql" | "columns" | "column_meta" | "rows" | "row_count">;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Cells a number points at: one for a verified number, several for a derived one, none when unverified. */
export function numberRefs(n: NumberCheck | null): CellRef[] {
  if (!n) return [];
  return n.refs.length ? n.refs : n.ref ? [n.ref] : [];
}

const parenDelta = (line: string) => (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);

/** Lines of the SELECT item that produces `column` in pretty-printed SQL. Walks up from the
 * `AS column` line until the parentheses balance and the previous line ends an item. */
function exprLines(lines: string[], column?: string): [number, number] | null {
  if (!column) return null;
  const re = new RegExp(`\\bAS ${escapeRe(column)}\\b`);
  const end = lines.findIndex((l) => re.test(l));
  if (end === -1) return null;
  let start = end;
  let depth = parenDelta(lines[end]);
  while (start > 0) {
    const prev = lines[start - 1].trim();
    if (depth >= 0 && (prev === "" || prev.endsWith(",") || /^SELECT\b/i.test(prev))) break;
    start -= 1;
    depth += parenDelta(lines[start]);
  }
  return [start, end];
}

/** The SQL with the metric's filter marked inline and the producing SELECT item banded. */
function LineageSql({ sql, column, filter }: { sql: string; column?: string; filter?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const lines = sql.split("\n");
  const band = exprLines(lines, column);
  const parts = filter ? [filter, ...filter.split(/\s+AND\s+/i)].filter((p, i, all) => p && all.indexOf(p) === i) : [];
  useEffect(() => {
    const pre = ref.current;
    const first = pre?.querySelector<HTMLElement>(".is-expr");
    if (pre && first) pre.scrollTo({ top: Math.max(0, first.offsetTop - first.offsetHeight - 8), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [sql, column]);
  const key = { n: 0 };
  return (
    <pre className="ln-sql" ref={ref} tabIndex={0} aria-label="生成这个数字的 SQL">
      {lines.map((line, i) => {
        const hit = parts.map((p) => [p, line.indexOf(p)] as const).find(([, at]) => at !== -1);
        const inBand = band !== null && i >= band[0] && i <= band[1];
        return (
          <span key={i} className={`ln-line${inBand ? " is-expr" : ""}`}>
            {hit ? (
              <>
                {highlightSql(line.slice(0, hit[1]), key)}
                <mark className="ln-filter">{highlightSql(hit[0], key)}</mark>
                {highlightSql(line.slice(hit[1] + hit[0].length), key)}
              </>
            ) : (
              highlightSql(line, key)
            )}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function LineageRows({ query, lit }: { query: LineageQuery; lit: CellRef[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const metas = query.columns.map((c) => query.column_meta.find((m) => m.key === c));
  const wan = query.columns.map((_, i) => columnUsesWan(query.rows.map((r) => r[i])));
  const isLit = (row: number, col: string) => lit.some((c) => c.query_id === query.query_id && c.row === row && c.column === col);
  const firstRow = lit.find((c) => c.query_id === query.query_id)?.row;
  useEffect(() => {
    const box = ref.current;
    const row = box?.querySelector<HTMLElement>(`tr[data-row="${firstRow}"]`);
    const head = box?.querySelector("thead")?.offsetHeight ?? 0;
    // keep one full row visible above the lit one, below the sticky header
    if (box && row) box.scrollTo({ top: Math.max(0, row.offsetTop - head - row.offsetHeight), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [query.query_id, firstRow]);
  return (
    <div className="ln-rows" ref={ref} tabIndex={0} aria-label="查询结果行">
      <table>
        <thead>
          <tr>
            <th className="ln-rn">#</th>
            {query.columns.map((c, i) => (
              <th key={c} className={metas[i]?.role === "dimension" ? "" : "num"}>
                {metas[i]?.label ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {query.rows.map((row, r) => (
            <tr key={r} data-row={r} className={query.columns.some((c) => isLit(r, c)) ? "is-lit" : ""}>
              <td className="ln-rn">{r}</td>
              {row.map((cell, i) => (
                <td key={i} className={`${metas[i]?.role === "dimension" ? "" : "num"}${isLit(r, query.columns[i]) ? " is-cell" : ""}`}>
                  {formatCell(cell, metas[i], wan[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Node({ k, title, lit, area, children, aside }: { k: string; title: string; lit: "" | "lit" | "broken"; area: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`ln-node ln-${area}`} data-lit={lit || undefined}>
      <header className="ln-head">
        <span className="ln-key" aria-hidden="true">{k}</span>
        <span className="ln-title">{title}</span>
        {aside}
      </header>
      <div className="ln-body">{children}</div>
    </section>
  );
}

/**
 * Data lineage of one answer: question → metric → SQL → result rows.
 * The number in `active` lights its path; an unverified number shows where the chain breaks.
 */
export function Lineage({
  question,
  time,
  metrics,
  queries,
  active,
  onOpen,
}: {
  question: string;
  time?: PlanView["time"] | null;
  metrics: PlanView["metrics"];
  queries: LineageQuery[];
  active: NumberCheck | null;
  onOpen?: (n: NumberCheck) => void;
}) {
  const refs = numberRefs(active);
  const query = queries.find((q) => q.query_id === refs[0]?.query_id) ?? queries[0];
  const column = refs[0]?.column;
  const metric = active ? (metrics.find((m) => m.key === column) ?? metrics.find((m) => query?.columns.includes(m.key)) ?? metrics[0]) : undefined;
  const broken = active?.status === "unverified";
  const lit = active ? "lit" : "";
  if (!query) return null;

  return (
    <div className="lineage-wrap">
      <figure className="lineage" data-state={active ? (broken ? "broken" : "lit") : "idle"} aria-label="数字血缘：问题、指标、SQL、结果行">
        <Node k="Q" title="问题" area="q" lit={lit}>
          <p className="ln-question">{question}</p>
          {time && (
            <span className="ln-chip mono">
              {time.label} · {time.start} 至 {time.end}
            </span>
          )}
        </Node>
        <Node k="M" title="语义层指标" area="m" lit={lit}>
          <div className="ln-metrics">
            {metrics.map((m) => (
              <span key={m.key} className={`ln-metric${metric?.key === m.key ? " is-on" : ""}`} title={m.description}>
                {m.label}
                <span className="mono">{m.key}</span>
              </span>
            ))}
          </div>
          <code className="ln-where">WHERE {(metric ?? metrics[0])?.filter}</code>
        </Node>
        <Node k="S" title="SQL" area="s" lit={lit} aside={<span className="ln-aside mono">{query.key}</span>}>
          <LineageSql sql={query.sql} column={column} filter={(metric ?? metrics[0])?.filter} />
        </Node>
        <Node
          k="R"
          title="结果行"
          area="r"
          lit={broken ? "broken" : lit}
          aside={<span className="ln-aside mono">{query.row_count} 行 · {query.title}</span>}
        >
          <LineageRows query={query} lit={refs} />
          <div className="ln-status" aria-live="polite">
            {!active && <span className="faint">把鼠标移到回答里的数字上（或用 Tab 聚焦），点亮它从问题到结果行的路径。</span>}
            {active?.status === "verified" && active.ref && (
              <span>
                <b className="ln-ok">{active.text}</b> 与第 {active.ref.row} 行「{active.ref.label}」一致
              </span>
            )}
            {active?.status === "derived" && (
              <span>
                <b className="ln-derived">{active.text}</b> 由 {refs.length} 个单元格推算：{active.formula}
              </span>
            )}
            {broken && (
              <span className="ln-bad">
                <b>{active!.text}</b> 在结果行里找不到：链路在这里断开，可能是模型编造的数字
              </span>
            )}
            {active && !broken && onOpen && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => onOpen(active)}>
                完整溯源 <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        </Node>
      </figure>
    </div>
  );
}
