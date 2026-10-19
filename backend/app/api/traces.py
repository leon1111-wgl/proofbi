from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import QueryAttempt, Run, Span
from ..repository import run_summary
from ..security import current_user
from ..semantic.access import User

router = APIRouter(prefix="/api/traces", tags=["traces"])


@router.get("")
def list_traces(source: str | None = None, status_filter: str | None = Query(None, alias="status"),
                limit: int = Query(100, le=500), user: User = Depends(current_user),
                db: Session = Depends(get_db)) -> list[dict]:
    q = select(Run).order_by(Run.created_at.desc()).limit(limit)
    if not user.is_admin:
        q = q.where(Run.username == user.username)
    if source:
        q = q.where(Run.source == source)
    if status_filter:
        q = q.where(Run.status == status_filter)
    return [run_summary(r) for r in db.execute(q).scalars()]


@router.get("/{run_id}")
def get_trace(run_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    run = db.get(Run, run_id)
    if run is None or (run.username != user.username and not user.is_admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    spans = db.execute(select(Span).where(Span.run_id == run_id).order_by(Span.seq)).scalars()
    attempts = db.execute(select(QueryAttempt).where(QueryAttempt.run_id == run_id)
                          .order_by(QueryAttempt.key, QueryAttempt.attempt)).scalars()
    return {
        "summary": run_summary(run),
        "payload": run.payload,
        "spans": [{"seq": s.seq, "kind": s.kind, "name": s.name, "status": s.status, "start_ms": s.start_ms,
                   "duration_ms": s.duration_ms, "input": s.input, "output": s.output} for s in spans],
        "attempts": [{"id": a.id, "key": a.key, "attempt": a.attempt, "status": a.status, "error": a.error,
                      "sql": a.sql_generated, "executed_sql": a.sql_executed, "violations": a.violations,
                      "lint": a.lint, "notes": a.notes, "elapsed_ms": a.elapsed_ms, "row_count": a.row_count}
                     for a in attempts],
    }
