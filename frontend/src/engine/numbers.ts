/* Port of backend/app/agent/numbers.py: one set of formatting rules for text, tables and charts. */

/** Python's format(x, ".Nf"): correct rounding with ties to even. JS toFixed rounds ties up. */
export function fixed(x: number, decimals: number): string {
  const long = Math.abs(x).toFixed(Math.min(decimals + 60, 100));
  const dot = long.indexOf(".");
  const tail = long.slice(dot + 1 + decimals);
  const isTie = /^50*$/.test(tail);
  if (!isTie) return x.toFixed(decimals);
  const keep = long.slice(0, dot + 1 + decimals);
  const lastDigit = Number(keep.replace(".", "").slice(-1));
  if (lastDigit % 2 === 0) return (x < 0 ? "-" : "") + (decimals === 0 ? keep.replace(".", "") : keep);
  return x.toFixed(decimals);
}
const group = (text: string) => {
  const [int, frac] = text.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
};
/** Python's f"{x:,.2f}". */
export const money = (x: number) => group(fixed(x, 2));
/** Python's round(): ties to even. */
const pyRound = (x: number) => Number(fixed(x, 0));

export function formatValue(value: unknown, fmt: string, unit = "", wan: boolean | null | undefined = null): string {
  if (value === null || value === undefined) return "—";
  if (fmt === "currency") {
    const v = Number(value);
    const useWan = wan === null || wan === undefined ? Math.abs(v) >= 1e5 : wan;
    return useWan ? `${group(fixed(v / 1e4, 2))} 万元` : `${group(fixed(v, 2))} 元`;
  }
  if (fmt === "percent") return `${fixed(Number(value) * 100, 1)}%`;
  if (fmt === "integer") {
    const text = group(String(pyRound(Number(value))));
    return unit ? `${text} ${unit}` : text;
  }
  if (fmt === "number") return group(fixed(Number(value), 2));
  return String(value);
}

export const columnUsesWan = (values: unknown[]) => values.some((v) => typeof v === "number" && Math.abs(v) >= 1e5);

export interface NumberMention { text: string; start: number; end: number; value: number; decimals: number; unit: string }

export function candidates(m: NumberMention): [number, number][] {
  const half = 0.5 * 10 ** -m.decimals;
  if (m.unit === "%") return [[m.value / 100, half / 100], [m.value, half]];
  if (m.unit === "万") return [[m.value * 1e4, half * 1e4]];
  if (m.unit === "亿") return [[m.value * 1e8, half * 1e8]];
  return [[m.value, half]];
}

const MASKS = [
  "\\d{4}-\\d{1,2}-\\d{1,2}(?:\\s*~\\s*\\d{4}-\\d{1,2}-\\d{1,2})?",
  "\\d{4}-Q[1-4]",
  "\\d{4}-\\d{2}(?!\\d)",
  "\\d{4}\\s*年(?:\\s*第?\\s*\\d{1,2}\\s*(?:季度|月))?(?:\\s*\\d{1,2}\\s*日)?",
  "\\d{1,2}\\s*月(?:\\s*\\d{1,2}\\s*日)?",
  "\\d{1,2}\\s*日",
  "[Qq][1-4]",
  "第\\s*\\d+",
  "(?:前|后|[Tt][Oo][Pp])\\s*\\d+",
  "近\\s*\\d+\\s*(?:天|日|周|个月|年)",
  "\\d+\\s*(?:天|个月|周)",
  "\\d{2}-\\d{2}\\s*岁|\\d{2}\\s*岁以上",
];
const MASK_RE = new RegExp(MASKS.map((m) => `(?:${m})`).join("|"), "g");
const NUMBER_RE = /(?<![A-Za-z0-9_.])(?<cur>[¥￥])?(?<num>[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?)(?:\s*(?<unit>%|个百分点|pp|万元|亿元|万|亿|元))?/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractNumbers(text: string, labels: string[] = []): NumberMention[] {
  const masked = [...Array(text.length).keys()].map((i) => text[i]);
  const blank = (s: number, e: number) => { for (let i = s; i < e; i++) masked[i] = "\0"; };
  const withDigits = [...new Set(labels.filter((l) => l && /\d/.test(l)))].sort((a, b) => b.length - a.length);
  for (const label of withDigits) for (const m of text.matchAll(new RegExp(escapeRe(label), "g"))) blank(m.index!, m.index! + m[0].length);
  for (const m of text.matchAll(MASK_RE)) blank(m.index!, m.index! + m[0].length);
  const clean = masked.join("");
  const out: NumberMention[] = [];
  for (const m of clean.matchAll(NUMBER_RE)) {
    if (m[0].includes("\0")) continue;
    const raw = m.groups!.num;
    const unitRaw = m.groups!.unit ?? "";
    const unit = ({ 万元: "万", 亿元: "亿", 个百分点: "pp", 元: "" } as Record<string, string>)[unitRaw] ?? unitRaw;
    const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
    const start = m.index!;
    const end = start + m[0].length;
    out.push({ text: text.slice(start, end), start, end, value: Number(raw.replace(/,/g, "")), decimals, unit });
  }
  return out;
}
