"""Compile a ``Plan`` into SQL using the semantic layer (the template SQL writer).

One plan can become several queries: metrics with different base filters (GMV counts
refunded orders, 毛利 does not) or a different shape (复购率 needs a per-customer
subquery) are never forced into one SELECT. Each query lists its columns with labels and
formats so that answers, charts and the number verifier can work from metadata.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlglot import exp

from .layer import SemanticLayer
from .plan import Plan
from .timeparse import TimeRange


@dataclass
class QuerySpec:
    key: str
    metrics: list[str]
    dimensions: list[str]  # may include the pseudo-dimension "period" for comparisons
    filters: dict[str, list[str]]
    time: TimeRange
    compare_time: TimeRange | None = None
    order: str | None = None
    order_by: str | None = None
    limit: int | None = None
    item_grain: bool = False
    repurchase: bool = False
    columns: list[dict[str, Any]] = field(default_factory=list)

    @property
    def title(self) -> str:
        return "、".join(c["label"] for c in self.columns if c["role"] == "metric")

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "metrics": self.metrics, "dimensions": self.dimensions, "filters": self.filters,
            "time": self.time.to_dict(), "compare_time": self.compare_time.to_dict() if self.compare_time else None,
            "order": self.order, "order_by": self.order_by, "limit": self.limit, "item_grain": self.item_grain,
            "repurchase": self.repurchase, "columns": self.columns,
        }


def _lit(value: str) -> str:
    return exp.Literal.string(value).sql()


def _in(expr: str, values: list[str]) -> str:
    if len(values) == 1:
        return f"{expr} = {_lit(values[0])}"
    return f"{expr} IN ({', '.join(_lit(v) for v in values)})"


def _between(column: str, tr: TimeRange) -> str:
    return f"{column} BETWEEN {_lit(tr.start.isoformat())} AND {_lit(tr.end.isoformat())}"


def split_plan(plan: Plan, layer: SemanticLayer) -> list[QuerySpec]:
    """Group the plan's metrics into queries that can share one SELECT."""
    groups: list[tuple[str, list[str]]] = []
    for key in plan.metrics:
        metric = layer.metrics[key]
        if metric.type == "repurchase":
            groups.append(("repurchase:" + key, [key]))
            continue
        for gkey, members in groups:
            if gkey == metric.filter:
                members.append(key)
                break
        else:
            groups.append((metric.filter, [key]))

    dims = list(plan.dimensions)
    if plan.compare:
        dims = ["period"] + dims
    item_dims = any(layer.dimensions[d].grain == "item" for d in list(plan.dimensions) + list(plan.filters))
    specs = []
    for i, (gkey, members) in enumerate(groups, start=1):
        repurchase = gkey.startswith("repurchase:")
        item_grain = not repurchase and (item_dims or any(layer.metrics[m].grain == "item" for m in members))
        order_by = plan.order_by if plan.order_by in members else (members[0] if plan.order else None)
        spec = QuerySpec(
            key=f"q{i}", metrics=members, dimensions=dims, filters=dict(plan.filters), time=plan.time,
            compare_time=plan.compare_time, order=plan.order, order_by=order_by, limit=plan.limit,
            item_grain=item_grain, repurchase=repurchase,
        )
        spec.columns = _columns(spec, layer)
        specs.append(spec)
    return specs


def _columns(spec: QuerySpec, layer: SemanticLayer) -> list[dict[str, Any]]:
    cols: list[dict[str, Any]] = []
    for d in spec.dimensions:
        cols.append({"key": d, "label": layer.label(d), "role": "dimension", "format": "text", "unit": "",
                     "time": d == "period" or layer.dimensions[d].is_time})
    seen = {c["key"] for c in cols}
    for m in spec.metrics:
        for comp in layer.metrics[m].components:
            if comp not in seen and comp not in spec.metrics:
                cols.append({"key": comp, "label": layer.label(comp), "role": "component",
                             "format": layer.format_of(comp), "unit": layer.unit_of(comp)})
                seen.add(comp)
        if m not in seen:
            cols.append({"key": m, "label": layer.label(m), "role": "metric", "format": layer.format_of(m),
                         "unit": layer.unit_of(m)})
            seen.add(m)
    return cols


def _dimension_expr(key: str, spec: QuerySpec, layer: SemanticLayer) -> str:
    if key == "period":
        date_col = layer.calendar.date_column
        cur, prev = spec.time, spec.compare_time
        assert prev is not None
        return (f"CASE WHEN {_between(date_col, cur)} THEN {_lit(cur.period_key)} "
                f"ELSE {_lit(prev.period_key)} END")
    return layer.dimensions[key].expr


