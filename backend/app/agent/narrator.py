"""Answers and charts from query results.

``TemplateNarrator`` is the offline model: fixed sentence patterns that quote result cells
with the shared formatting rules, so every number it writes can be verified. Charts are
plain specs (type, x, y, series) rendered by the console from the same rows.

``align_columns`` maps result columns back to semantic keys. Template SQL always aliases
columns with the semantic key; SQL written by an LLM might not, so unknown columns fall
back to "text = dimension, number = metric".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..semantic.compiler import QuerySpec
from ..semantic.layer import SemanticLayer
from ..semantic.plan import Plan
from .numbers import column_uses_wan, format_value

FILTER_TEMPLATES = {"region": "{}区", "channel": "{}渠道", "category": "{}品类", "age_band": "{}用户"}


@dataclass
class QueryOutput:
    spec: QuerySpec
    query_id: str
    columns: list[str]
    rows: list[list[Any]]
    meta: list[dict[str, Any]] = field(default_factory=list)  # aligned column metadata


def align_columns(spec: QuerySpec, columns: list[str], rows: list[list[Any]], layer: SemanticLayer) -> list[dict]:
    by_key = {c["key"]: c for c in spec.columns}
    meta = []
    for i, name in enumerate(columns):
        key = name.lower()
        if key in by_key:
            meta.append(dict(by_key[key], key=name))
            continue
        numeric = any(isinstance(r[i], (int, float)) and not isinstance(r[i], bool) for r in rows)
        semantic = key if key in layer.metrics or key in layer.components or key in layer.dimensions else None
        role = "metric" if numeric else "dimension"
        meta.append({"key": name, "label": layer.label(semantic) if semantic else name, "role": role,
                     "format": layer.format_of(semantic) if semantic and numeric else ("number" if numeric else "text"),
                     "unit": layer.unit_of(semantic) if semantic else "",
                     "time": bool(semantic and semantic in layer.dimensions and layer.dimensions[semantic].is_time)})
    return meta


def scope_text(filters: dict[str, list[str]], layer: SemanticLayer) -> str:
    parts = []
    for key, values in filters.items():
        joined = "、".join(values)
        parts.append(FILTER_TEMPLATES.get(key, "{}").format(joined))
    return "、".join(parts) + "的" if parts else ""


def chart_for(output: QueryOutput) -> dict[str, Any]:
    meta = output.meta
    dims = [m for m in meta if m["role"] == "dimension"]
    metrics = [m for m in meta if m["role"] == "metric"] or [m for m in meta if m["role"] == "component"]
    base = {"query_id": output.query_id}
    if not output.rows or not metrics:
        return {**base, "type": "table"}
    if not dims:
        items = [m for m in meta if m["role"] in ("metric", "component")]
        return {**base, "type": "kpi", "items": [m["key"] for m in items]}
    y = metrics[0]["key"]
    if len(dims) == 1:
        d = dims[0]
        if d["key"] == "period":
            return {**base, "type": "compare", "x": "period", "y": y}
        if d.get("time"):
            return {**base, "type": "line", "x": d["key"], "y": y}
        return {**base, "type": "bar", "x": d["key"], "y": y}
    if len(dims) == 2:
        time_dims = [d for d in dims if d.get("time") or d["key"] == "period"]
        other = [d for d in dims if d not in time_dims]
        series_values = {r[[m["key"] for m in meta].index(other[0]["key"])] for r in output.rows} if other else set()
        if time_dims and other and len(series_values) <= 8:
            kind = "bar" if time_dims[0]["key"] == "period" else "line"
            x, series = (other[0]["key"], "period") if kind == "bar" else (time_dims[0]["key"], other[0]["key"])
            return {**base, "type": kind, "x": x, "y": y, "series": series}
    return {**base, "type": "table"}


class TemplateNarrator:
    name = "template"

    def __init__(self, layer: SemanticLayer):
        self.layer = layer

    def narrate(self, plan: Plan, outputs: list[QueryOutput], hallucinate: bool = False, question: str = "") -> str:
        sentences: list[str] = []
        for i, out in enumerate(outputs):
            sentences.extend(self._for_query(plan, out, with_period=i == 0))
        text = "".join(sentences)
        if hallucinate:
            text = _perturb_first_number(text, outputs)
        return text

    # -------------------------------------------------------------- helpers
    def _fmt(self, meta: dict, value) -> str:
        return format_value(value, meta["format"], meta.get("unit", ""), meta.get("wan"))

    def _for_query(self, plan: Plan, out: QueryOutput, with_period: bool = True) -> list[str]:
        rows = out.rows
        keys = [m["key"] for m in out.meta]
        # one scale per column, so a sentence never mixes 万元 and 元 for the same measure
        meta = [dict(m, wan=column_uses_wan([r[i] for r in rows])) for i, m in enumerate(out.meta)]
        dims = [m for m in meta if m["role"] == "dimension"]
        metrics = [m for m in meta if m["role"] == "metric"]
        if not metrics:
            return ["结果见下方表格。"]
        # a filtered dimension that is also the split is named by the rows themselves
        scope = scope_text({k: v for k, v in out.spec.filters.items() if k not in out.spec.dimensions}, self.layer)
        period = plan.time.label if with_period else "同期"
        if not rows:
            return [f"{period}，{scope}没有符合条件的数据。"]

        def val(row, m):
            return row[keys.index(m["key"])]

        if not dims:
            row = rows[0]
            parts = []
            for m in metrics:
                comps = [c for c in meta if c["role"] == "component" and c["key"] in self.layer.metrics.get(
                    m["key"], _Empty).components]
                detail = "，".join(f"{c['label']} {self._fmt(c, val(row, c))}" for c in comps)
                parts.append(f"{m['label']}为 {self._fmt(m, val(row, m))}" + (f"（{detail}）" if detail else ""))
            return [f"{period}，{scope}" + "，".join(parts) + "。"]

        primary = metrics[0]
        if len(dims) == 1 and dims[0]["key"] == "period":
            return [self._compare_sentence(plan, scope, primary, meta, rows)]

        if len(dims) == 1:
            d = dims[0]
            label = lambda row: str(row[keys.index(d["key"])])  # noqa: E731
            if d.get("time"):
                first, last = rows[0], rows[-1]
                hi = max(rows, key=lambda r: val(r, primary) or 0)
                lo = min(rows, key=lambda r: val(r, primary) or 0)
                return [f"{scope}{primary['label']}从 {label(first)} 的 {self._fmt(primary, val(first, primary))} "
                        f"变为 {label(last)} 的 {self._fmt(primary, val(last, primary))}；期间最高为 {label(hi)}"
                        f"（{self._fmt(primary, val(hi, primary))}），最低为 {label(lo)}（{self._fmt(primary, val(lo, primary))}）。"]
            if plan.limit == 1:
                word = "最低" if plan.order == "asc" else "最高"
                return [f"{period}，{scope}{primary['label']}{word}的{d['label']}是{label(rows[0])}，"
                        f"为 {self._fmt(primary, val(rows[0], primary))}。"]
            if len(rows) == 1:
                return [f"{period}，{scope}{d['label']}“{label(rows[0])}”的{primary['label']}为 "
                        f"{self._fmt(primary, val(rows[0], primary))}。"]
            if plan.limit:
                word = "最低" if plan.order == "asc" else "排名"
                items = "、".join(f"{label(r)}（{self._fmt(primary, val(r, primary))}）" for r in rows)
                return [f"{period}，{scope}{primary['label']}{word}前 {len(rows)} 的{d['label']}依次是：{items}。"]
            ordered = sorted(rows, key=lambda r: val(r, primary) or 0, reverse=True)
            top, bottom = ordered[0], ordered[-1]
            return [f"{period}，{scope}{primary['label']}最高的{d['label']}是{label(top)}"
                    f"（{self._fmt(primary, val(top, primary))}），最低的是{label(bottom)}"
                    f"（{self._fmt(primary, val(bottom, primary))}）。"]

        if any(d["key"] == "period" for d in dims) and len(dims) == 2:
            return [self._compare_by_group(plan, scope, primary, meta, rows)]
        best = max(rows, key=lambda r: val(r, primary) or 0)
        combo = " · ".join(str(best[keys.index(d["key"])]) for d in dims)
        names = "和".join(d["label"] for d in dims)
        return [f"{period}，{scope}按{names}拆分的结果见下表；{primary['label']}最高的组合是 {combo}"
                f"（{self._fmt(primary, val(best, primary))}）。"]

    def _change_text(self, primary: dict, current, previous) -> str:
        if current is None or previous in (None, 0):
            return "无法计算变化"
        if primary["format"] == "percent":
            diff = (float(current) - float(previous)) * 100
            if round(diff, 1) == 0:
                return "持平"
            return f"{'上升' if diff > 0 else '下降'} {abs(diff):.1f} 个百分点"
        change = (float(current) - float(previous)) / float(previous) * 100
        if round(change, 1) == 0:
            return "持平"
        return f"{'上升' if change > 0 else '下降'} {abs(change):.1f}%"

    def _compare_sentence(self, plan: Plan, scope: str, primary: dict, meta: list[dict], rows) -> str:
        keys = [m["key"] for m in meta]
        by_period = {row[keys.index("period")]: row for row in rows}
        cur_key = plan.time.period_key
        prev_key = plan.compare_time.period_key if plan.compare_time else None
        cur, prev = by_period.get(cur_key), by_period.get(prev_key)
        word = "同比" if plan.compare == "yoy" else "环比"
        if cur is None or prev is None:
            return f"{scope}{primary['label']}缺少对比期数据，无法计算{word}。"
        v_cur, v_prev = cur[keys.index(primary["key"])], prev[keys.index(primary["key"])]
        return (f"{scope}{primary['label']}：{cur_key} 为 {self._fmt(primary, v_cur)}，{prev_key} 为 "
                f"{self._fmt(primary, v_prev)}，{word}{self._change_text(primary, v_cur, v_prev)}。")

    def _compare_by_group(self, plan: Plan, scope: str, primary: dict, meta: list[dict], rows) -> str:
        keys = [m["key"] for m in meta]
        group = next(m for m in meta if m["role"] == "dimension" and m["key"] != "period")
        cur_key = plan.time.period_key
        prev_key = plan.compare_time.period_key if plan.compare_time else None
        pairs: dict[str, dict[str, Any]] = {}
        for row in rows:
            pairs.setdefault(row[keys.index(group["key"])], {})[row[keys.index("period")]] = row[keys.index(primary["key"])]
        word = "同比" if plan.compare == "yoy" else "环比"
        movers = [(g, v[cur_key], v[prev_key]) for g, v in pairs.items()
                  if v.get(cur_key) is not None and v.get(prev_key) not in (None, 0)]
        if not movers:
            return f"{scope}{primary['label']}缺少对比期数据，无法计算{word}。"
        if primary["format"] == "percent":
            g, c, p = max(movers, key=lambda x: abs(float(x[1]) - float(x[2])))
        else:
            g, c, p = max(movers, key=lambda x: abs((float(x[1]) - float(x[2])) / float(x[2])))
        return (f"按{group['label']}看，{scope}{primary['label']}{word}变化最大的是{g}：{prev_key} 为 "
                f"{self._fmt(primary, p)}，{cur_key} 为 {self._fmt(primary, c)}，{self._change_text(primary, c, p)}。")


class _Empty:
    components: list[str] = []


def _perturb_first_number(text: str, outputs: list[QueryOutput]) -> str:
    """Demo fault: replace the first metric value with a slightly wrong one (×1.08)."""
    for out in outputs:
        keys = [m["key"] for m in out.meta]
        for m in out.meta:
            if m["role"] != "metric" or not out.rows:
                continue
            value = out.rows[0][keys.index(m["key"])]
            if not isinstance(value, (int, float)):
                continue
            wan = column_uses_wan([r[keys.index(m["key"])] for r in out.rows])
            right = format_value(value, m["format"], m.get("unit", ""), wan)
            wrong = format_value(value * 1.08 if m["format"] != "integer" else int(value * 1.08) + 1, m["format"],
                                 m.get("unit", ""), wan)
            if right in text:
                return text.replace(right, wrong, 1)
    return text
