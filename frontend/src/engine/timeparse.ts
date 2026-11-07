/* Port of backend/app/semantic/timeparse.py. Relative periods are anchored to the semantic
 * layer's "today", so the same question always means the same period. */
import { PACK } from "./pack";

const CN: Record<string, number> = { 零: 0, "〇": 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export const NUM = "(\\d+|[零〇一二两三四五六七八九十]+)";

export function cnToInt(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? (CN[tens] ?? 1) : 1) * 10 + (ones ? (CN[ones] ?? 0) : 0);
  }
  let value = 0;
  for (const ch of text) value = value * 10 + CN[ch];
  return value;
}

export interface TimeRange { start: string; end: string; label: string; explicit: boolean; notes: string[] }

export class OutOfRange extends Error {
  constructor(message: string, public requested: TimeRange) { super(message); }
}
export class InvalidDate extends Error {}

const pad = (n: number) => String(n).padStart(2, "0");
function date(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new InvalidDate(`${y}-${m}-${d} 不是有效日期`);
  return `${y}-${pad(m)}-${pad(d)}`;
}
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const toUTC = (iso: string) => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromUTC(toUTC(iso) + n * 86400000);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthEnd = (iso: string) => { const [y, m] = parts(iso); return date(y, m, lastDay(y, m)); };
function addMonths(iso: string, months: number): string {
  const [y, m, d] = parts(iso);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return date(year, month, Math.min(d, lastDay(year, month)));
}
const days = (tr: { start: string; end: string }) => (toUTC(tr.end) - toUTC(tr.start)) / 86400000 + 1;
const weekday = (iso: string) => (new Date(toUTC(iso)).getUTCDay() + 6) % 7; // Monday = 0
const month = (y: number, m: number): [string, string] => { const s = date(y, m, 1); return [s, monthEnd(s)]; };
function quarter(y: number, q: number): [string, string] {
  const s = date(y, 3 * (q - 1) + 1, 1);
  return [s, monthEnd(addMonths(s, 2))];
}
const fmt = (s: string, e: string) => `${s} 至 ${e}`;
const labelMonth = (s: string) => { const [y, m] = parts(s); return `${y}年${m}月`; };

export function periodKey(tr: { start: string; end: string }): string {
  const [y, m, d] = parts(tr.start);
  if (d === 1 && tr.end === monthEnd(tr.start)) return `${y}-${pad(m)}`;
  if ([1, 4, 7, 10].includes(m) && d === 1 && tr.end === monthEnd(addMonths(tr.start, 2))) return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (tr.start === `${y}-01-01` && tr.end === `${y}-12-31`) return String(y);
  return `${tr.start}~${tr.end}`;
}

type Found = [string, string, string] | null;

