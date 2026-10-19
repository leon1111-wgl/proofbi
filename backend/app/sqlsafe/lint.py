"""口径 lint: does the SQL compute the metric that the plan asked for?

Safe SQL can still answer the wrong question. These checks run on the AST before
execution and compare the SQL with the semantic layer and the resolved plan:

- status filter: the set of order statuses that the WHERE clauses let through must
  equal one of the metric's accepted sets. ``status <> 'cancelled'`` and
  ``status IN ('paid', 'refunded')`` pass the same rows, so both are accepted;
  forgetting the filter (and counting cancelled orders into GMV) is not.
- aggregate: GMV must SUM ``pay_amount``, not ``gross_amount``.
- time range: dates in the SQL must equal the resolved period. ``DATE('now')`` is
  rejected (it breaks reproducibility) and so is an off-by-one month end.
- dimension filters: every filter value of the plan must appear in a WHERE clause.

Only WHERE clauses are inspected: ``CASE WHEN o.status = 'refunded'`` inside a metric
expression is part of the formula, not a filter. Issues go back to the model.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlglot import exp

from ..semantic.compiler import QuerySpec
from ..semantic.layer import SemanticLayer

STATUS_DOMAIN = frozenset({"paid", "refunded", "cancelled"})
STATUS_TEXT = {"paid": "已支付", "refunded": "已退款", "cancelled": "已取消"}
_MIN, _MAX = date.min, date.max


@dataclass
class LintIssue:
    code: str
    message: str

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class _NonLiteralDate(Exception):
    pass


def _flatten_and(node: exp.Expression):
    if isinstance(node, exp.Paren):
        yield from _flatten_and(node.this)
    elif isinstance(node, exp.And):
        yield from _flatten_and(node.left)
        yield from _flatten_and(node.right)
    else:
        yield node


def _literal(node: exp.Expression) -> str | None:
    return node.this if isinstance(node, exp.Literal) and node.is_string else None


def _is_column(node: exp.Expression, name: str) -> bool:
    return isinstance(node, exp.Column) and node.name.lower() == name


# ---------------------------------------------------------------- status
def _status_set(pred: exp.Expression) -> frozenset[str] | None:
    if isinstance(pred, exp.Paren):
        return _status_set(pred.this)
    if isinstance(pred, exp.Not):
        inner = _status_set(pred.this)
        return STATUS_DOMAIN - inner if inner is not None else None
    if isinstance(pred, exp.In) and _is_column(pred.this, "status"):
        values = {_literal(v) for v in pred.expressions}
        return frozenset(v for v in values if v) if None not in values else None
    if isinstance(pred, (exp.EQ, exp.NEQ)):
        left, right = pred.left, pred.right
        if _is_column(right, "status"):
            left, right = right, left
        if _is_column(left, "status") and _literal(right) is not None:
            hit = frozenset({_literal(right)})
            return hit if isinstance(pred, exp.EQ) else STATUS_DOMAIN - hit
    if isinstance(pred, exp.Or):
        a, b = _status_set(pred.left), _status_set(pred.right)
        if a is not None and b is not None:
            return a | b
    return None


def _status_text(statuses: frozenset[str] | set[str]) -> str:
    return " / ".join(STATUS_TEXT.get(s, s) for s in sorted(statuses, key=list(STATUS_TEXT).index)) or "无"


# ---------------------------------------------------------------- dates
def _as_date(node: exp.Expression) -> date:
    text = _literal(node)
    if text is None:
        raise _NonLiteralDate(node.sql(dialect="sqlite"))
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise _NonLiteralDate(text) from exc


def _month_range(text: str) -> tuple[date, date]:
    start = date.fromisoformat(text[:7] + "-01")
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start, nxt - timedelta(days=1)


def _is_month_of_date(node: exp.Expression) -> bool:
    """SUBSTR(order_date, 1, 7) or STRFTIME('%Y-%m', order_date)."""
    if isinstance(node, exp.Substring) and _is_column(node.this, "order_date"):
        return True
    if isinstance(node, exp.TimeToStr):
        return any(_is_column(c, "order_date") for c in node.find_all(exp.Column))
    return False


def _date_ranges(pred: exp.Expression) -> list[tuple[date, date]] | None:
    """Date ranges a predicate restricts order_date to, or None if it is not about dates."""
    if isinstance(pred, exp.Paren):
        return _date_ranges(pred.this)
    if isinstance(pred, exp.Between) and _is_column(pred.this, "order_date"):
        return [(_as_date(pred.args["low"]), _as_date(pred.args["high"]))]
    if isinstance(pred, (exp.GTE, exp.GT, exp.LTE, exp.LT, exp.EQ)):
        left, right, op = pred.left, pred.right, type(pred)
        flipped = {exp.GTE: exp.LTE, exp.GT: exp.LT, exp.LTE: exp.GTE, exp.LT: exp.GT, exp.EQ: exp.EQ}
        if _is_column(right, "order_date") or _is_month_of_date(right):
            left, right, op = right, left, flipped[op]
        if _is_month_of_date(left) and op is exp.EQ:
            text = _literal(right)
            if text is None:
                raise _NonLiteralDate(right.sql(dialect="sqlite"))
            return [_month_range(text)]
        if _is_column(left, "order_date"):
            d = _as_date(right)
            return [{exp.GTE: (d, _MAX), exp.GT: (d + timedelta(days=1), _MAX), exp.LTE: (_MIN, d),
                     exp.LT: (_MIN, d - timedelta(days=1)), exp.EQ: (d, d)}[op]]
    if isinstance(pred, exp.Like) and _is_column(pred.this, "order_date"):
        text = _literal(pred.expression)
        if text and text.endswith("%") and len(text.rstrip("%")) == 7:
            return [_month_range(text)]
    if isinstance(pred, exp.And):
        parts = [r for r in (_date_ranges(p) for p in _flatten_and(pred)) if r is not None]
        return _intersect_all(parts) if parts else None
    if isinstance(pred, exp.Or):
        a, b = _date_ranges(pred.left), _date_ranges(pred.right)
        if a is not None and b is not None:
            return a + b
    return None


def _intersect_all(parts: list[list[tuple[date, date]]]) -> list[tuple[date, date]]:
    current = [(_MIN, _MAX)]
    for ranges in parts:
        current = [(max(a1, b1), min(a2, b2)) for a1, a2 in current for b1, b2 in ranges if max(a1, b1) <= min(a2, b2)]
    return current


def _merge(ranges: list[tuple[date, date]]) -> list[tuple[date, date]]:
    merged: list[tuple[date, date]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + timedelta(days=1):
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _fmt(ranges: list[tuple[date, date]]) -> str:
    def one(r):
        lo = "不限" if r[0] == _MIN else r[0].isoformat()
        hi = "不限" if r[1] == _MAX else r[1].isoformat()
        return f"{lo} 至 {hi}"
    return "，".join(one(r) for r in ranges) or "空"


# ---------------------------------------------------------------- main
def lint_sql(tree: exp.Expression, spec: QuerySpec, layer: SemanticLayer,
             value_codes: dict[str, dict[str, str]] | None = None) -> list[LintIssue]:
    issues: list[LintIssue] = []
    wheres = list(tree.find_all(exp.Where))
    predicates = [p for w in wheres for p in _flatten_and(w.this)]

    known_columns = {c for t in layer.tables.values() for c in t.columns}
    known_columns |= {a.alias.lower() for a in tree.find_all(exp.Alias) if a.alias}  # ORDER BY gmv etc.
    unknown_columns = {c.name for c in tree.find_all(exp.Column) if c.name and c.name.lower() not in known_columns}

    # status filter
    status_sets = [s for s in (_status_set(p) for p in predicates) if s is not None]
    effective = frozenset(STATUS_DOMAIN)
    for s in status_sets:
        effective &= s
    for key in spec.metrics:
        metric = layer.metrics[key]
        accepted = [frozenset(x) for x in metric.lint.get("status", [])]
        if not accepted:
            continue
        if not status_sets:
            issues.append(LintIssue("missing_status_filter",
                                    f"{metric.label} 的口径要求只统计 {_status_text(accepted[0])} 订单，SQL 没有过滤订单状态"))
        elif effective not in accepted:
            issues.append(LintIssue("wrong_status_filter",
                                    f"{metric.label} 的口径要求只统计 {_status_text(accepted[0])} 订单，"
                                    f"SQL 实际统计的是 {_status_text(effective)} 订单"))
        column = metric.lint.get("sum_of")
        # An unknown column is a schema error, not a 口径 error: leave it to the executor,
        # whose "no such column" message is more useful for self-correction.
        if column and not unknown_columns and not any(any(_is_column(c, column) for c in s.find_all(exp.Column)) for s in tree.find_all(exp.Sum)):
            issues.append(LintIssue("wrong_aggregate", f"{metric.label} 的口径需要对 {column} 求和"))

    # time range
    expected = [(spec.time.start, spec.time.end)]
    if spec.compare_time is not None:
        expected.append((spec.compare_time.start, spec.compare_time.end))
    found: list[tuple[date, date]] = []
    try:
        for w in wheres:
            parts = [r for r in (_date_ranges(p) for p in _flatten_and(w.this)) if r is not None]
            if parts:
                found += _intersect_all(parts)
    except _NonLiteralDate as exc:
        issues.append(LintIssue("non_literal_date",
                                f"时间条件请直接使用解析好的日期 {_fmt(_merge(expected))}，不要用 {exc}"))
    else:
        if not found:
            issues.append(LintIssue("missing_time_filter", f"SQL 缺少时间条件，应为 {_fmt(_merge(expected))}"))
        elif _merge(found) != _merge(expected):
            issues.append(LintIssue("wrong_time_range",
                                    f"时间口径不一致：问题对应 {_fmt(_merge(expected))}，SQL 中为 {_fmt(_merge(found))}"))

    # dimension filters
    literals = {str(_literal(lit)).lower() for w in wheres for lit in w.find_all(exp.Literal) if _literal(lit)}
    codes = value_codes or {}
    for dim, values in spec.filters.items():
        for value in values:
            accepted_tokens = {value.lower(), codes.get(dim, {}).get(value, value).lower()}
            if not accepted_tokens & literals:
                issues.append(LintIssue("missing_filter", f"SQL 缺少筛选条件：{layer.label(dim)} = {value}"))
    return issues
