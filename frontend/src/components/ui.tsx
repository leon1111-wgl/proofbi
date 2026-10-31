import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun, X } from "lucide-react";
import type { Cell, ColumnMeta } from "../types";

// ---------------------------------------------------------------- formatting
// Same rules as the backend (app/agent/numbers.py), so text, tables and charts agree.
// `wan` forces one scale for a whole column (see columnUsesWan) instead of deciding per value.
export function formatValue(value: Cell | undefined, format: string, unit = "", wan?: boolean): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (format === "currency") {
    return (wan ?? Math.abs(value) >= 1e5)
      ? `${(value / 1e4).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 万元`
      : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`;
  }
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "integer") {
    const text = Math.round(value).toLocaleString("en-US");
    return unit ? `${text} ${unit}` : text;
  }
  if (format === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(value);
}

export function columnUsesWan(values: Cell[]): boolean {
  return values.some((v) => typeof v === "number" && Math.abs(v) >= 1e5);
}

export function formatCell(value: Cell, meta?: ColumnMeta, wan?: boolean): string {
  if (!meta) return value === null ? "—" : String(value);
  return formatValue(value, meta.role === "dimension" ? "text" : meta.format, meta.unit, wan);
}

/** Compact axis ticks: 0 / 20万 / 40万, 0% / 5% / 10%, 0 / 1K / 2K. */
export function formatTick(value: number, format: string): string {
  if (format === "percent") return `${Math.round(value * 1000) / 10}%`;
  if (format === "currency" && Math.abs(value) >= 1e4) return `${+(value / 1e4).toFixed(1)}万`;
  if (Math.abs(value) >= 1000) return `${+(value / 1000).toFixed(1)}K`;
  return `${+value.toFixed(2)}`;
}

export const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${+v.toFixed(1)} ms`);
export const short = (hash: string | null | undefined, n = 12) => (hash ? hash.slice(0, n) : "—");
const pad = (n: number) => String(n).padStart(2, "0");

