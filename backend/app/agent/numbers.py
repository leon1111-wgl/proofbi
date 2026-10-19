"""Number formatting and extraction shared by the narrator and the verifier.

Formatting rules (used everywhere so text, tables and charts agree):
  currency  >= 100,000 -> "13.36 万元", otherwise "1,234.50 元"; a column with any value
            >= 100,000 is shown in 万元 throughout
  percent   ratio 0.179 -> "17.9%"
  integer   12345 -> "12,345"
"""

from __future__ import annotations

import re
from dataclasses import dataclass


def format_value(value, fmt: str, unit: str = "", wan: bool | None = None) -> str:
    """``wan`` forces (True) or forbids (False) the 万元 scale; None decides per value.
    Callers formatting a whole column pass ``wan=column_uses_wan(values)`` so one
    column never mixes 万元 and 元."""
    if value is None:
        return "—"
    if fmt == "currency":
        v = float(value)
        use_wan = abs(v) >= 1e5 if wan is None else wan
        return f"{v / 1e4:,.2f} 万元" if use_wan else f"{v:,.2f} 元"
    if fmt == "percent":
        return f"{float(value) * 100:.1f}%"
    if fmt == "integer":
        text = f"{int(round(float(value))):,}"
        return f"{text} {unit}" if unit else text
    if fmt == "number":
        return f"{float(value):,.2f}"
    return str(value)


def column_uses_wan(values) -> bool:
    return any(isinstance(v, (int, float)) and abs(v) >= 1e5 for v in values)


def format_change(current, previous) -> tuple[str, float] | None:
    """Relative change as text, e.g. ("上升 4.2%", 0.042). None when previous is 0/None."""
    if current is None or previous in (None, 0):
        return None
    change = (float(current) - float(previous)) / float(previous)
    word = "上升" if change > 0 else "下降" if change < 0 else "持平"
    return (f"{word} {abs(change) * 100:.1f}%" if change else "持平"), change


@dataclass
class NumberMention:
    text: str
    start: int
    end: int
    value: float  # the number as written (before unit scaling)
    decimals: int
    unit: str  # "" | % | 万 | 亿 | pp  (元 needs no scaling and maps to "")

    def candidates(self) -> list[tuple[float, float]]:
        """(value, tolerance) interpretations of the mention in result-cell units."""
        half = 0.5 * 10 ** (-self.decimals)
        if self.unit == "%":
            return [(self.value / 100, half / 100), (self.value, half)]
        if self.unit == "万":
            return [(self.value * 1e4, half * 1e4)]
        if self.unit == "亿":
            return [(self.value * 1e8, half * 1e8)]
        return [(self.value, half)]


_MASKS = [
    r"\d{4}-\d{1,2}-\d{1,2}(?:\s*~\s*\d{4}-\d{1,2}-\d{1,2})?",  # 2026-09-01 / ranges
    r"\d{4}-Q[1-4]",
    r"\d{4}-\d{2}(?!\d)",  # 2026-09
    r"\d{4}\s*年(?:\s*第?\s*\d{1,2}\s*(?:季度|月))?(?:\s*\d{1,2}\s*日)?",
    r"\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?",
    r"\d{1,2}\s*日",
    r"[Qq][1-4]",
    r"第\s*\d+",
    r"(?:前|后|[Tt][Oo][Pp])\s*\d+",
    r"近\s*\d+\s*(?:天|日|周|个月|年)",
    r"\d+\s*(?:天|个月|周)",
    r"\d{2}-\d{2}\s*岁|\d{2}\s*岁以上",
]
_MASK_RE = re.compile("|".join(f"(?:{m})" for m in _MASKS))
# ASCII-only lookbehind: Python's \w also matches CJK, which would hide "为17.9%".
_NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9_.])(?P<cur>[¥￥])?(?P<num>[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?)"
    r"(?:\s*(?P<unit>%|个百分点|pp|万元|亿元|万|亿|元))?"
)


def extract_numbers(text: str, labels: list[str] | None = None) -> list[NumberMention]:
    """Numbers in ``text`` that state a quantity. Dates, rankings, durations and any text
    equal to a label from the results (store names, age bands) are masked first."""
    masked = list(text)

    def blank(start: int, end: int) -> None:
        for i in range(start, end):
            masked[i] = "\0"

    for label in sorted({lb for lb in labels or [] if lb and re.search(r"\d", lb)}, key=len, reverse=True):
        for m in re.finditer(re.escape(label), text):
            blank(m.start(), m.end())
    for m in _MASK_RE.finditer(text):
        blank(m.start(), m.end())
    clean = "".join(masked)
    out: list[NumberMention] = []
    for m in _NUMBER_RE.finditer(clean):
        raw = m.group("num")
        if "\0" in m.group(0):
            continue
        unit = m.group("unit") or ""
        unit = {"万元": "万", "亿元": "亿", "个百分点": "pp", "元": ""}.get(unit, unit)
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        start = m.start("cur") if m.group("cur") else m.start("num")
        out.append(NumberMention(text=text[start:m.end()], start=start, end=m.end(),
                                 value=float(raw.replace(",", "")), decimals=decimals, unit=unit))
    return out
