from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..channels.wecom import build_daily_report, send_markdown
from ..config import get_settings
from ..db import get_db
from ..repository import save_run
from ..security import require_admin
from ..semantic.access import User
from ..services import get_services

router = APIRouter(prefix="/api/reports", tags=["reports"])


class DailyIn(BaseModel):
    send: bool = False


@router.post("/daily")
def daily(body: DailyIn, user: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    services = get_services()
    report = build_daily_report(services, user)
    for record in report.records:
        save_run(db, record, source="report", dataset_fingerprint=services.dataset["fingerprint"])
    sent = None
    if body.send:
        key = get_settings().wecom_webhook_key
        if not key:
            raise HTTPException(status.HTTP_409_CONFLICT, "没有配置 PROOFBI_WECOM_WEBHOOK_KEY，只能预览")
        try:
            sent = send_markdown(key, report.markdown)
        except Exception as exc:  # network / API errors are reported, not raised as 500
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"发送失败：{exc}") from exc
    return {"markdown": report.markdown, "runs": [r.id for r in report.records], "sent": sent}
