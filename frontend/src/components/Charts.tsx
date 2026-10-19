/* Charts drawn from query rows. Every mark is a way into the evidence: clicking a bar,
   a point or a tile opens the provenance drawer at the row behind it. Specs: bars at most
   24px thick with a 4px rounded data end, 2px lines, end dots with a 2px surface ring,
   hairline grids, one categorical order (series-1..8) that never depends on rank, and a
   table view for every chart. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Cell, Chart, ColumnMeta, QueryView } from "../types";
import { columnUsesWan, formatCell, formatTick, formatValue } from "./ui";

export type CellHandler = (queryId: string, row: number, column: string) => void;

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const LOWER_IS_BETTER = new Set(["refund_rate", "refund_amount", "refunded_orders"]);

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(280, entries[0].contentRect.width)));
    observer.observe(el);
    setWidth(Math.max(280, el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Axis from 0 with a round step (1 / 2 / 2.5 / 5 × 10^k) and about four intervals. */
function niceScale(maxValue: number, target = 4): { max: number; ticks: number[] } {
  if (!(maxValue > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = maxValue / target;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  const count = Math.max(1, Math.ceil(maxValue / step - 1e-9));
  return { max: count * step, ticks: Array.from({ length: count + 1 }, (_, i) => +(i * step).toPrecision(12)) };
}

/** Bar with a 4px rounded data end and a square end at the baseline. */
function barPath(x0: number, y: number, w: number, h: number, r = 4): string {
  if (w <= r) return `M${x0},${y}h${Math.max(w, 1)}v${h}h${-Math.max(w, 1)}Z`;
  const x1 = x0 + w;
  return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { color: string; label: string; value: string }[];
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
      <div className="tt-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div className="tt-row" key={i}>
          <span className="tt-key" style={{ background: r.color }} />
          <b>{r.value}</b>
          <span className="muted">{r.label}</span>
        </div>
      ))}
      <div className="faint" style={{ marginTop: 4 }}>点击查看来源行</div>
    </div>
  );
}

function metaOf(query: QueryView, key?: string): ColumnMeta | undefined {
  return query.column_meta.find((m) => m.key === key);
}

function col(query: QueryView, key?: string): number {
  return key ? query.columns.indexOf(key) : -1;
}

