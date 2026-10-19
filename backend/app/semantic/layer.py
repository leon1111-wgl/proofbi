"""Load and validate the semantic layer (``semantic/retail.yaml``).

The YAML is the single source of truth for metric definitions (口径). Loading fails
loudly on anything inconsistent: an expression that does not parse, an alias that no
table declares, an ambiguous term pointing at an unknown metric. A broken definition
should stop the deploy, not produce a wrong number later.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import sqlglot
import yaml
from sqlglot import exp


class SemanticError(ValueError):
    """The semantic layer definition is invalid."""


@dataclass
class Column:
    name: str
    label: str
    description: str = ""
    sensitive: bool = False  # never queryable (e.g. phone numbers)
    requires: str | None = None  # permission needed to read it (e.g. cost)


@dataclass
class Table:
    name: str
    alias: str
    label: str
    description: str
    columns: dict[str, Column]


@dataclass
class Join:
    from_table: str
    to_table: str
    on: str


@dataclass
class Dimension:
    key: str
    label: str
    expr: str
    table: str
    description: str = ""
    synonyms: list[str] = field(default_factory=list)
    values: list[str] = field(default_factory=list)
    value_synonyms: dict[str, list[str]] = field(default_factory=dict)
    grain: str = "order"  # order | item: item-grain dimensions need order_items as the base table
    time_grain: str | None = None  # month | day

    @property
    def is_time(self) -> bool:
        return self.time_grain is not None


@dataclass
class Metric:
    key: str
    label: str
    description: str
    expr: str | None
    filter: str
    format: str
    type: str = "simple"  # simple | repurchase
    item_expr: str | None = None
    unit: str = ""
    components: list[str] = field(default_factory=list)
    synonyms: list[str] = field(default_factory=list)
    dimensions: list[str] | None = None  # allowed dimensions (None = every compatible one)
    grain: str = "order"
    requires: str | None = None
    lint: dict[str, Any] = field(default_factory=dict)


@dataclass
class Component:
    key: str
    label: str
    format: str
    expr: str | None = None
    unit: str = ""


@dataclass
class Calendar:
    today: date
    data_start: date
    data_end: date
    date_column: str
    default_range_days: int = 30
    default_trend_months: int = 6


def _aliases_in(sql: str) -> set[str]:
    try:
        tree = sqlglot.parse_one(sql, read="sqlite")
    except sqlglot.errors.ParseError as exc:
        raise SemanticError(f"表达式无法解析：{sql}（{exc}）") from exc
    return {c.table for c in tree.find_all(exp.Column) if c.table}


def _is_fanout_safe(expr: str) -> bool:
    """True when every aggregate is COUNT(DISTINCT ...): joining extra rows cannot change it."""
    tree = sqlglot.parse_one(expr, read="sqlite")
    aggs = list(tree.find_all(exp.AggFunc))
    return bool(aggs) and all(isinstance(a, exp.Count) and isinstance(a.this, exp.Distinct) for a in aggs)


class SemanticLayer:
    def __init__(self, data: dict[str, Any], today_override: str | None = None):
        self.raw = data
        self.name: str = data.get("name", "")
        self.description: str = data.get("description", "")
        cal = data["calendar"]
        self.calendar = Calendar(
            today=date.fromisoformat(today_override or str(cal["today"])),
            data_start=date.fromisoformat(str(cal["data_start"])),
            data_end=date.fromisoformat(str(cal["data_end"])),
            date_column=cal["date_column"],
            default_range_days=int(cal.get("default_range_days", 30)),
            default_trend_months=int(cal.get("default_trend_months", 6)),
        )
        self.tables: dict[str, Table] = {}
        for name, t in data["tables"].items():
            cols = {c: Column(c, v.get("label", c), v.get("description", ""), bool(v.get("sensitive")), v.get("requires"))
                    for c, v in (t.get("columns") or {}).items()}
            self.tables[name] = Table(name, t["alias"], t.get("label", name), t.get("description", ""), cols)
        self.alias_to_table = {t.alias: t.name for t in self.tables.values()}
        self.joins = [Join(j["from"], j["to"], j["condition"]) for j in data.get("joins", [])]
        self.dimensions: dict[str, Dimension] = {}
        for key, d in data["dimensions"].items():
            self.dimensions[key] = Dimension(
                key=key, label=d["label"], expr=d["expr"], table=d["table"], description=d.get("description", ""),
                synonyms=list(d.get("synonyms") or []), values=[str(v) for v in d.get("values") or []],
                value_synonyms={str(k): [str(x) for x in v] for k, v in (d.get("value_synonyms") or {}).items()},
                grain=d.get("grain", "order"), time_grain=d.get("time_grain"),
            )
        self.metrics: dict[str, Metric] = {}
        for key, m in data["metrics"].items():
            self.metrics[key] = Metric(
                key=key, label=m["label"], description=m.get("description", ""), expr=m.get("expr"),
                filter=m["filter"], format=m.get("format", "number"), type=m.get("type", "simple"),
                item_expr=m.get("item_expr"), unit=m.get("unit", ""), components=list(m.get("components") or []),
                synonyms=list(m.get("synonyms") or []), dimensions=m.get("dimensions"), grain=m.get("grain", "order"),
                requires=m.get("requires"), lint=dict(m.get("lint") or {}),
            )
        self.components: dict[str, Component] = {
            key: Component(key, c["label"], c.get("format", "number"), c.get("expr"), c.get("unit", ""))
            for key, c in (data.get("components") or {}).items()
        }
        self.ambiguous: dict[str, list[str]] = {k: list(v) for k, v in (data.get("ambiguous_terms") or {}).items()}
        self._validate()

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, path: str | Path, today_override: str | None = None) -> "SemanticLayer":
        with open(path, encoding="utf-8") as fh:
            return cls(yaml.safe_load(fh), today_override)

    def _check_aliases(self, where: str, sql: str) -> None:
        unknown = _aliases_in(sql) - set(self.alias_to_table)
        if unknown:
            raise SemanticError(f"{where} 引用了未声明的表别名：{', '.join(sorted(unknown))}")

    def _validate(self) -> None:
        cal = self.calendar
        if not cal.data_start <= cal.data_end:
            raise SemanticError("calendar.data_start 必须早于 data_end")
        for j in self.joins:
            for t in (j.from_table, j.to_table):
                if t not in self.tables:
                    raise SemanticError(f"join 引用了未知的表：{t}")
            self._check_aliases(f"join {j.from_table}->{j.to_table}", j.on)
        for d in self.dimensions.values():
            if d.table not in self.tables:
                raise SemanticError(f"维度 {d.key} 的表 {d.table} 不存在")
            self._check_aliases(f"维度 {d.key}", d.expr)
            for alias, targets in d.value_synonyms.items():
                missing = [t for t in targets if t not in d.values]
                if missing:
                    raise SemanticError(f"维度 {d.key} 的同义词 {alias} 指向未声明的取值：{missing}")
        for m in self.metrics.values():
            if m.type not in ("simple", "repurchase"):
                raise SemanticError(f"指标 {m.key} 的类型 {m.type} 不受支持")
            if m.type == "simple" and not m.expr:
                raise SemanticError(f"指标 {m.key} 缺少 expr")
            for label, sql in (("expr", m.expr), ("item_expr", m.item_expr), ("filter", m.filter)):
                if sql:
                    self._check_aliases(f"指标 {m.key}.{label}", sql)
            for c in m.components:
                if c not in self.metrics and c not in self.components:
                    raise SemanticError(f"指标 {m.key} 的组成部分 {c} 未定义")
            for d in m.dimensions or []:
                if d not in self.dimensions:
                    raise SemanticError(f"指标 {m.key} 允许的维度 {d} 未定义")
            if m.format not in ("currency", "percent", "integer", "number"):
                raise SemanticError(f"指标 {m.key} 的格式 {m.format} 不受支持")
        for term, targets in self.ambiguous.items():
            for t in targets:
                if t not in self.metrics:
                    raise SemanticError(f"歧义词 {term} 指向未定义的指标 {t}")
        for c in self.components.values():
            if c.expr:
                self._check_aliases(f"组成部分 {c.key}", c.expr)
        for base in ("orders", "order_items"):
            if base not in self.tables:
                raise SemanticError(f"语义层缺少基础表 {base}")

    # ------------------------------------------------------------------ lookups
    def tables_in(self, sql: str) -> set[str]:
        return {self.alias_to_table[a] for a in _aliases_in(sql)}

    def join_path(self, base: str, target: str) -> list[Join] | None:
        """Shortest chain of many-to-one joins from ``base`` to ``target`` (BFS)."""
        if base == target:
            return []
        queue: deque[tuple[str, list[Join]]] = deque([(base, [])])
        seen = {base}
        while queue:
            table, path = queue.popleft()
            for j in self.joins:
                if j.from_table == table and j.to_table not in seen:
                    if j.to_table == target:
                        return path + [j]
                    seen.add(j.to_table)
                    queue.append((j.to_table, path + [j]))
        return None

    def metric_expr(self, key: str, item_grain: bool) -> str | None:
        """Expression for a metric or component at the given grain; None if unsupported."""
        if key in self.metrics:
            m = self.metrics[key]
            if m.type != "simple":
                return None
            if item_grain:
                if m.item_expr:
                    return m.item_expr
                return m.expr if _is_fanout_safe(m.expr or "") else None
            return m.expr
        comp = self.components.get(key)
        if comp is None or comp.expr is None:
            return None
        if item_grain and "oi." not in comp.expr and not _is_fanout_safe(comp.expr):
            return None
        return comp.expr

    def supports_item_grain(self, metric_key: str) -> bool:
        m = self.metrics[metric_key]
        if m.type != "simple":
            return False
        return self.metric_expr(metric_key, True) is not None and all(
            self.metric_expr(c, True) is not None for c in m.components)

    def allowed_dimensions(self, metric_key: str) -> list[str]:
        m = self.metrics[metric_key]
        if m.dimensions is not None:
            return list(m.dimensions)
        item_ok = self.supports_item_grain(metric_key)
        return [k for k, d in self.dimensions.items() if d.grain != "item" or item_ok]

    def label(self, key: str) -> str:
        if key in self.metrics:
            return self.metrics[key].label
        if key in self.components:
            return self.components[key].label
        if key in self.dimensions:
            return self.dimensions[key].label
        return {"period": "统计周期"}.get(key, key)

    def format_of(self, key: str) -> str:
        if key in self.metrics:
            return self.metrics[key].format
        if key in self.components:
            return self.components[key].format
        return "text"

    def unit_of(self, key: str) -> str:
        if key in self.metrics:
            return self.metrics[key].unit
        if key in self.components:
            return self.components[key].unit
        return ""

    def allowed_columns(self, permissions: set[str] | frozenset[str]) -> dict[str, set[str]]:
        """Columns a user may read: everything except sensitive columns and those whose
        permission the user lacks. Used by the guard, the policy views and the authorizer."""
        allowed: dict[str, set[str]] = {}
        for t in self.tables.values():
            allowed[t.name] = {c.name for c in t.columns.values()
                               if not c.sensitive and (c.requires is None or c.requires in permissions)}
        return allowed

    def blocked_columns(self, permissions: set[str] | frozenset[str]) -> dict[str, str]:
        """column name -> reason, for friendly guard errors."""
        blocked: dict[str, str] = {}
        for t in self.tables.values():
            for c in t.columns.values():
                if c.sensitive:
                    blocked[c.name] = f"{t.label}.{c.label} 是敏感字段，不允许查询"
                elif c.requires and c.requires not in permissions:
                    blocked[c.name] = f"{t.label}.{c.label} 需要“{c.requires}”数据权限"
        return blocked

    def to_public(self, permissions: set[str] | frozenset[str]) -> dict[str, Any]:
        """Catalog for the UI and for LLM prompts."""
        cal = self.calendar
        return {
            "name": self.name,
            "description": self.description,
            "calendar": {"today": cal.today.isoformat(), "data_start": cal.data_start.isoformat(),
                         "data_end": cal.data_end.isoformat()},
            "metrics": [
                {"key": m.key, "label": m.label, "description": m.description, "type": m.type,
                 "expr": m.expr, "item_expr": m.item_expr, "filter": m.filter, "format": m.format, "unit": m.unit,
                 "components": m.components, "synonyms": m.synonyms, "dimensions": self.allowed_dimensions(m.key),
                 "requires": m.requires, "accessible": m.requires is None or m.requires in permissions}
                for m in self.metrics.values()
            ],
            "dimensions": [
                {"key": d.key, "label": d.label, "expr": d.expr, "table": d.table, "description": d.description,
                 "synonyms": d.synonyms, "values": d.values, "grain": d.grain, "time_grain": d.time_grain}
                for d in self.dimensions.values()
            ],
            "tables": [
                {"name": t.name, "alias": t.alias, "label": t.label, "description": t.description,
                 "columns": [{"name": c.name, "label": c.label, "description": c.description,
                              "sensitive": c.sensitive, "requires": c.requires,
                              "readable": not c.sensitive and (c.requires is None or c.requires in permissions)}
                             for c in t.columns.values()]}
                for t in self.tables.values()
            ],
            "joins": [{"from": j.from_table, "to": j.to_table, "on": j.on} for j in self.joins],
            "ambiguous_terms": self.ambiguous,
        }
