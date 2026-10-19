"""Number verifier: every number in an answer must come from a query result.

For each numeric mention in the answer text:
1. ``verified`` if it equals a result cell, allowing only the rounding that the text's
   own precision implies ("17.9%" matches 0.1790 ± 0.0005, "13.36 万元" matches
   133,620.97 ± 50);
2. ``derived`` if it is a simple, disclosed calculation over cells of one column:
   change rate, percentage-point gap, difference, share of total, column total, row count.
   The formula and the cells are recorded so the user can check it;
3. ``unverified`` otherwise. Unverified numbers are flagged red in the UI and fail the
   answer's verdict.

Dates, rankings (前 5), durations and labels taken from the results (store names, age
bands) are masked before extraction, so "2026年9月" or "25-34岁" are not checked as data.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from itertools import permutations
from typing import Any

from .numbers import NumberMention, extract_numbers

MAX_ROWS_FOR_DERIVED = 50


@dataclass
class ResultTable:
    query_id: str
    columns: list[str]
    rows: list[list[Any]]
    labels: dict[str, str] = field(default_factory=dict)

    def numeric_columns(self) -> list[int]:
        return [i for i in range(len(self.columns))
                if any(isinstance(r[i], (int, float)) and not isinstance(r[i], bool) for r in self.rows)]


@dataclass
class NumberCheck:
    text: str
    start: int
    end: int
    value: float
    unit: str
    status: str  # verified | derived | unverified
    ref: dict[str, Any] | None = None  # {query_id, row, column}
    refs: list[dict[str, Any]] = field(default_factory=list)
    formula: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class VerificationReport:
    verdict: str  # pass | fail | none (no numbers)
    numbers: list[NumberCheck]

    @property
    def counts(self) -> dict[str, int]:
        out = {"verified": 0, "derived": 0, "unverified": 0}
        for n in self.numbers:
            out[n.status] += 1
        return out

    def to_dict(self) -> dict[str, Any]:
        return {"verdict": self.verdict, "counts": self.counts, "numbers": [n.to_dict() for n in self.numbers]}


def _close(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol + 1e-9


def _cell_ref(table: ResultTable, row: int, col: int) -> dict[str, Any]:
    name = table.columns[col]
    return {"query_id": table.query_id, "row": row, "column": name, "label": table.labels.get(name, name),
            "value": table.rows[row][col]}


def _direct(mention: NumberMention, tables: list[ResultTable]) -> dict[str, Any] | None:
    for value, tol in mention.candidates():
        for table in tables:
            for col in table.numeric_columns():
                for r, row in enumerate(table.rows):
                    cell = row[col]
                    if isinstance(cell, (int, float)) and _close(float(cell), value, tol):
                        return _cell_ref(table, r, col)
    return None


def _derived(mention: NumberMention, tables: list[ResultTable]) -> tuple[str, list[dict]] | None:
    half = 0.5 * 10 ** (-mention.decimals)
    for table in tables:
        if len(table.rows) > MAX_ROWS_FOR_DERIVED:
            continue
        for col in table.numeric_columns():
            cells = [(r, float(row[col])) for r, row in enumerate(table.rows) if isinstance(row[col], (int, float))]
            label = table.labels.get(table.columns[col], table.columns[col])
            total = sum(v for _, v in cells)
            for (ra, a), (rb, b) in permutations(cells, 2):
                refs = [_cell_ref(table, ra, col), _cell_ref(table, rb, col)]
                if mention.unit == "%" and a:
                    if _close(abs((b - a) / a), abs(mention.value) / 100, half / 100):
                        return f"变化率 = ({label} B − A) ÷ A", refs
                if mention.unit == "pp":
                    if _close(abs(b - a) * 100, abs(mention.value), half):
                        return f"百分点差 = ({label} B − A) × 100", refs
                if mention.unit in ("", "万", "亿"):
                    scale = {"": 1, "万": 1e4, "亿": 1e8}[mention.unit]
                    if _close(abs(b - a), abs(mention.value) * scale, half * scale) and mention.value != 0:
                        return f"差值 = {label} B − A", refs
            if mention.unit == "%" and total:
                for r, v in cells:
                    if _close(v / total, mention.value / 100, half / 100):
                        return f"占比 = {label} ÷ 列合计 {total:,.2f}", [_cell_ref(table, r, col)]
            if mention.unit in ("", "万", "亿") and len(cells) > 1:
                scale = {"": 1, "万": 1e4, "亿": 1e8}[mention.unit]
                if _close(total, mention.value * scale, half * scale):
                    return f"合计 = {label} 列求和", [_cell_ref(table, r, col) for r, _ in cells]
        if mention.unit == "" and mention.decimals == 0 and mention.value == len(table.rows) and len(table.rows) > 1:
            return f"行数 = {table.query_id} 结果行数", []
    return None


def verify_answer(text: str, tables: list[ResultTable]) -> VerificationReport:
    labels = [str(cell) for t in tables for row in t.rows for cell in row if isinstance(cell, str)]
    checks: list[NumberCheck] = []
    for mention in extract_numbers(text, labels):
        base = dict(text=mention.text, start=mention.start, end=mention.end, value=mention.value, unit=mention.unit)
        ref = _direct(mention, tables)
        if ref is not None:
            checks.append(NumberCheck(status="verified", ref=ref, refs=[ref], **base))
            continue
        derived = _derived(mention, tables)
        if derived is not None:
            formula, refs = derived
            checks.append(NumberCheck(status="derived", formula=formula, refs=refs,
                                      ref=refs[0] if refs else None, **base))
            continue
        checks.append(NumberCheck(status="unverified", **base))
    if not checks:
        verdict = "none"
    else:
        verdict = "fail" if any(c.status == "unverified" for c in checks) else "pass"
    return VerificationReport(verdict, checks)
