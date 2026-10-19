from __future__ import annotations

from fastapi import APIRouter, Depends

from ..agent.sql_writer import FAULTS
from ..config import get_settings
from ..security import current_user
from ..semantic.access import User
from ..services import get_services
from .auth import public_user

router = APIRouter(prefix="/api", tags=["semantic"])


@router.get("/semantic")
def semantic(user: User = Depends(current_user)) -> dict:
    s = get_services()
    catalog = s.layer.to_public(user.permissions)
    users = s.access.users.values() if user.is_admin else [user]
    catalog["policies"] = [public_user(u) | {"tables": s.access.describe(u)} for u in users]
    return catalog


@router.get("/meta")
def meta(user: User = Depends(current_user)) -> dict:
    s = get_services()
    settings = get_settings()
    cal = s.layer.calendar
    return {
        "dataset": s.dataset,
        "calendar": {"today": cal.today.isoformat(), "data_start": cal.data_start.isoformat(),
                     "data_end": cal.data_end.isoformat()},
        "model": settings.model_label,
        "planner": s.planner.name,
        "sql_writer": s.sql_writer.name,
        "narrator": s.narrator.name,
        "faults": FAULTS if user.is_admin else {},
        "limits": {"max_rows": settings.max_rows, "timeout_ms": settings.query_timeout_ms,
                   "max_corrections": settings.max_corrections},
        "wecom_configured": bool(settings.wecom_webhook_key),
    }