def _from_and_joins(base: str, needed: set[str], layer: SemanticLayer) -> list[str]:
    edges = []
    for table in sorted(needed - {base}):
        path = layer.join_path(base, table)
        if path is None:
            raise ValueError(f"无法从 {base} 关联到 {table}（只允许多对一关联）")
        for j in path:
            if j not in edges:
                edges.append(j)
    joined = {base}
    lines = [f"FROM {base} AS {layer.tables[base].alias}"]
    pending = list(edges)
    while pending:  # emit each join only after its left side is in the FROM clause
        for j in pending:
            if j.from_table in joined:
                lines.append(f"JOIN {j.to_table} AS {layer.tables[j.to_table].alias} ON {j.on}")
                joined.add(j.to_table)
                pending.remove(j)
                break
        else:
            raise ValueError("关联路径无法排序")
    return lines


def _where(spec: QuerySpec, layer: SemanticLayer, metric_filter: str) -> list[str]:
    date_col = layer.calendar.date_column
    parts = [metric_filter]
    if spec.compare_time is not None:
        parts.append(f"({_between(date_col, spec.time)} OR {_between(date_col, spec.compare_time)})")
    else:
        parts.append(_between(date_col, spec.time))
    for key, values in spec.filters.items():
        parts.append(_in(layer.dimensions[key].expr, values))
    return parts


def _order(spec: QuerySpec, dims: list[str], layer: SemanticLayer) -> str | None:
    time_dims = [d for d in dims if d == "period" or (d in layer.dimensions and layer.dimensions[d].is_time)]
    if spec.order and spec.order_by:
        tail = [f"{d}" for d in dims]
        return ", ".join([f"{spec.order_by} {spec.order.upper()}"] + tail)
    if time_dims:
        return ", ".join(dims)
    if dims:
        first_metric = next(c["key"] for c in spec.columns if c["role"] == "metric")
        return ", ".join([f"{first_metric} DESC"] + dims)
    return None


def compile_spec(spec: QuerySpec, layer: SemanticLayer, max_rows: int) -> str:
    if spec.repurchase:
        return _compile_repurchase(spec, layer, max_rows)
    base = "order_items" if spec.item_grain else "orders"
    metric = layer.metrics[spec.metrics[0]]
    dims = spec.dimensions
    select: list[str] = []
    needed = {base, "orders"}  # the date column lives on orders
    for d in dims:
        expr = _dimension_expr(d, spec, layer)
        select.append(f"{expr} AS {d}")
        needed |= layer.tables_in(expr)
    for col in spec.columns:
        if col["role"] == "dimension":
            continue
        expr = layer.metric_expr(col["key"], spec.item_grain)
        if expr is None:
            raise ValueError(f"{layer.label(col['key'])} 不支持当前粒度")
        select.append(f"{expr} AS {col['key']}")
        needed |= layer.tables_in(expr)
    needed |= layer.tables_in(metric.filter)
    for key in spec.filters:
        needed |= layer.tables_in(layer.dimensions[key].expr)

    lines = ["SELECT", "  " + ",\n  ".join(select)]
    lines += _from_and_joins(base, needed, layer)
    lines.append("WHERE " + "\n  AND ".join(_where(spec, layer, metric.filter)))
    if dims:
        lines.append("GROUP BY " + ", ".join(_dimension_expr(d, spec, layer) for d in dims))
    order = _order(spec, dims, layer)
    if order:
        lines.append(f"ORDER BY {order}")
    lines.append(f"LIMIT {min(spec.limit or max_rows, max_rows)}")
    return "\n".join(lines)


def _compile_repurchase(spec: QuerySpec, layer: SemanticLayer, max_rows: int) -> str:
    metric = layer.metrics[spec.metrics[0]]
    dims = spec.dimensions
    inner_select = ["o.customer_id AS customer_id"]
    needed = {"orders"}
    for d in dims:
        expr = _dimension_expr(d, spec, layer)
        inner_select.append(f"{expr} AS {d}")
        needed |= layer.tables_in(expr)
    inner_select.append("COUNT(DISTINCT o.order_id) AS orders_in_period")
    for key in spec.filters:
        needed |= layer.tables_in(layer.dimensions[key].expr)
    inner = ["SELECT", "    " + ",\n    ".join(inner_select)]
    inner += ["  " + line for line in _from_and_joins("orders", needed, layer)]
    inner.append("  WHERE " + "\n    AND ".join(_where(spec, layer, metric.filter)))
    inner.append("  GROUP BY " + ", ".join(["o.customer_id"] + [_dimension_expr(d, spec, layer) for d in dims]))

    repeat = "SUM(CASE WHEN t.orders_in_period >= 2 THEN 1 ELSE 0 END)"
    outer = [f"t.{d} AS {d}" for d in dims] + [
        f"{repeat} AS repeat_buyers",
        "COUNT(*) AS buyer_count",
        f"ROUND({repeat} * 1.0 / NULLIF(COUNT(*), 0), 4) AS {metric.key}",
    ]
    lines = ["SELECT", "  " + ",\n  ".join(outer), "FROM (", *inner, ") AS t"]
    if dims:
        lines.append("GROUP BY " + ", ".join(f"t.{d}" for d in dims))
    order = _order(spec, dims, layer)
    if order:
        lines.append(f"ORDER BY {order}")
    lines.append(f"LIMIT {min(spec.limit or max_rows, max_rows)}")
    return "\n".join(lines)
