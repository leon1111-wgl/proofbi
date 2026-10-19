"""Resolve time expressions such as 上个月 / 近 30 天 / 2025年Q3 into absolute dates.

Relative expressions are anchored to the semantic layer's ``today`` (not the wall
clock), so the same question always means the same period and evals stay reproducible.
Every answer shows the resolved dates, which is what makes 上个月 checkable.
"""

from __future__ import annotations

import calendar as _cal
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

from .layer import Calendar

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
NUM = r"(\d+|[零〇一二两三四五六七八九十]+)"


def cn_to_int(text: str) -> int:
    """'12' / '十二' / '三十' / '两' -> int (up to 99)."""
    if text.isdigit():
        return int(text)
    if "十" in text:
        tens, _, ones = text.partition("十")
        return (_CN_DIGITS.get(tens, 1) if tens else 1) * 10 + (_CN_DIGITS.get(ones, 0) if ones else 0)
    value = 0
    for ch in text:
        value = value * 10 + _CN_DIGITS[ch]
    return value


@dataclass
class TimeRange:
    start: date
    end: date
    label: str
    explicit: bool = True  # False when the default window was applied
    notes: list[str] = field(default_factory=list)

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def to_dict(self) -> dict:
        return {"start": self.start.isoformat(), "end": self.end.isoformat(), "label": self.label,
                "explicit": self.explicit, "notes": list(self.notes)}

    @classmethod
    def from_dict(cls, data: dict) -> "TimeRange":
        return cls(date.fromisoformat(data["start"]), date.fromisoformat(data["end"]), data.get("label", ""),
                   bool(data.get("explicit", True)), list(data.get("notes") or []))

    @property
    def period_key(self) -> str:
        """Compact label used as the value of the ``period`` column in comparisons."""
        if self.start.day == 1 and self.end == _month_end(self.start):
            return self.start.strftime("%Y-%m")
        if self.start.month in (1, 4, 7, 10) and self.start.day == 1:
            q_end = _month_end(_add_months(self.start, 2))
            if self.end == q_end:
                return f"{self.start.year}-Q{(self.start.month - 1) // 3 + 1}"
        if self.start == date(self.start.year, 1, 1) and self.end == date(self.start.year, 12, 31):
            return str(self.start.year)
        return f"{self.start.isoformat()}~{self.end.isoformat()}"


class OutOfRange(ValueError):
    """The requested period has no data at all."""

    def __init__(self, message: str, requested: TimeRange):
        super().__init__(message)
        self.requested = requested


def _month_end(d: date) -> date:
    return date(d.year, d.month, _cal.monthrange(d.year, d.month)[1])


def _add_months(d: date, months: int) -> date:
    index = d.year * 12 + d.month - 1 + months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(d.day, _cal.monthrange(year, month + 1)[1]))


