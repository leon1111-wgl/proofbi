"""The ask pipeline, written as an event generator.

    question
      -> plan (semantic layer; clarify or refuse when needed)
      -> for each query: write SQL -> guard -> 口径 lint -> row-level security -> execute
         (recoverable errors go back to the writer, at most ``max_corrections`` times;
          security violations fail closed immediately)
      -> narrate -> verify every number against the result rows

The API streams the ``step`` events to the console; the final ``result`` event carries a
``RunRecord`` that the repository persists (runs, every SQL attempt, spans).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..semantic.access import User
from ..semantic.compiler import QuerySpec, split_plan
from ..semantic.plan import REFUSAL_TEXT, Plan
from ..sqlsafe.executor import QueryError, sql_hash
from ..sqlsafe.guard import SqlGuard
from ..sqlsafe.lint import lint_sql
from ..sqlsafe.rls import apply_row_policies
from .narrator import QueryOutput, align_columns, chart_for
from .tracing import Tracer
from .verifier import ResultTable, verify_answer

MAX_ROWS_IN_PAYLOAD = 200


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


@dataclass
class AskInput:
    question: str
    user: User
    context: dict | None = None  # previous plan in the conversation
    clarifications: dict[str, str] = field(default_factory=dict)
    fault: str | None = None  # demo / test fault injection (offline writer and narrator)


@dataclass
class Attempt:
    id: str
    key: str
    attempt: int
    status: str  # ok | rejected | lint | error | security
    sql_generated: str
    title: str = ""
    sql_checked: str | None = None
    sql_executed: str | None = None
    error: str | None = None
    violations: list[dict] = field(default_factory=list)
    lint: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    column_meta: list[dict] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    elapsed_ms: float = 0.0
    sql_hash: str | None = None
    result_hash: str | None = None
    executed_at: str | None = None
    policies: dict[str, str | None] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "attempt": self.attempt, "status": self.status, "error": self.error,
                "violations": self.violations, "lint": self.lint, "notes": self.notes, "sql": self.sql_generated}


@dataclass
class RunRecord:
    id: str
    question: str
    username: str
    status: str  # answered | clarify | refused | failed
    created_at: str
    model: str
    latency_ms: float = 0.0
    plan: dict | None = None
    plan_view: dict | None = None
    scope: dict = field(default_factory=dict)
    answer: dict | None = None
    clarification: dict | None = None
    refusal: dict | None = None
    error: str | None = None
    attempts: list[Attempt] = field(default_factory=list)
    final_attempts: list[str] = field(default_factory=list)
    spans: list = field(default_factory=list)
    corrections: int = 0
    usage: dict = field(default_factory=dict)
    clarifications: dict = field(default_factory=dict)
    fault: str | None = None

    def public(self, dataset_fingerprint: str | None = None) -> dict[str, Any]:
        by_id = {a.id: a for a in self.attempts}
        queries = []
        for attempt_id in self.final_attempts:
            a = by_id[attempt_id]
            queries.append({
                "query_id": a.id, "key": a.key, "title": a.title, "status": a.status,
                "sql": a.sql_checked or a.sql_generated, "executed_sql": a.sql_executed,
                "columns": a.columns, "column_meta": a.column_meta, "rows": a.rows[:MAX_ROWS_IN_PAYLOAD],
                "row_count": a.row_count, "truncated": a.truncated, "elapsed_ms": a.elapsed_ms,
                "sql_hash": a.sql_hash, "result_hash": a.result_hash, "executed_at": a.executed_at,
                "policies": a.policies, "dataset_fingerprint": dataset_fingerprint,
                "attempts": [x.summary() for x in self.attempts if x.key == a.key],
            })
        return {
            "run_id": self.id, "question": self.question, "username": self.username, "status": self.status,
            "created_at": self.created_at, "model": self.model, "latency_ms": self.latency_ms,
            "plan": self.plan, "plan_view": self.plan_view, "scope": self.scope, "answer": self.answer,
            "clarification": self.clarification, "refusal": self.refusal, "error": self.error, "queries": queries,
            "corrections": self.corrections, "usage": self.usage, "fault": self.fault,
            "failed_attempts": [a.summary() | {"key": a.key} for a in self.attempts if a.status != "ok"],
        }


class Pipeline:
    def __init__(self, services):
        self.s = services

    # ------------------------------------------------------------------ helpers
    def _plan_view(self, plan: Plan) -> dict[str, Any]:
        layer = self.s.layer
        return {
            "metrics": [{"key": k, "label": layer.metrics[k].label, "description": layer.metrics[k].description,
                         "filter": layer.metrics[k].filter} for k in plan.metrics],
            "dimensions": [{"key": d, "label": layer.label(d)} for d in plan.dimensions],
            "filters": [{"key": k, "label": layer.label(k), "values": v} for k, v in plan.filters.items()],
            "time": plan.time.to_dict(),
            "compare": ({"kind": plan.compare, "label": "同比" if plan.compare == "yoy" else "环比",
                         "time": plan.compare_time.to_dict()} if plan.compare and plan.compare_time else None),
            "order": plan.order, "limit": plan.limit, "notes": plan.notes, "inherited": plan.inherited,
        }

    def _scope(self, user: User) -> dict[str, Any]:
        lk = self.s.lookups
        return {"type": user.scope_type, "label": user.scope_label(lk.region_names, lk.store_names),
                "restricted": user.scope_type != "all"}

    # ------------------------------------------------------------------ run
    def run(self, inp: AskInput) -> Iterator[dict[str, Any]]:
        s = self.s
        tracer = Tracer()
        usage_before = s.usage_totals()
        record = RunRecord(id=new_id("r"), question=inp.question, username=inp.user.username, status="failed",
                           created_at=datetime.now(timezone.utc).isoformat(), model=s.settings.model_label,
                           scope=self._scope(inp.user), clarifications=dict(inp.clarifications), fault=inp.fault)

        def finish() -> dict[str, Any]:
            record.latency_ms = tracer.elapsed_ms
            record.spans = [sp.to_dict() for sp in tracer.spans]
            after = s.usage_totals()
            record.usage = {k: after[k] - usage_before.get(k, 0) for k in after}
            return {"type": "result", "record": record}

        yield {"type": "step", "step": "plan", "status": "running", "title": "理解问题，映射到语义层"}
        with tracer.span("plan", "问题解析（语义层映射）", {"question": inp.question, "planner": s.planner.name,
                                                       "context": inp.context, "clarifications": inp.clarifications}) as sp:
            outcome = s.planner.plan(inp.question, inp.user, inp.context, inp.clarifications)
            sp.output = {"kind": outcome.kind, "trace": outcome.trace,
                         "plan": outcome.plan.to_dict() if outcome.plan else None,
                         "clarification": outcome.clarification.to_dict() if outcome.clarification else None,
                         "refusal": outcome.refusal.to_dict() if outcome.refusal else None}
            if outcome.kind != "plan":
                sp.status = "refused" if outcome.kind == "refuse" else "ok"
        if outcome.kind == "clarify":
            record.status = "clarify"
            record.clarification = outcome.clarification.to_dict()
            yield {"type": "step", "step": "plan", "status": "clarify", "title": "口径有歧义，需要确认"}
            yield finish()
            return
        if outcome.kind == "refuse":
            record.status = "refused"
            record.refusal = outcome.refusal.to_dict() | {"label": REFUSAL_TEXT.get(outcome.refusal.reason, "")}
            yield {"type": "step", "step": "plan", "status": "refused", "title": record.refusal["label"]}
            yield finish()
            return

        plan = outcome.plan
        record.plan = plan.to_dict()
        record.plan_view = self._plan_view(plan)
        if record.scope["restricted"]:
            record.plan_view["notes"] = record.plan_view["notes"] + [
                f"数据范围：{record.scope['label']}（行级权限由系统强制执行，结果只包含你有权限的数据）。"]
        yield {"type": "step", "step": "plan", "status": "ok", "title": "已映射到语义层", "detail": record.plan_view}

        user = inp.user
        allowed = s.layer.allowed_columns(user.permissions)
        guard = SqlGuard(set(s.layer.tables), s.layer.blocked_columns(user.permissions), s.settings.max_rows,
                         s.settings.max_joins, s.settings.max_sql_chars)
        outputs: list[QueryOutput] = []
        for spec in split_plan(plan, s.layer):
            result = yield from self._run_query(spec, inp, guard, allowed, tracer, record)
            if result is None:
                yield finish()
                return
            outputs.append(result)

        yield {"type": "step", "step": "answer", "status": "running", "title": "生成结论"}
        with tracer.span("narrate", f"生成结论（{s.narrator.name}）", {"queries": [o.query_id for o in outputs]}) as sp:
            text = s.narrator.narrate(plan, outputs, hallucinate=inp.fault == "number_hallucination",
                                      question=inp.question)
            sp.output = {"text": text}
        with tracer.span("verify", "数字核对", {"text": text}) as sp:
            tables = [ResultTable(o.query_id, o.columns, o.rows, {m["key"]: m["label"] for m in o.meta}) for o in outputs]
            report = verify_answer(text, tables)
            sp.output = report.to_dict()
            sp.status = "ok" if report.verdict != "fail" else "error"
        record.answer = {"text": text, "verification": report.to_dict(), "charts": [chart_for(o) for o in outputs]}
        record.status = "answered"
        yield {"type": "step", "step": "verify", "status": "ok" if report.verdict != "fail" else "error",
               "title": "数字全部可核对" if report.verdict != "fail" else "有数字在结果中找不到",
               "detail": report.counts}
        yield finish()

    def _run_query(self, spec: QuerySpec, inp: AskInput, guard: SqlGuard, allowed: dict[str, set[str]],
                   tracer: Tracer, record: RunRecord):
        s = self.s
        feedback: list[str] = []
        previous: str | None = None
        for attempt in range(s.settings.max_corrections + 1):
            label = f"{spec.key} · {spec.title}" + (f"（第 {attempt + 1} 次）" if attempt else "")
            yield {"type": "step", "step": "sql", "status": "running", "title": f"生成 SQL：{label}"}
            with tracer.span("sql", f"生成 SQL：{label}", {"spec": spec.to_dict(), "feedback": feedback,
                                                          "writer": s.sql_writer.name}) as sp:
                written = s.sql_writer.write(spec, attempt, feedback, previous, fault=inp.fault, allowed_columns=allowed)
                sp.output = {"sql": written.sql, "note": written.note}
                sp.status = "ok" if attempt == 0 else "retry"
            att = Attempt(id=new_id("q"), key=spec.key, attempt=attempt + 1, status="rejected",
                          sql_generated=written.sql, title=spec.title, notes=[written.note] if written.note else [])
            record.attempts.append(att)
            previous = written.sql

            with tracer.span("guard", f"SQL 安全校验：{spec.key}", {"sql": written.sql}) as sp:
                checked = guard.check(written.sql)
                sp.output = checked.to_dict()
                sp.status = "ok" if checked.ok else ("refused" if checked.security_violation else "error")
            att.violations = [v.to_dict() for v in checked.violations]
            att.notes += checked.notes
            if not checked.ok:
                if checked.security_violation:
                    att.status = "security"
                    record.status = "refused"
                    record.refusal = {"reason": "security", "label": REFUSAL_TEXT["security"],
                                      "message": f"生成的 SQL 未通过安全校验，已拒绝执行：{checked.error_text()}",
                                      "suggestions": []}
                    yield {"type": "step", "step": "guard", "status": "refused", "title": "安全校验未通过，已拒绝执行",
                           "detail": att.violations}
                    return None
                feedback = [checked.error_text()]
                yield {"type": "step", "step": "guard", "status": "retry", "title": f"SQL 有问题，交回模型修正：{feedback[0]}"}
                continue
            att.sql_checked = checked.sql

            with tracer.span("lint", f"口径校验：{spec.key}", {"metrics": spec.metrics}) as sp:
                issues = lint_sql(checked.tree, spec, s.layer, s.lookups.value_codes())
                sp.output = {"issues": [i.to_dict() for i in issues]}
                sp.status = "ok" if not issues else "error"
            att.lint = [i.to_dict() for i in issues]
            if issues:
                att.status = "lint"
                feedback = [i.message for i in issues]
                yield {"type": "step", "step": "lint", "status": "retry", "title": f"口径不一致，交回模型修正：{feedback[0]}"}
                continue

            with tracer.span("rls", f"行级权限改写：{spec.key}", {"user": inp.user.username,
                                                               "scope": record.scope}) as sp:
                rewritten = apply_row_policies(checked.tree, inp.user, s.access, allowed)
                sp.output = {"policies": rewritten.policies, "sql": rewritten.sql}
            att.sql_executed = rewritten.sql
            att.policies = rewritten.policies
            att.sql_hash = sql_hash(rewritten.sql)

            yield {"type": "step", "step": "execute", "status": "running", "title": f"执行查询：{spec.key}"}
            with tracer.span("execute", f"执行查询：{spec.key}", {"sql_hash": att.sql_hash}) as sp:
                try:
                    result = s.warehouse.execute(rewritten.sql, allowed)
                except QueryError as exc:
                    sp.status = "error"
                    sp.output = {"error": str(exc), "kind": exc.kind}
                    result = None
                    error = exc
                else:
                    sp.output = {"rows": result.row_count, "elapsed_ms": result.elapsed_ms,
                                 "truncated": result.truncated, "result_hash": result.result_hash}
            if result is None:
                att.error = str(error)
                if error.kind == "denied":
                    att.status = "security"
                    record.status = "refused"
                    record.refusal = {"reason": "security", "label": REFUSAL_TEXT["security"],
                                      "message": f"执行层拒绝了这条查询：{error}", "suggestions": []}
                    yield {"type": "step", "step": "execute", "status": "refused", "title": "执行层拒绝"}
                    return None
                att.status = "error"
                feedback = [f"执行报错：{error}"]
                yield {"type": "step", "step": "execute", "status": "retry", "title": f"执行报错，交回模型修正：{error}"}
                continue

            att.status = "ok"
            att.columns, att.rows = result.columns, result.rows
            att.row_count, att.truncated = result.row_count, result.truncated
            att.elapsed_ms, att.result_hash, att.executed_at = result.elapsed_ms, result.result_hash, result.executed_at
            att.column_meta = align_columns(spec, result.columns, result.rows, s.layer)
            record.final_attempts.append(att.id)
            record.corrections += attempt
            yield {"type": "step", "step": "execute", "status": "ok",
                   "title": f"{spec.key} 返回 {result.row_count} 行，用时 {result.elapsed_ms} ms"}
            return QueryOutput(spec, att.id, result.columns, result.rows, att.column_meta)

        record.status = "failed"
        record.corrections += s.settings.max_corrections
        record.error = (f"{spec.title} 的 SQL 自我纠错 {s.settings.max_corrections} 次后仍未通过："
                        f"{'；'.join(feedback)}")
        yield {"type": "step", "step": "sql", "status": "error", "title": "自我纠错次数用完"}
        return None


def collect(events: Iterator[dict[str, Any]]) -> tuple[RunRecord, list[dict[str, Any]]]:
    """Drain the generator; returns the record and the step events."""
    steps, record = [], None
    for event in events:
        if event["type"] == "result":
            record = event["record"]
        else:
            steps.append(event)
    assert record is not None
    return record, steps


def record_to_dict(record: RunRecord) -> dict[str, Any]:
    return asdict(record)
