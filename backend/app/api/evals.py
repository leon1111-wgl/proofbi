from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..evals.runner import load_cases, run_suite
from ..models import EvalResult, EvalRun
from ..security import current_user, require_admin
from ..semantic.access import User
from ..services import get_services

router = APIRouter(prefix="/api/evals", tags=["evals"])


def _run_dict(run: EvalRun) -> dict:
    return {"id": run.id, "created_at": run.created_at.isoformat(), "triggered_by": run.triggered_by,
            "model": run.model, "dataset_fingerprint": run.dataset_fingerprint, "total": run.total,
            "passed": run.passed, "metrics": run.metrics, "duration_ms": run.duration_ms}


@router.get("/runs")
def list_runs(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    runs = db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(20)).scalars()
    return [_run_dict(r) for r in runs]


@router.get("/runs/{run_id}")
def get_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    run = db.get(EvalRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "评测记录不存在")
    results = db.execute(select(EvalResult).where(EvalResult.eval_run_id == run_id).order_by(EvalResult.id)).scalars()
    return _run_dict(run) | {"results": [
        {"case_id": r.case_id, "split": r.split, "category": r.category, "question": r.question,
         "user": r.username, "passed": r.passed, "checks": r.checks, "expected": r.expected, "actual": r.actual,
         "run_id": r.run_id, "latency_ms": r.latency_ms} for r in results]}


@router.post("/run")
def run_now(user: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    cases = load_cases(get_settings().eval_cases_path)
    run = run_suite(get_services(), db, cases, triggered_by=user.username)
    return _run_dict(run)