function match(text: string, today: string): Found {
  const t = text.replace(/ /g, "");
  const [ty, tm] = parts(today);
  const thisMonth = date(ty, tm, 1);
  let m: RegExpMatchArray | null;

  m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:到|至|~|－|—|-)(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) {
    const s = date(+m[1], +m[2], +m[3]);
    const e = date(+(m[4] ?? m[1]), +m[5], +m[6]);
    return [s, e, fmt(s, e)];
  }
  m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) { const d = date(+m[1], +m[2], +m[3]); return [d, d, d]; }

  const yearOf: Record<string, number> = { 今年: 0, 去年: 1, 前年: 2 };
  m = t.match(new RegExp(`(今年|去年|前年)${NUM}月`));
  if (m) {
    const [s, e] = month(ty - yearOf[m[1]], cnToInt(m[2]));
    return [s, e, labelMonth(s)];
  }
  m = t.match(/(\d{4})(?:年|-|\/)?(?:第)?([1-4一二三四])季度/) ?? t.match(/(\d{4})(?:年)?[Qq]([1-4])/);
  if (m) {
    const y = +m[1], q = cnToInt(m[2]);
    const [s, e] = quarter(y, q);
    return [s, e, `${y}年第${q}季度`];
  }
  m = t.match(/(\d{4})年(上|下)半年/);
  if (m) {
    const y = +m[1];
    return m[2] === "上" ? [date(y, 1, 1), date(y, 6, 30), `${y}年上半年`] : [date(y, 7, 1), date(y, 12, 31), `${y}年下半年`];
  }
  m = t.match(/(\d{4})(?:年|-|\/)(\d{1,2})(?:月|(?!\d))/);
  if (m) { const [s, e] = month(+m[1], +m[2]); return [s, e, labelMonth(s)]; }
  m = t.match(/(\d{4})年(?:全年|整年)?/);
  if (m) { const y = +m[1]; return [date(y, 1, 1), date(y, 12, 31), `${y}年`]; }

  if (/双十一|双11/.test(t)) {
    const y = today >= date(ty, 11, 12) ? ty : ty - 1;
    return [date(y, 11, 1), date(y, 11, 11), `${y}年双十一（11月1日至11日）`];
  }
  if (/618|六一八/.test(t)) {
    const y = today >= date(ty, 6, 19) ? ty : ty - 1;
    return [date(y, 6, 1), date(y, 6, 18), `${y}年618（6月1日至18日）`];
  }
  m = t.match(new RegExp(`(?:最近|近|过去|前)${NUM}(?:个)?(天|日|周|星期|个月|月|年)`));
  if (m) {
    const n = cnToInt(m[1]), unit = m[2];
    const yesterday = addDays(today, -1);
    if (unit === "天" || unit === "日") return [addDays(yesterday, -(n - 1)), yesterday, `近 ${n} 天`];
    if (unit === "周" || unit === "星期") return [addDays(yesterday, -(7 * n - 1)), yesterday, `近 ${n} 周`];
    if (unit === "个月" || unit === "月") return [addMonths(thisMonth, -n), addDays(thisMonth, -1), `近 ${n} 个月`];
    return [addMonths(thisMonth, -12 * n), addDays(thisMonth, -1), `近 ${n} 年`];
  }
  if (/(?:最近|近|过去)(?:一|1)年/.test(t)) return [addMonths(thisMonth, -12), addDays(thisMonth, -1), "近 12 个月"];

  if (/上上个?月/.test(t)) {
    const d = addMonths(thisMonth, -2);
    const [s, e] = month(...(parts(d).slice(0, 2) as [number, number]));
    return [s, e, labelMonth(s)];
  }
  if (/上个?月/.test(t)) {
    const d = addMonths(thisMonth, -1);
    const [s, e] = month(...(parts(d).slice(0, 2) as [number, number]));
    return [s, e, `上个月（${labelMonth(s)}）`];
  }
  if (/本月|这个月|当月|本月份/.test(t)) {
    const [s, e] = month(ty, tm);
    return [s, e, `本月（${labelMonth(s)}）`];
  }
  const qNow = Math.floor((tm - 1) / 3) + 1;
  if (/上个?季度/.test(t)) {
    const [y, q] = qNow > 1 ? [ty, qNow - 1] : [ty - 1, 4];
    const [s, e] = quarter(y, q);
    return [s, e, `上季度（${y}年第${q}季度）`];
  }
  if (/本季度|这个季度|当季/.test(t)) {
    const [s, e] = quarter(ty, qNow);
    return [s, e, `本季度（${ty}年第${qNow}季度）`];
  }
  if (/上周|上个星期|上星期/.test(t)) {
    const monday = addDays(today, -(weekday(today) + 7));
    return [monday, addDays(monday, 6), "上周"];
  }
  if (/本周|这周|这个星期/.test(t)) {
    const monday = addDays(today, -weekday(today));
    return [monday, addDays(monday, 6), "本周"];
  }
  if (t.includes("前天")) { const d = addDays(today, -2); return [d, d, `前天（${d}）`]; }
  if (t.includes("昨天") || t.includes("昨日")) { const d = addDays(today, -1); return [d, d, `昨天（${d}）`]; }
  if (/今天|今日/.test(t)) return [today, today, `今天（${today}）`];

  m = t.match(/(今年|去年|前年)(上|下)半年/);
  if (m) {
    const y = ty - yearOf[m[1]];
    return m[2] === "上" ? [date(y, 1, 1), date(y, 6, 30), `${y}年上半年`] : [date(y, 7, 1), date(y, 12, 31), `${y}年下半年`];
  }
  if (/今年|本年|今年以来|年初至今/.test(t)) return [date(ty, 1, 1), addDays(today, -1), `今年以来（${ty}年）`];
  if (/去年/.test(t)) {
    const y = ty - 1;
    if (t.includes("上半年")) return [date(y, 1, 1), date(y, 6, 30), `${y}年上半年`];
    if (t.includes("下半年")) return [date(y, 7, 1), date(y, 12, 31), `${y}年下半年`];
    return [date(y, 1, 1), date(y, 12, 31), `去年（${y}年）`];
  }
  if (/前年/.test(t)) { const y = ty - 2; return [date(y, 1, 1), date(y, 12, 31), `前年（${y}年）`]; }
  if (/(?<![\d年])上半年/.test(t)) {
    const y = today > date(ty, 6, 30) ? ty : ty - 1;
    return [date(y, 1, 1), date(y, 6, 30), `${y}年上半年`];
  }
  if (/(?<![\d年])下半年/.test(t)) {
    const y = today > date(ty, 12, 31) ? ty : ty - 1;
    return [date(y, 7, 1), date(y, 12, 31), `${y}年下半年`];
  }
  m = t.match(new RegExp(`(?<![\\d年-])${NUM}月份?(?!\\d)`));
  if (m) {
    const mon = cnToInt(m[1]);
    if (mon >= 1 && mon <= 12) {
      const y = mon < tm ? ty : ty - 1;
      const [s, e] = month(y, mon);
      return [s, e, labelMonth(s)];
    }
  }
  return null;
}

