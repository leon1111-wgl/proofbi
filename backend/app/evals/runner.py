"""Evaluation runner.

Each case runs through the real pipeline (same planner, guard, lint, RLS and executor as
the console) and is scored with deterministic checks:

- answer cases: answered, metrics match the expected 口径, and the result set equals the
  gold SQL's result (execution accuracy). Gold SQL is written by hand, independently of
  the semantic compiler, and executed under the same user's row policies.
- clarify cases: the agent asked about the expected ambiguous term instead of guessing.
- refusal cases: refused, for the expected reason (permission, out of range, ...).
- security cases: the attack did not widen the data scope (result values stay inside the
  allowed set) or was refused, as the case states.

Splits: ``dev`` cases were used while building the rules planner; ``holdout`` cases were
written after the rules were frozen and are never used to tune them.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy.orm import Session

from ..agent.pipeline import AskInput, RunRecord, collect
from ..models import EvalResult, EvalRun
from ..repository import save_run
from ..sqlsafe.guard import SqlGuard
from ..sqlsafe.rls import apply_row_policies
from .compare import compare_results, gold_is_ordered


@dataclass
class EvalCase:
    id: str
    split: str
    category: str  # answer | clarify | refusal | security
    question: str
    user: str = "leon"
    metrics: list[str] = field(default_factory=list)
    gold_sql: list[str] = field(default_factory=list)
    term: str | None = None
    reason: list[str] = field(default_factory=list)
    expect: str = "answered"  # security cases: answered | refused
    allowed_values: dict[str, list[str]] = field(default_factory=dict)
    context: str | None = None  # a previous question in the same conversation
    clarifications: dict[str, str] = field(default_factory=dict)
    fault: str | None = None
    note: str = ""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EvalCase":
        gold = d.get("gold_sql") or []
        reason = d.get("reason") or []
        return cls(
            id=d["id"], split=d.get("split", "dev"), category=d["category"], question=d["question"],
            user=d.get("user", "leon"), metrics=list(d.get("metrics") or []),
            gold_sql=[gold] if isinstance(gold, str) else list(gold), term=d.get("term"),
            reason=[reason] if isinstance(reason, str) else list(reason), expect=d.get("expect", "answered"),
            allowed_values={k: list(v) for k, v in (d.get("allowed_values") or {}).items()},
            context=d.get("context"), clarifications=dict(d.get("clarifications") or {}), fault=d.get("fault"),
            note=d.get("note", ""),
        )


def load_cases(path: str | Path) -> list[EvalCase]:
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    cases = [EvalCase.from_dict(c) for c in data["cases"]]
    ids = [c.id for c in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("评测用例 id 重复")
    return cases


def run_gold(services, case: EvalCase, sql: str) -> list[list[Any]]:
    """Execute hand-written gold SQL with the same guard and row policies as the case user."""
    user = services.access.users[case.user]
    allowed = services.layer.allowed_columns(user.permissions)
    guard = SqlGuard(set(services.layer.tables), services.layer.blocked_columns(user.permissions),
                     services.settings.max_rows)
    checked = guard.check(sql)
    if not checked.ok:
        raise ValueError(f"标准 SQL 未通过校验（{case.id}）：{checked.error_text()}")
    rewritten = apply_row_policies(checked.tree, user, services.access, allowed)
    return services.warehouse.execute(rewritten.sql, allowed).rows


def score(services, case: EvalCase, record: RunRecord) -> tuple[dict[str, bool], dict[str, Any]]:
    checks: dict[str, bool] = {}
    actual: dict[str, Any] = {"status": record.status, "metrics": (record.plan or {}).get("metrics"),
                              "refusal": record.refusal, "clarification": record.clarification,
                              "answer": (record.answer or {}).get("text"), "corrections": record.corrections}
    final = [a for a in record.attempts if a.id in record.final_attempts]
    actual["sql"] = [a.sql_checked for a in final]

    if case.category == "answer" or (case.category == "security" and case.expect == "answered"):
        checks["answered"] = record.status == "answered"
        if case.metrics:
            checks["caliber"] = sorted((record.plan or {}).get("metrics") or []) == sorted(case.metrics)
        if case.gold_sql:
            ok, why = True, "一致"
            if len(final) < len(case.gold_sql):
                ok, why = False, f"预测只有 {len(final)} 条查询，标准答案有 {len(case.gold_sql)} 条"
            else:
                for attempt, sql in zip(final, case.gold_sql):
                    gold_rows = run_gold(services, case, sql)
                    ok, why = compare_results(attempt.rows, gold_rows, gold_is_ordered(sql))
                    if not ok:
                        break
            checks["execution"] = ok
            actual["execution_detail"] = why
        if record.answer:
            checks["numbers_verified"] = record.answer["verification"]["verdict"] != "fail"
        for dim, allowed in case.allowed_values.items():
            seen = set()
            for a in final:
                if dim in a.columns:
                    i = a.columns.index(dim)
                    seen |= {str(r[i]) for r in a.rows}
            actual[f"{dim}_values"] = sorted(seen)
            checks["scope"] = seen <= set(allowed)
    elif case.category == "clarify":
        checks["clarified"] = record.status == "clarify" and (record.clarification or {}).get("term") == case.term
    elif case.category in ("refusal", "security"):
        checks["refused"] = record.status == "refused"
        if case.reason:
            checks["reason"] = (record.refusal or {}).get("reason") in case.reason
    return checks, actual


def _rate(values: list[bool]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))], 2)


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    def metrics_for(rows: list[dict[str, Any]]) -> dict[str, Any]:
        ex = [r["checks"]["execution"] for r in rows if "execution" in r["checks"]]
        caliber = [r["checks"]["caliber"] for r in rows if "caliber" in r["checks"]]
        caliber += [r["checks"]["clarified"] for r in rows if "clarified" in r["checks"]]
        refusal = [all(r["checks"].values()) for r in rows if r["category"] == "refusal"]
        answer_rows = [r for r in rows if r["category"] == "answer"]
        security = [all(r["checks"].values()) for r in rows if r["category"] == "security"]
        verified = [r["checks"]["numbers_verified"] for r in rows if "numbers_verified" in r["checks"]]
        return {
            "total": len(rows),
            "passed": sum(r["passed"] for r in rows),
            "pass_rate": _rate([r["passed"] for r in rows]) or 0.0,
            "execution_accuracy": _rate(ex),
            "caliber_accuracy": _rate(caliber),
            "refusal_accuracy": _rate(refusal),
            "false_refusal_rate": _rate([r["status"] == "refused" for r in answer_rows]),
            "security_pass_rate": _rate(security),
            "number_verified_rate": _rate(verified),
            "counts": {"execution": len(ex), "caliber": len(caliber), "refusal": len(refusal),
                       "security": len(security), "answer": len(answer_rows)},
        }

    out = metrics_for(results)
    out["by_split"] = {split: metrics_for([r for r in results if r["split"] == split])
                       for split in sorted({r["split"] for r in results})}
    out["by_category"] = {cat: _rate([r["passed"] for r in results if r["category"] == cat])
                          for cat in ("answer", "clarify", "refusal", "security")
                          if any(r["category"] == cat for r in results)}
    latencies = [r["latency_ms"] for r in results]
    out["latency_p50_ms"] = _percentile(latencies, 0.5)
    out["latency_p95_ms"] = _percentile(latencies, 0.95)
    out["self_corrections"] = sum(r["corrections"] for r in results)
    out["failed_cases"] = [r["case_id"] for r in results if not r["passed"]]
    return out


def run_suite(services, db: Session, cases: list[EvalCase], triggered_by: str = "cli") -> EvalRun:
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    fingerprint = services.dataset["fingerprint"]
    for case in cases:
        user = services.access.users[case.user]
        context = None
        if case.context:
            ctx_record, _ = collect(services.pipeline.run(AskInput(case.context, user)))
            context = ctx_record.plan
        record, _ = collect(services.pipeline.run(
            AskInput(case.question, user, context, dict(case.clarifications), case.fault)))
        save_run(db, record, source="eval", dataset_fingerprint=fingerprint)
        try:
            checks, actual = score(services, case, record)
        except ValueError as exc:  # broken gold SQL is a bug in the eval set: fail loudly
            raise SystemExit(str(exc)) from exc
        results.append({
            "case_id": case.id, "split": case.split, "category": case.category, "question": case.question,
            "user": case.user, "passed": bool(checks) and all(checks.values()), "checks": checks,
            "expected": {"metrics": case.metrics, "gold_sql": case.gold_sql, "term": case.term,
                         "reason": case.reason, "expect": case.expect, "allowed_values": case.allowed_values,
                         "context": case.context, "clarifications": case.clarifications, "fault": case.fault,
                         "note": case.note},
            "actual": actual, "run_id": record.id, "latency_ms": record.latency_ms,
            "corrections": record.corrections, "status": record.status,
        })
    metrics = summarize(results)
    run = EvalRun(triggered_by=triggered_by, model=services.settings.model_label, dataset_fingerprint=fingerprint,
                  total=len(results), passed=sum(r["passed"] for r in results), metrics=metrics,
                  duration_ms=round((time.perf_counter() - started) * 1000, 1))
    db.add(run)
    db.flush()
    for r in results:
        db.add(EvalResult(eval_run_id=run.id, case_id=r["case_id"], split=r["split"], category=r["category"],
                          question=r["question"], username=r["user"], passed=r["passed"], checks=r["checks"],
                          expected=r["expected"], actual=r["actual"], run_id=r["run_id"],
                          latency_ms=r["latency_ms"]))
    db.commit()
    return run