def _month(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    return start, _month_end(start)


def _quarter(year: int, q: int) -> tuple[date, date]:
    start = date(year, 3 * (q - 1) + 1, 1)
    return start, _month_end(_add_months(start, 2))


def _fmt(start: date, end: date) -> str:
    return f"{start.isoformat()} 至 {end.isoformat()}"


def _label_month(start: date) -> str:
    return f"{start.year}年{start.month}月"


def parse_time(text: str, cal: Calendar) -> TimeRange | None:
    """Return the period named in ``text`` (None if no period is mentioned).

    Raises OutOfRange when the period lies completely outside the data. A period that
    overlaps the data only partly is clamped, with a note saying so.
    """
    found = _match(text, cal.today)
    if found is None:
        return None
    start, end, label = found
    requested = TimeRange(start, end, label)
    if end < cal.data_start or start > cal.data_end:
        raise OutOfRange(
            f"{label}（{_fmt(start, end)}）没有数据：数据范围是 {_fmt(cal.data_start, cal.data_end)}。", requested)
    notes = []
    if start < cal.data_start or end > cal.data_end:
        clamped_start, clamped_end = max(start, cal.data_start), min(end, cal.data_end)
        notes.append(f"{label}只有部分时间有数据，已按 {_fmt(clamped_start, clamped_end)} 统计。")
        start, end = clamped_start, clamped_end
    return TimeRange(start, end, label, True, notes)


def default_range(cal: Calendar, trend: bool) -> TimeRange:
    """Window used when a question names no period."""
    if trend:
        first = _add_months(date(cal.today.year, cal.today.month, 1), -cal.default_trend_months)
        last = date(cal.today.year, cal.today.month, 1) - timedelta(days=1)
        label = f"近 {cal.default_trend_months} 个月"
    else:
        last = cal.today - timedelta(days=1)
        first = last - timedelta(days=cal.default_range_days - 1)
        label = f"近 {cal.default_range_days} 天"
    last = min(last, cal.data_end)
    return TimeRange(first, last, label, explicit=False,
                     notes=[f"问题里没有指定时间，默认统计{label}（{_fmt(first, last)}）。"])


def previous_period(tr: TimeRange, kind: str) -> TimeRange:
    """环比 (mom): the period of the same length right before; 同比 (yoy): one year earlier."""
    if kind == "yoy":
        def back(d: date) -> date:
            try:
                return d.replace(year=d.year - 1)
            except ValueError:  # Feb 29
                return d.replace(year=d.year - 1, day=28)
        start, end = back(tr.start), back(tr.end)
        return TimeRange(start, end, f"去年同期（{_fmt(start, end)}）")
    if tr.start.day == 1 and tr.end == _month_end(tr.end):
        months = (tr.end.year - tr.start.year) * 12 + tr.end.month - tr.start.month + 1
        start = _add_months(tr.start, -months)
        end = _month_end(_add_months(tr.start, -1))
    else:
        end = tr.start - timedelta(days=1)
        start = end - timedelta(days=tr.days - 1)
    return TimeRange(start, end, f"上一周期（{_fmt(start, end)}）")


def _match(text: str, today: date) -> tuple[date, date, str] | None:
    t = text.replace(" ", "")
    this_month = date(today.year, today.month, 1)

    # explicit date ranges: 2026-09-01到2026-09-15
    m = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:到|至|~|－|—|-)(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?", t)
    if m:
        y1, m1, d1, y2, m2, d2 = m.groups()
        start = date(int(y1), int(m1), int(d1))
        end = date(int(y2 or y1), int(m2), int(d2))
        return start, end, _fmt(start, end)

    # a single day: 2026-09-15 / 2026年9月15日
    m = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", t)
    if m:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return d, d, d.isoformat()

    # 今年 9 月 / 去年 11 月
    m = re.search(rf"(今年|去年|前年){NUM}月", t)
    if m:
        year = today.year - {"今年": 0, "去年": 1, "前年": 2}[m.group(1)]
        start, end = _month(year, cn_to_int(m.group(2)))
        return start, end, _label_month(start)

    m = re.search(r"(\d{4})(?:年|-|/)?(?:第)?([1-4一二三四])季度", t) or re.search(r"(\d{4})(?:年)?[Qq]([1-4])", t)
    if m:
        year, q = int(m.group(1)), cn_to_int(m.group(2))
        start, end = _quarter(year, q)
        return start, end, f"{year}年第{q}季度"

    m = re.search(r"(\d{4})年(上|下)半年", t)
    if m:
        year = int(m.group(1))
        if m.group(2) == "上":
            return date(year, 1, 1), date(year, 6, 30), f"{year}年上半年"
        return date(year, 7, 1), date(year, 12, 31), f"{year}年下半年"

    m = re.search(r"(\d{4})(?:年|-|/)(\d{1,2})(?:月|(?!\d))", t)
    if m:
        start, end = _month(int(m.group(1)), int(m.group(2)))
        return start, end, _label_month(start)

    m = re.search(r"(\d{4})年(?:全年|整年)?", t)
    if m:
        year = int(m.group(1))
        return date(year, 1, 1), date(year, 12, 31), f"{year}年"

    if re.search(r"双十一|双11", t):
        year = today.year if today >= date(today.year, 11, 12) else today.year - 1
        return date(year, 11, 1), date(year, 11, 11), f"{year}年双十一（11月1日至11日）"
    if re.search(r"618|六一八", t):
        year = today.year if today >= date(today.year, 6, 19) else today.year - 1
        return date(year, 6, 1), date(year, 6, 18), f"{year}年618（6月1日至18日）"

    m = re.search(rf"(?:最近|近|过去|前){NUM}(?:个)?(天|日|周|星期|个月|月|年)", t)
    if m:
        n, unit = cn_to_int(m.group(1)), m.group(2)
        if unit in ("天", "日"):
            end = today - timedelta(days=1)
            return end - timedelta(days=n - 1), end, f"近 {n} 天"
        if unit in ("周", "星期"):
            end = today - timedelta(days=1)
            return end - timedelta(days=7 * n - 1), end, f"近 {n} 周"
        if unit in ("个月", "月"):
            start = _add_months(this_month, -n)
            return start, this_month - timedelta(days=1), f"近 {n} 个月"
        start = _add_months(this_month, -12 * n)
        return start, this_month - timedelta(days=1), f"近 {n} 年"
    if re.search(r"(?:最近|近|过去)(?:一|1)年", t):
        start = _add_months(this_month, -12)
        return start, this_month - timedelta(days=1), "近 12 个月"

    if re.search(r"上上个?月", t):
        start, end = _month(*divmod_month(this_month, -2))
        return start, end, _label_month(start)
    if re.search(r"上个?月", t):
        start, end = _month(*divmod_month(this_month, -1))
        return start, end, f"上个月（{_label_month(start)}）"
    if re.search(r"本月|这个月|当月|本月份", t):
        start, end = _month(today.year, today.month)
        return start, end, f"本月（{_label_month(start)}）"

    q_now = (today.month - 1) // 3 + 1
    if re.search(r"上个?季度", t):
        year, q = (today.year, q_now - 1) if q_now > 1 else (today.year - 1, 4)
        start, end = _quarter(year, q)
        return start, end, f"上季度（{year}年第{q}季度）"
    if re.search(r"本季度|这个季度|当季", t):
        start, end = _quarter(today.year, q_now)
        return start, end, f"本季度（{today.year}年第{q_now}季度）"

    if re.search(r"上周|上个星期|上星期", t):
        monday = today - timedelta(days=today.weekday() + 7)
        return monday, monday + timedelta(days=6), "上周"
    if re.search(r"本周|这周|这个星期", t):
        monday = today - timedelta(days=today.weekday())
        return monday, monday + timedelta(days=6), "本周"
    if "前天" in t:
        d = today - timedelta(days=2)
        return d, d, f"前天（{d.isoformat()}）"
    if "昨天" in t or "昨日" in t:
        d = today - timedelta(days=1)
        return d, d, f"昨天（{d.isoformat()}）"
    if re.search(r"今天|今日", t):
        return today, today, f"今天（{today.isoformat()}）"

    m = re.search(r"(今年|去年|前年)(上|下)半年", t)
    if m:
        y = today.year - {"今年": 0, "去年": 1, "前年": 2}[m.group(1)]
        if m.group(2) == "上":
            return date(y, 1, 1), date(y, 6, 30), f"{y}年上半年"
        return date(y, 7, 1), date(y, 12, 31), f"{y}年下半年"
    if re.search(r"今年|本年|今年以来|年初至今", t):
        return date(today.year, 1, 1), today - timedelta(days=1), f"今年以来（{today.year}年）"
    if re.search(r"去年", t):
        y = today.year - 1
        if "上半年" in t:
            return date(y, 1, 1), date(y, 6, 30), f"{y}年上半年"
        if "下半年" in t:
            return date(y, 7, 1), date(y, 12, 31), f"{y}年下半年"
        return date(y, 1, 1), date(y, 12, 31), f"去年（{y}年）"
    if re.search(r"前年", t):
        y = today.year - 2
        return date(y, 1, 1), date(y, 12, 31), f"前年（{y}年）"
    if re.search(r"(?<![\d年])上半年", t):
        y = today.year if today > date(today.year, 6, 30) else today.year - 1
        return date(y, 1, 1), date(y, 6, 30), f"{y}年上半年"
    if re.search(r"(?<![\d年])下半年", t):
        y = today.year if today > date(today.year, 12, 31) else today.year - 1
        return date(y, 7, 1), date(y, 12, 31), f"{y}年下半年"

    # a bare month such as 8月 means the most recent August before today
    m = re.search(rf"(?<![\d年-]){NUM}月份?(?!\d)", t)
    if m:
        month = cn_to_int(m.group(1))
        if 1 <= month <= 12:
            year = today.year if month < today.month else today.year - 1
            start, end = _month(year, month)
            return start, end, _label_month(start)
    return None


def divmod_month(first_of_month: date, delta: int) -> tuple[int, int]:
    d = _add_months(first_of_month, delta)
    return d.year, d.month