export function time(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const seconds = (now.getTime() - d.getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return "刚刚";
  if (seconds >= 0 && seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return `今天 ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function fullTime(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
}

// ---------------------------------------------------------------- badges
const RUN_STATUS: Record<string, [string, string]> = {
  answered: ["已回答", "badge-success"],
  clarify: ["待澄清", "badge-info"],
  refused: ["已拒答", "badge-warning"],
  failed: ["失败", "badge-danger"],
  ok: ["成功", "badge-success"],
  rejected: ["校验未过", "badge-warning"],
  lint: ["口径不一致", "badge-warning"],
  error: ["执行报错", "badge-warning"],
  security: ["安全拦截", "badge-danger"],
  retry: ["重试", "badge-warning"],
};

export function StatusBadge({ status }: { status: string }) {
  const [text, cls] = RUN_STATUS[status] ?? [status, ""];
  return <span className={`badge ${cls}`}>{text}</span>;
}

export function VerdictBadge({ verdict, counts }: { verdict?: string | null; counts?: { verified: number; derived: number; unverified: number } }) {
  if (!verdict) return <span className="faint">—</span>;
  if (verdict === "none") return <span className="badge">无数字</span>;
  const total = counts ? counts.verified + counts.derived + counts.unverified : 0;
  if (verdict === "pass")
    return (
      <span className="badge badge-success" title="答案中的数字都能在查询结果中找到">
        数字已核对{counts ? ` ${total}/${total}` : ""}
      </span>
    );
  return (
    <span className="badge badge-danger" title="有数字在查询结果中找不到">
      {counts ? `${counts.unverified} 个数字无法核对` : "有数字无法核对"}
    </span>
  );
}

// ---------------------------------------------------------------- layout pieces
export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      // keep keyboard focus inside the drawer while it is open
      const items = panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), select, input, textarea');
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" ref={panel}>
        <div className="card-head drawer-head">
          <div style={{ minWidth: 0 }}>{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" ref={close}>
            <X size={18} />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ error }: { error: string | null }) {
  return error ? <div className="error-banner">{error}</div> : null;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json mono">{JSON.stringify(value, null, 2)}</pre>;
}

const SQL_KEYWORDS = new Set(
  "SELECT FROM WHERE JOIN LEFT INNER ON AND OR NOT IN IS NULL GROUP BY ORDER LIMIT OFFSET AS CASE WHEN THEN ELSE END BETWEEN DISTINCT HAVING UNION ALL WITH DESC ASC LIKE EXISTS".split(" "),
);
const SQL_TOKEN = /('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z_0-9]*)|(\s+)|(.)/g;

/** Keyword / string / number highlighting as React text nodes (never innerHTML). */
export function highlightSql(text: string, counter: { n: number }): ReactNode[] {
  const tokens: ReactNode[] = [];
  for (const m of text.matchAll(SQL_TOKEN)) {
    const [tok, str, num, word] = m;
    if (str) tokens.push(<span key={counter.n++} className="str">{tok}</span>);
    else if (num) tokens.push(<span key={counter.n++} className="numlit">{tok}</span>);
    else if (word && SQL_KEYWORDS.has(word.toUpperCase())) tokens.push(<span key={counter.n++} className="kw">{tok}</span>);
    else tokens.push(tok);
  }
  return tokens;
}

/** Read-only SQL with light highlighting. Built from text nodes only (no innerHTML).
 * When `highlight` marks row-policy conditions, the block scrolls to the first one. */
export function SqlBlock({ sql, highlight }: { sql: string; highlight?: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const pre = ref.current;
    const mark = pre?.querySelector(".policy");
    if (pre && mark) pre.scrollTop += mark.getBoundingClientRect().top - pre.getBoundingClientRect().top - 72;
  }, [sql, highlight?.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts: ReactNode[] = [];
  const marks = (highlight ?? []).filter(Boolean);
  let rest = sql;
  let key = 0;
  // split around policy predicates first, so the RLS rewrite stands out
  const segments: { text: string; policy: boolean }[] = [];
  while (rest.length) {
    let best = -1;
    let found = "";
    for (const m of marks) {
      const i = rest.indexOf(m);
      if (i !== -1 && (best === -1 || i < best)) {
        best = i;
        found = m;
      }
    }
    if (best === -1) {
      segments.push({ text: rest, policy: false });
      break;
    }
    if (best > 0) segments.push({ text: rest.slice(0, best), policy: false });
    segments.push({ text: found, policy: true });
    rest = rest.slice(best + found.length);
  }
  const counter = { n: 0 };
  for (const seg of segments) {
    const tokens = highlightSql(seg.text, counter);
    parts.push(seg.policy ? <span key={key++} className="policy" title="行级权限改写加入的条件">{tokens}</span> : <span key={key++}>{tokens}</span>);
  }
  return (
    <pre className="sql" ref={ref}>
      {parts}
    </pre>
  );
}

/** Three lineage nodes joined by an orthogonal edge: question → SQL → row. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="logo">
      <rect width="24" height="24" rx="4" fill="var(--primary)" />
      <path d="M6.5 7h5.5v10h5.5" fill="none" stroke="var(--on-primary)" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="6.5" cy="7" r="2.1" fill="var(--on-primary)" />
      <circle cx="12" cy="12" r="1.7" fill="var(--primary)" stroke="var(--on-primary)" strokeWidth="1.4" />
      <rect x="15.4" y="14.9" width="4.2" height="4.2" rx="0.8" fill="var(--on-primary)" />
    </svg>
  );
}

export function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = { system: "跟随系统", light: "浅色", dark: "深色" }[theme];
  return (
    <button className="icon-btn" title={`主题：${label}（点击切换）`} aria-label={`切换主题，当前：${label}`} onClick={() => setTheme(next)}>
      {theme === "light" ? <Sun size={16} /> : theme === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
    </button>
  );
}

// ---------------------------------------------------------------- hooks
type Theme = "system" | "light" | "dark";
const THEME_KEY = "proofbi.theme";

function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function initTheme() {
  try {
    applyTheme((localStorage.getItem(THEME_KEY) as Theme) || "system");
  } catch {
    /* storage unavailable: follow the system */
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  const update = useCallback((t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);
  return [theme, update];
}

/** Load data with loading / error state and a reload function. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
