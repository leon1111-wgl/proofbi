"""Persist pipeline runs and read them back for the console."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .agent.pipeline import RunRecord
from .models import Conversation, QueryAttempt, Run, Span, utcnow


def save_run(db: Session, record: RunRecord, *, source: str, dataset_fingerprint: str,
             conversation_id: int | None = None) -> Run:
    payload = record.public(dataset_fingerprint)
    payload["conversation_id"] = conversation_id
    payload["source"] = source
    verdict = ((record.answer or {}).get("verification") or {}).get("verdict")
    run = Run(id=record.id, conversation_id=conversation_id, username=record.username, source=source,
              question=record.question, status=record.status, verdict=verdict, corrections=record.corrections,
              latency_ms=record.latency_ms, model=record.model, plan=record.plan, payload=payload)
    db.add(run)
    db.flush()
    for a in record.attempts:
        db.add(QueryAttempt(
            id=a.id, run_id=record.id, username=record.username, key=a.key, attempt=a.attempt, status=a.status,
            title=a.title, sql_generated=a.sql_generated, sql_checked=a.sql_checked, sql_executed=a.sql_executed,
            error=a.error, violations=a.violations, lint=a.lint, notes=a.notes, columns=a.columns,
            column_meta=a.column_meta, rows=a.rows, row_count=a.row_count, truncated=a.truncated,
            elapsed_ms=a.elapsed_ms, sql_hash=a.sql_hash, result_hash=a.result_hash, executed_at=a.executed_at,
            policies=a.policies, dataset_fingerprint=dataset_fingerprint,
        ))
    for sp in record.spans:
        db.add(Span(run_id=record.id, **sp))
    if conversation_id is not None:
        convo = db.get(Conversation, conversation_id)
        if convo is not None:
            convo.updated_at = utcnow()
    db.commit()
    return run


def run_summary(run: Run) -> dict[str, Any]:
    payload = run.payload or {}
    return {
        "run_id": run.id, "question": run.question, "username": run.username, "source": run.source,
        "status": run.status, "verdict": run.verdict, "corrections": run.corrections,
        "latency_ms": run.latency_ms, "model": run.model, "created_at": run.created_at.isoformat(),
        "conversation_id": run.conversation_id,
        "metrics": [m["label"] for m in ((payload.get("plan_view") or {}).get("metrics") or [])],
        "refusal": (payload.get("refusal") or {}).get("label"),
    }


def last_plan(db: Session, conversation_id: int) -> dict | None:
    """Plan of the latest answered question in the conversation (context for follow-ups)."""
    return db.execute(
        select(Run.plan).where(Run.conversation_id == conversation_id, Run.status == "answered")
        .order_by(Run.created_at.desc()).limit(1)
    ).scalar_one_or_none()


def attempt_payload(a: QueryAttempt, run: Run | None) -> dict[str, Any]:
    return {
        "query_id": a.id, "run_id": a.run_id, "key": a.key, "attempt": a.attempt, "status": a.status,
        "title": a.title, "username": a.username, "question": run.question if run else None,
        "sql": a.sql_checked or a.sql_generated, "sql_generated": a.sql_generated, "executed_sql": a.sql_executed,
        "error": a.error, "violations": a.violations, "lint": a.lint, "notes": a.notes,
        "columns": a.columns, "column_meta": a.column_meta, "rows": a.rows, "row_count": a.row_count,
        "truncated": a.truncated, "elapsed_ms": a.elapsed_ms, "sql_hash": a.sql_hash, "result_hash": a.result_hash,
        "executed_at": a.executed_at, "policies": a.policies, "dataset_fingerprint": a.dataset_fingerprint,
        "run_created_at": run.created_at.isoformat() if run else None,
    }