/** The period named in text (null if none). Throws OutOfRange when it lies entirely outside the data. */
export function parseTime(text: string): TimeRange | null {
  const cal = PACK.calendar;
  const found = match(text, cal.today);
  if (found === null) return null;
  const [rawStart, rawEnd, label] = found;
  const requested: TimeRange = { start: rawStart, end: rawEnd, label, explicit: true, notes: [] };
  if (rawEnd < cal.data_start || rawStart > cal.data_end) {
    throw new OutOfRange(`${label}（${fmt(rawStart, rawEnd)}）没有数据：数据范围是 ${fmt(cal.data_start, cal.data_end)}。`, requested);
  }
  const notes: string[] = [];
  let start = rawStart, end = rawEnd;
  if (start < cal.data_start || end > cal.data_end) {
    start = start < cal.data_start ? cal.data_start : start;
    end = end > cal.data_end ? cal.data_end : end;
    notes.push(`${label}只有部分时间有数据，已按 ${fmt(start, end)} 统计。`);
  }
  return { start, end, label, explicit: true, notes };
}

export function defaultRange(trend: boolean): TimeRange {
  const cal = PACK.calendar;
  const [ty, tm] = parts(cal.today);
  let first: string, last: string, label: string;
  if (trend) {
    first = addMonths(date(ty, tm, 1), -cal.default_trend_months);
    last = addDays(date(ty, tm, 1), -1);
    label = `近 ${cal.default_trend_months} 个月`;
  } else {
    last = addDays(cal.today, -1);
    first = addDays(last, -(cal.default_range_days - 1));
    label = `近 ${cal.default_range_days} 天`;
  }
  last = last < cal.data_end ? last : cal.data_end;
  return { start: first, end: last, label, explicit: false, notes: [`问题里没有指定时间，默认统计${label}（${fmt(first, last)}）。`] };
}

export function previousPeriod(tr: TimeRange, kind: string): TimeRange {
  if (kind === "yoy") {
    const back = (iso: string) => {
      const [y, m, d] = parts(iso);
      return m === 2 && d === 29 ? date(y - 1, 2, 28) : date(y - 1, m, d);
    };
    const s = back(tr.start), e = back(tr.end);
    return { start: s, end: e, label: `去年同期（${fmt(s, e)}）`, explicit: true, notes: [] };
  }
  let start: string, end: string;
  const [, , sd] = parts(tr.start);
  if (sd === 1 && tr.end === monthEnd(tr.end)) {
    const [sy, sm] = parts(tr.start);
    const [ey, em] = parts(tr.end);
    const months = (ey - sy) * 12 + em - sm + 1;
    start = addMonths(tr.start, -months);
    end = monthEnd(addMonths(tr.start, -1));
  } else {
    end = addDays(tr.start, -1);
    start = addDays(end, -(days(tr) - 1));
  }
  return { start, end, label: `上一周期（${fmt(start, end)}）`, explicit: true, notes: [] };
}
