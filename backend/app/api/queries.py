"""Number provenance: the SQL attempt behind a number, and replaying it."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import QueryAttempt, Run
from ..repository import attempt_payload
from ..security import current_user
from ..semantic.access import User
from ..services import get_services
from ..sqlsafe.executor import QueryError, sql_hash
from ..sqlsafe.guard import SqlGuard

router = APIRouter(prefix="/api/queries", tags=["provenance"])


def _load(db: Session, query_id: str, user: User) -> QueryAttempt:
    attempt = db.get(QueryAttempt, query_id)
    if attempt is None or (attempt.username != user.username and not user.is_admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "查询不存在")  # 404, not 403: do not confirm it exists
    return attempt


@router.get("/{query_id}")
def get_query(query_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    attempt = _load(db, query_id, user)
    run = db.get(Run, attempt.run_id)
    siblings = db.execute(select(QueryAttempt).where(QueryAttempt.run_id == attempt.run_id,
                                                     QueryAttempt.key == attempt.key)
                          .order_by(QueryAttempt.attempt)).scalars()
    payload = attempt_payload(attempt, run)
    payload["attempts"] = [{"id": a.id, "attempt": a.attempt, "status": a.status, "error": a.error,
                            "violations": a.violations, "lint": a.lint, "sql": a.sql_generated} for a in siblings]
    return payload


@router.post("/{query_id}/replay")
def replay(query_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Run the stored SQL again and compare the result fingerprint with the original."""
    attempt = _load(db, query_id, user)
    if attempt.status != "ok" or not attempt.sql_executed:
        raise HTTPException(status.HTTP_409_CONFLICT, "这次尝试没有成功执行，无法重放")
    if not hmac.compare_digest(sql_hash(attempt.sql_executed), attempt.sql_hash or ""):
        raise HTTPException(status.HTTP_409_CONFLICT, "SQL 指纹不一致，记录可能被修改，拒绝重放")
    services = get_services()
    owner = services.access.users.get(attempt.username)
    if owner is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "原提问人已不存在")
    allowed = services.layer.allowed_columns(owner.permissions)
    guard = SqlGuard(set(services.layer.tables), services.layer.blocked_columns(owner.permissions),
                     services.settings.max_rows)
    checked = guard.check(attempt.sql_executed)
    if not checked.ok:
        raise HTTPException(status.HTTP_409_CONFLICT, f"重放前的安全校验未通过：{checked.error_text()}")
    try:
        result = services.warehouse.execute(attempt.sql_executed, allowed)
    except QueryError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, f"重放失败：{exc}") from exc
    return {
        "query_id": attempt.id, "match": result.result_hash == attempt.result_hash,
        "original_hash": attempt.result_hash, "replay_hash": result.result_hash,
        "row_count": result.row_count, "elapsed_ms": result.elapsed_ms, "executed_at": result.executed_at,
        "dataset_fingerprint": services.dataset["fingerprint"],
        "dataset_changed": services.dataset["fingerprint"] != attempt.dataset_fingerprint,
    }