function seriesOrder(values: Cell[], kind?: string): string[] {
  const unique = Array.from(new Set(values.map((v) => String(v))));
  // periods: earlier first (the latest is the period being asked about)
  return kind === "period" ? unique.sort() : unique.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

// ---------------------------------------------------------------- bar
function BarChart({ query, chart, onCell }: { query: QueryView; chart: Chart; onCell: CellHandler }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const xi = col(query, chart.x);
  const yi = col(query, chart.y);
  const si = col(query, chart.series);
  const yMeta = metaOf(query, chart.y);
  const fmt = yMeta?.format ?? "number";

  const series = si >= 0 ? seriesOrder(query.rows.map((r) => r[si]), chart.series) : [""];
  const categories = useMemo(() => {
    const cats = Array.from(new Set(query.rows.map((r) => String(r[xi]))));
    if (si < 0) return cats; // single series: keep the query's own order (ranking, top N)
    // grouped by period: order by the latest period's value, largest first
    const latest = series[series.length - 1];
    const valueOf = (c: string) => Number(query.rows.find((r) => String(r[xi]) === c && String(r[si]) === latest)?.[yi] ?? 0);
    return cats.sort((a, b) => valueOf(b) - valueOf(a));
  }, [query.rows, xi, si, yi, series.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  // a period comparison is emphasis, not identity: the period asked about in the brand
  // colour, the comparison period in grey
  const colorFor = (i: number) =>
    chart.series === "period" ? (i === series.length - 1 ? SERIES[0] : "var(--series-muted)") : SERIES[i % 8];

  const labelW = Math.min(150, Math.max(...categories.map((c) => c.length)) * 12 + 12);
  const valueW = 92;
  const plotW = Math.max(80, width - labelW - valueW);
  const barH = series.length > 1 ? 10 : 16;
  const rowH = series.length * barH + (series.length - 1) * 2 + 14;
  const height = categories.length * rowH + 22;
  const { max, ticks } = niceScale(Math.max(0, ...query.rows.map((r) => Number(r[yi]) || 0)));
  const scale = (v: number) => (Math.max(0, v) / max) * plotW;
  const wan = columnUsesWan(query.rows.map((r) => r[yi]));

  return (
    <div ref={ref} style={{ position: "relative" }} onMouseLeave={() => setTip(null)}>
      {series.length > 1 && (
        <div className="legend" style={{ marginBottom: 8 }}>
          {series.map((s, i) => (
            <span key={s}>
              <span className="key" style={{ background: colorFor(i) }} />
              {s}
              {chart.series === "period" && i === series.length - 1 ? "（本期）" : ""}
            </span>
          ))}
        </div>
      )}
      <svg className="chart-svg" width={width} height={height} role="img" aria-label={`${yMeta?.label ?? ""}条形图`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={labelW + scale(t)} x2={labelW + scale(t)} y1={0} y2={height - 20} />
            <text x={labelW + scale(t)} y={height - 6} textAnchor="middle">
              {formatTick(t, fmt)}
            </text>
          </g>
        ))}
        <line className="axis" x1={labelW} x2={labelW} y1={0} y2={height - 20} />
        {categories.map((cat, ci) => {
          const y0 = ci * rowH + 7;
          return (
            <g key={cat}>
              <text className="cat" x={labelW - 8} y={y0 + (rowH - 14) / 2 + 4} textAnchor="end">
                {cat.length > 11 ? `${cat.slice(0, 10)}…` : cat}
              </text>
              {series.map((s, sIdx) => {
                const rowIndex = query.rows.findIndex((r) => String(r[xi]) === cat && (si < 0 || String(r[si]) === s));
                if (rowIndex < 0) return null;
                const value = Number(query.rows[rowIndex][yi]) || 0;
                const y = y0 + sIdx * (barH + 2);
                const w = scale(value);
                const text = formatValue(value, fmt, yMeta?.unit, wan);
                const show = (clientX: number, clientY: number) => {
                  const box = ref.current?.getBoundingClientRect();
                  setTip({
                    x: Math.min(clientX - (box?.left ?? 0) + 12, width - 180),
                    y: clientY - (box?.top ?? 0) + 12,
                    title: s ? `${cat} · ${s}` : cat,
                    rows: [{ color: colorFor(sIdx), label: yMeta?.label ?? "", value: text }],
                  });
                };
                return (
                  <g key={s}>
                    <path
                      className="bar"
                      d={barPath(labelW, y, w, barH)}
                      fill={colorFor(sIdx)}
                      tabIndex={0}
                      role="button"
                      aria-label={`${cat} ${s} ${text}`}
                      onMouseMove={(e) => show(e.clientX, e.clientY)}
                      onFocus={(e) => {
                        const r = (e.target as SVGPathElement).getBoundingClientRect();
                        show(r.right, r.top);
                      }}
                      onBlur={() => setTip(null)}
                      onClick={() => onCell(query.query_id, rowIndex, chart.y!)}
                      onKeyDown={(e) => e.key === "Enter" && onCell(query.query_id, rowIndex, chart.y!)}
                    />
                    <text className="val" x={labelW + w + 6} y={y + barH / 2 + 4}>
                      {text}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- line
function LineChart({ query, chart, onCell }: { query: QueryView; chart: Chart; onCell: CellHandler }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const xi = col(query, chart.x);
  const yi = col(query, chart.y);
  const si = col(query, chart.series);
  const yMeta = metaOf(query, chart.y);
  const fmt = yMeta?.format ?? "number";
  const xs = useMemo(() => Array.from(new Set(query.rows.map((r) => String(r[xi])))).sort(), [query.rows, xi]);
  const series = si >= 0 ? seriesOrder(query.rows.map((r) => r[si]), chart.series) : [""];
  const left = 52;
  const right = series.length <= 4 ? 96 : 16;
  const top = 10;
  const height = 220;
  const plotH = height - top - 26;
  const plotW = Math.max(80, width - left - right);
  const { max, ticks } = niceScale(Math.max(0, ...query.rows.map((r) => Number(r[yi]) || 0)) * 1.05);
  const wan = columnUsesWan(query.rows.map((r) => r[yi]));
  const xAt = (i: number) => left + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const yAt = (v: number) => top + plotH - (Math.max(0, v) / max) * plotH;
  const rowAt = (x: string, s: string) => query.rows.findIndex((r) => String(r[xi]) === x && (si < 0 || String(r[si]) === s));
  const labelEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(plotW / 70))));
  const shortX = (x: string) => (x.length === 10 ? x.slice(5) : x);

  const onMove = (e: React.MouseEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = e.clientX - box.left;
    let best = 0;
    xs.forEach((_, i) => {
      if (Math.abs(xAt(i) - px) < Math.abs(xAt(best) - px)) best = i;
    });
    setHover(best);
  };

  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: Math.min(xAt(hover) + 12, width - 190),
          y: top + 8,
          title: xs[hover],
          rows: series
            .map((s, i) => ({ s, i, row: rowAt(xs[hover], s) }))
            .filter((r) => r.row >= 0)
            .map(({ s, i, row }) => ({ color: SERIES[i % 8], label: s || yMeta?.label || "", value: formatValue(query.rows[row][yi], fmt, yMeta?.unit, wan) })),
        };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {series.length > 1 && (
        <div className="legend" style={{ marginBottom: 8 }}>
          {series.map((s, i) => (
            <span key={s}>
              <span className="key line" style={{ background: SERIES[i % 8] }} />
              {s}
            </span>
          ))}
        </div>
      )}
      <svg
        className="chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={`${yMeta?.label ?? ""}折线图`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => {
          if (hover === null) return;
          const row = rowAt(xs[hover], series[0]);
          if (row >= 0) onCell(query.query_id, row, chart.y!);
        }}
        style={{ cursor: "pointer" }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={left} x2={left + plotW} y1={yAt(t)} y2={yAt(t)} />
            <text x={left - 8} y={yAt(t) + 4} textAnchor="end">
              {formatTick(t, fmt)}
            </text>
          </g>
        ))}
        <line className="axis" x1={left} x2={left + plotW} y1={top + plotH} y2={top + plotH} />
        {xs.map((x, i) =>
          i % labelEvery === 0 || i === xs.length - 1 ? (
            <text key={x} x={xAt(i)} y={height - 6} textAnchor="middle">
              {shortX(x)}
            </text>
          ) : null,
        )}
        {series.map((s, sIdx) => {
          const pts = xs.map((x, i) => ({ i, row: rowAt(x, s) })).filter((p) => p.row >= 0);
          const d = pts.map((p, k) => `${k ? "L" : "M"}${xAt(p.i)},${yAt(Number(query.rows[p.row][yi]) || 0)}`).join("");
          const last = pts[pts.length - 1];
          const color = SERIES[sIdx % 8];
          return (
            <g key={s}>
              {series.length === 1 && pts.length > 1 && (
                <path d={`${d}L${xAt(last.i)},${top + plotH}L${xAt(pts[0].i)},${top + plotH}Z`} fill={color} opacity={0.1} />
              )}
              <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {last && (
                <>
                  <circle cx={xAt(last.i)} cy={yAt(Number(query.rows[last.row][yi]) || 0)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
                  {series.length <= 4 && (
                    <text className="val" x={xAt(last.i) + 8} y={yAt(Number(query.rows[last.row][yi]) || 0) + 4}>
                      {formatValue(query.rows[last.row][yi], fmt, yMeta?.unit, wan)}
                    </text>
                  )}
                </>
              )}
              {hover !== null && rowAt(xs[hover], s) >= 0 && (
                <circle cx={xAt(hover)} cy={yAt(Number(query.rows[rowAt(xs[hover], s)][yi]) || 0)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
              )}
            </g>
          );
        })}
        {hover !== null && <line className="axis" x1={xAt(hover)} x2={xAt(hover)} y1={top} y2={top + plotH} />}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- tiles
function Tiles({ query, chart, onCell }: { query: QueryView; chart: Chart; onCell: CellHandler }) {
  // the metric first, its components (numerator / denominator) after it
  const keys = [...(chart.items ?? query.column_meta.filter((m) => m.role !== "dimension").map((m) => m.key))].sort(
    (a, b) => Number(metaOf(query, a)?.role === "component") - Number(metaOf(query, b)?.role === "component"),
  );
  const row = query.rows[0] ?? [];
  return (
    <div className="tiles">
      {keys.map((key) => {
        const meta = metaOf(query, key);
        const i = col(query, key);
        return (
          <button key={key} className={`tile ${meta?.role === "metric" ? "primary" : ""}`} onClick={() => onCell(query.query_id, 0, key)} style={{ cursor: "pointer" }}>
            <div className="t-label">{meta?.label ?? key}</div>
            <div className="t-value">{formatValue(row[i], meta?.format ?? "number", meta?.unit)}</div>
            <div className="t-sub">{meta?.role === "component" ? "组成部分" : "点击查看 SQL 与结果行"}</div>
          </button>
        );
      })}
    </div>
  );
}

function CompareTiles({ query, onCell }: { query: QueryView; onCell: CellHandler }) {
  const pi = col(query, "period");
  const periods = query.rows.map((r) => String(r[pi])).sort();
  const prevKey = periods[0];
  const curKey = periods[periods.length - 1];
  const curRow = query.rows.findIndex((r) => String(r[pi]) === curKey);
  const prevRow = query.rows.findIndex((r) => String(r[pi]) === prevKey);
  const metrics = query.column_meta
    .filter((m) => m.role !== "dimension")
    .sort((a, b) => Number(a.role === "component") - Number(b.role === "component"));
  return (
    <div className="tiles">
      {metrics.map((m) => {
        const i = col(query, m.key);
        const wan = columnUsesWan(query.rows.map((r) => r[i]));
        const cur = Number(query.rows[curRow]?.[i]);
        const prev = Number(query.rows[prevRow]?.[i]);
        let delta: ReactNode = null;
        if (Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0) {
          const up = cur > prev;
          const good = LOWER_IS_BETTER.has(m.key) ? !up : up;
          const text =
            m.format === "percent"
              ? `${up ? "+" : "−"}${Math.abs((cur - prev) * 100).toFixed(1)} 个百分点`
              : `${up ? "+" : "−"}${Math.abs(((cur - prev) / prev) * 100).toFixed(1)}%`;
          delta = cur === prev ? <span>持平</span> : <span className={good ? "delta-good" : "delta-bad"}>{text}</span>;
        }
        return (
          <button key={m.key} className={`tile ${m.role === "metric" ? "primary" : ""}`} onClick={() => onCell(query.query_id, curRow, m.key)} style={{ cursor: "pointer" }}>
            <div className="t-label">
              {m.label} · {curKey}
            </div>
            <div className="t-value">{formatValue(query.rows[curRow]?.[i] ?? null, m.format, m.unit, wan)}</div>
            <div className="t-sub">
              {prevKey}：{formatValue(query.rows[prevRow]?.[i] ?? null, m.format, m.unit, wan)} {delta && <>· {delta}</>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- table
export function DataTable({ query, highlight, onCell, maxRows = 200 }: { query: QueryView; highlight?: { row: number; column: string } | null; onCell?: CellHandler; maxRows?: number }) {
  const metas = query.columns.map((c) => metaOf(query, c));
  const wan = query.columns.map((_, i) => columnUsesWan(query.rows.map((r) => r[i])));
  return (
    <div className="table-wrap" style={{ maxHeight: 360 }}>
      <table className="table">
        <thead>
          <tr>
            <th className="num" style={{ width: 44 }}>#</th>
            {query.columns.map((c, i) => (
              <th key={c} className={metas[i]?.role !== "dimension" ? "num" : ""}>
                {metas[i]?.label ?? c}
                <div className="faint mono" style={{ fontWeight: 400 }}>{c}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {query.rows.slice(0, maxRows).map((row, r) => (
            <tr key={r} className={highlight?.row === r ? "hl" : ""}>
              <td className="num faint">{r}</td>
              {row.map((cell, c) => {
                const numeric = metas[c]?.role !== "dimension" && typeof cell === "number";
                const isHl = highlight?.row === r && highlight.column === query.columns[c];
                return (
                  <td
                    key={c}
                    className={`${numeric ? "num" : ""} ${isHl ? "cell-hl" : ""}`}
                    onClick={numeric && onCell ? () => onCell(query.query_id, r, query.columns[c]) : undefined}
                    style={numeric && onCell ? { cursor: "pointer" } : undefined}
                    title={numeric ? String(cell) : undefined}
                  >
                    {formatCell(cell, metas[c], wan[c])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {query.rows.length > maxRows && <div className="faint" style={{ padding: 8 }}>只显示前 {maxRows} 行（共 {query.row_count} 行）</div>}
    </div>
  );
}

// ---------------------------------------------------------------- block
export function ChartBlock({ query, chart, onCell }: { query: QueryView; chart: Chart; onCell: CellHandler }) {
  const [view, setView] = useState<"chart" | "table">(chart.type === "table" ? "table" : "chart");
  const yMeta = metaOf(query, chart.y);
  const xMeta = metaOf(query, chart.x);
  const title =
    chart.type === "kpi" || chart.type === "compare"
      ? query.title
      : `${yMeta?.label ?? query.title}${xMeta ? ` · 按${xMeta.label}` : ""}`;
  let body: ReactNode;
  if (view === "table" || chart.type === "table") body = <DataTable query={query} onCell={onCell} />;
  else if (chart.type === "kpi") body = <Tiles query={query} chart={chart} onCell={onCell} />;
  else if (chart.type === "compare") body = <CompareTiles query={query} onCell={onCell} />;
  else if (chart.type === "bar") body = <BarChart query={query} chart={chart} onCell={onCell} />;
  else body = <LineChart query={query} chart={chart} onCell={onCell} />;
  return (
    <div className="chart-block">
      <div className="chart-head">
        <span className="chart-title">
          {title}
          <span className="faint" style={{ marginLeft: 8 }}>
            {query.key} · {query.row_count} 行{query.truncated ? "（已截断）" : ""}
          </span>
        </span>
        {chart.type !== "table" && (
          <div className="segmented" role="tablist" aria-label="展示方式">
            <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
              图表
            </button>
            <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
              表格
            </button>
          </div>
        )}
      </div>
      <div className="chart-body">{body}</div>
    </div>
  );
}
