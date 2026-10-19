"""LLM-backed planner, SQL writer and narrator.

Each one keeps the deterministic parts in code and falls back to its offline counterpart
when the model call fails, recording the fallback in the trace:
- the planner runs the same screening as the rules planner first (writes, sensitive data,
  ambiguous words), resolves relative dates with the shared parser, and its plan goes
  through the same ``validate_plan``;
- the SQL writer gets the user's readable schema and the metric definitions, and its SQL
  is still guarded, linted, rewritten for RLS and executed read-only;
- the narrator's numbers are still verified against the result rows.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..llm.base import ChatMessage, ChatModel, LLMError, extract_json, extract_sql
from ..llm.prompts import (NARRATOR_SYSTEM, NARRATOR_TASK, PLANNER_CONTEXT, PLANNER_SYSTEM, SQL_RETRY, SQL_SYSTEM,
                           SQL_TASK)
from ..semantic.access import User
from ..semantic.compiler import QuerySpec
from ..semantic.layer import SemanticLayer
from ..semantic.plan import REFUSAL_TEXT, Plan
from ..semantic.timeparse import OutOfRange, TimeRange, default_range, parse_time, previous_period
from .narrator import QueryOutput, TemplateNarrator
from .numbers import format_value
from .planner import Lookups, PlanOutcome, RulesPlanner, validate_plan
from .sql_writer import TemplateSQLWriter, WriteResult


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: int = 0
    fallbacks: int = 0

    def add(self, result) -> None:
        self.prompt_tokens += result.prompt_tokens
        self.completion_tokens += result.completion_tokens
        self.calls += 1


class LLMPlanner:
    name = "llm"

    def __init__(self, model: ChatModel, layer: SemanticLayer, lookups: Lookups, rules: RulesPlanner):
        self.model = model
        self.layer = layer
        self.lookups = lookups
        self.rules = rules
        self.usage = Usage()

    def _catalog(self) -> tuple[str, str]:
        metrics = "\n".join(f"- {m.key}：{m.label}｜{m.description}｜{'、'.join(m.synonyms)}" for m in self.layer.metrics.values())
        dims = "\n".join(f"- {d.key}：{d.label}｜{'、'.join(d.values) or '（任意）'}" for d in self.layer.dimensions.values())
        return metrics, dims

    def plan(self, question: str, user: User, context: dict | None = None,
             clarifications: dict[str, str] | None = None) -> PlanOutcome:
        screened = self.rules.screen(question, clarifications)
        if screened is not None:
            return screened
        metrics, dims = self._catalog()
        cal = self.layer.calendar
        system = PLANNER_SYSTEM.format(
            today=cal.today.isoformat(), data_start=cal.data_start.isoformat(), data_end=cal.data_end.isoformat(),
            user=f"{user.name}（{user.title}）", scope=user.scope_label(self.lookups.region_names, self.lookups.store_names),
            metrics=metrics, dimensions=dims,
            context=PLANNER_CONTEXT.format(previous=json.dumps(context, ensure_ascii=False)) if context else "",
        )
        if clarifications:
            question = f"{question}\n（已确认口径：{json.dumps(clarifications, ensure_ascii=False)}）"
        messages = [ChatMessage("system", system), ChatMessage("user", question)]
        for _ in range(2):
            try:
                result = self.model.chat(messages, json_mode=True)
            except LLMError as exc:
                self.usage.fallbacks += 1
                outcome = self.rules.plan(question, user, context, clarifications)
                outcome.trace["fallback"] = f"模型调用失败，已回退到规则解析：{exc}"
                return outcome
            self.usage.add(result)
            try:
                return self._to_outcome(extract_json(result.content), question, user)
            except (ValueError, KeyError, TypeError) as exc:
                messages += [ChatMessage("assistant", result.content),
                             ChatMessage("user", f"输出无法使用：{exc}。请只输出符合格式的 JSON。")]
        outcome = self.rules.plan(question, user, context, clarifications)
        outcome.trace["fallback"] = "模型两次输出都无法解析，已回退到规则解析"
        self.usage.fallbacks += 1
        return outcome

    def _to_outcome(self, data: dict[str, Any], question: str, user: User) -> PlanOutcome:
        trace = {"planner": self.name, "raw_plan": data}
        if data.get("kind") == "refuse":
            reason = data.get("reason") if data.get("reason") in REFUSAL_TEXT else "off_topic"
            return PlanOutcome.refuse(reason, str(data.get("message") or REFUSAL_TEXT[reason]), **trace)
        metrics = [str(m) for m in data.get("metrics") or []]
        unknown = [m for m in metrics if m not in self.layer.metrics]
        if unknown or not metrics:
            raise ValueError(f"未知指标 {unknown or '（空）'}，只能使用：{', '.join(self.layer.metrics)}")
        dims = [str(d) for d in data.get("dimensions") or []]
        bad_dims = [d for d in dims if d not in self.layer.dimensions]
        if bad_dims:
            raise ValueError(f"未知维度 {bad_dims}")
        filters = {str(k): [str(v) for v in (vals if isinstance(vals, list) else [vals])]
                   for k, vals in (data.get("filters") or {}).items()}
        cal = self.layer.calendar
        time: TimeRange | None = None
        try:
            if data.get("time_expression"):
                time = parse_time(str(data["time_expression"]), cal)
            if time is None and data.get("start") and data.get("end"):
                time = parse_time(f"{data['start']}到{data['end']}", cal)
        except OutOfRange as exc:
            return PlanOutcome.refuse("out_of_range", str(exc), **trace)
        if time is None:
            time = default_range(cal, trend=any(self.layer.dimensions[d].is_time for d in dims))
        compare = data.get("compare") if data.get("compare") in ("mom", "yoy") else None
        compare_time = previous_period(time, compare) if compare else None
        notes = list(time.notes)
        if compare_time and compare_time.start < cal.data_start:
            notes.append("对比期没有完整数据，本次不做对比。")
            compare, compare_time = None, None
        order = data.get("order") if data.get("order") in ("desc", "asc") else None
        limit = int(data["limit"]) if isinstance(data.get("limit"), int) else None
        plan = Plan(metrics=metrics, time=time, dimensions=dims, filters=filters, compare=compare,
                    compare_time=compare_time, order=order, order_by=metrics[0] if order else None, limit=limit,
                    notes=notes)
        return validate_plan(plan, user, self.layer, self.lookups, trace)


class LLMSQLWriter:
    name = "llm"

    def __init__(self, model: ChatModel, layer: SemanticLayer, fallback: TemplateSQLWriter):
        self.model = model
        self.layer = layer
        self.fallback = fallback
        self.usage = Usage()

    def _schema(self, allowed_columns: dict[str, set[str]]) -> str:
        lines = []
        for t in self.layer.tables.values():
            cols = [f"{c.name}（{c.label}）" for c in t.columns.values() if c.name in allowed_columns.get(t.name, set())]
            lines.append(f"{t.name} AS {t.alias}：{', '.join(cols)}")
        return "\n".join(lines)

    def _metrics(self, spec: QuerySpec) -> str:
        lines = []
        for key in spec.metrics:
            m = self.layer.metrics[key]
            if m.type == "repurchase":
                lines.append(f"- {key}（{m.label}）：{m.description} 先按客户（和分组维度）统计期内订单数，"
                             f"再算 订单数>=2 的客户占比；过滤条件 {m.filter}；同时输出 repeat_buyers 和 buyer_count")
                continue
            expr = m.item_expr if spec.item_grain and m.item_expr else m.expr
            comps = [f"{c} = {self.layer.metric_expr(c, spec.item_grain)}" for c in m.components]
            lines.append(f"- {key}（{m.label}）：{expr}；过滤条件 {m.filter}"
                         + (f"；组成部分 {'；'.join(comps)}" if comps else ""))
        return "\n".join(lines)

    def write(self, spec: QuerySpec, attempt: int, feedback: list[str], previous_sql: str | None, *,
              fault: str | None = None, allowed_columns: dict[str, set[str]] | None = None) -> WriteResult:
        layer = self.layer
        date_col = layer.calendar.date_column
        time = f"{date_col} BETWEEN '{spec.time.start}' AND '{spec.time.end}'"
        if spec.compare_time is not None:
            time += (f" 或 BETWEEN '{spec.compare_time.start}' AND '{spec.compare_time.end}'；"
                     f"period 列取值 '{spec.time.period_key}' / '{spec.compare_time.period_key}'")
        dims = "、".join(f"{d}（{layer.dimensions[d].expr}）" for d in spec.dimensions if d in layer.dimensions)
        task = SQL_TASK.format(
            columns=", ".join(c["key"] for c in spec.columns),
            dimensions=dims or "无",
            filters="；".join(f"{layer.label(k)} = {'、'.join(v)}（{layer.dimensions[k].expr}）"
                             for k, v in spec.filters.items()) or "无",
            time=time,
            order=f"{spec.order_by} {spec.order.upper()}" if spec.order and spec.order_by else "按维度自然顺序",
            limit=spec.limit or self.fallback.max_rows,
        )
        system = SQL_SYSTEM.format(
            schema=self._schema(allowed_columns or layer.allowed_columns(frozenset())),
            joins="\n".join(f"- {j.from_table} -> {j.to_table}：{j.on}" for j in layer.joins),
            metrics=self._metrics(spec),
        )
        messages = [ChatMessage("system", system), ChatMessage("user", task)]
        if previous_sql and feedback:
            messages += [ChatMessage("assistant", f"```sql\n{previous_sql}\n```"),
                         ChatMessage("user", SQL_RETRY.format(sql=previous_sql, feedback="；".join(feedback)))]
        try:
            result = self.model.chat(messages)
        except LLMError as exc:
            self.usage.fallbacks += 1
            fallback = self.fallback.write(spec, attempt, feedback, previous_sql, fault=fault)
            fallback.note = f"模型调用失败，已回退到模板 SQL：{exc}"
            return fallback
        self.usage.add(result)
        return WriteResult(extract_sql(result.content), prompt_tokens=result.prompt_tokens,
                           completion_tokens=result.completion_tokens)


class LLMNarrator:
    name = "llm"

    def __init__(self, model: ChatModel, layer: SemanticLayer, fallback: TemplateNarrator):
        self.model = model
        self.layer = layer
        self.fallback = fallback
        self.usage = Usage()

    def narrate(self, plan: Plan, outputs: list[QueryOutput], hallucinate: bool = False, question: str = "") -> str:
        tables = []
        for out in outputs:
            header = " | ".join(m["label"] for m in out.meta)
            body = "\n".join(" | ".join(format_value(row[i], m["format"], m.get("unit", "")) if m["role"] != "dimension"
                                        else str(row[i]) for i, m in enumerate(out.meta)) for row in out.rows[:30])
            tables.append(f"结果（{out.spec.title}）：\n| {header} |\n{body}")
        messages = [ChatMessage("system", NARRATOR_SYSTEM),
                    ChatMessage("user", NARRATOR_TASK.format(question=question, period=plan.time.label,
                                                             tables="\n\n".join(tables)))]
        try:
            result = self.model.chat(messages, temperature=0.2)
        except LLMError:
            self.usage.fallbacks += 1
            return self.fallback.narrate(plan, outputs, hallucinate)
        self.usage.add(result)
        return result.content.strip()
