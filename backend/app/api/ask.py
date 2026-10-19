"""Ask questions, stream pipeline progress, browse conversations."""

from __future__ import annotations

import json
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..agent.pipeline import AskInput, collect
from ..agent.sql_writer import FAULTS
from ..db import get_db, new_session
from ..models import Conversation, Run
from ..repository import last_plan, run_summary, save_run
from ..security import current_user
from ..semantic.access import User
from ..services import get_services

router = APIRouter(prefix="/api", tags=["ask"])


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    conversation_id: int | None = None
    clarifications: dict[str, str] = Field(default_factory=dict)
    fault: str | None = None  # demo mode, admins only


def _conversation(db: Session, user: User, conversation_id: int | None, title: str) -> Conversation:
    if conversation_id is not None:
        convo = db.get(Conversation, conversation_id)
        if convo is None or convo.username != user.username:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "对话不存在")
        return convo
    convo = Conversation(username=user.username, title=title[:60])
    db.add(convo)
    db.commit()
    return convo


def _prepare(body: AskIn, user: User, db: Session) -> tuple[AskInput, int]:
    if body.fault is not None:
        if not user.is_admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "演示模式只对管理员开放")
        if body.fault not in FAULTS:
            raise HTTPException(422, f"未知的演示故障：{body.fault}")
    convo = _conversation(db, user, body.conversation_id, body.question)
    context = last_plan(db, convo.id)
    return AskInput(body.question, user, context, dict(body.clarifications), body.fault), convo.id


@router.post("/ask")
def ask(body: AskIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    services = get_services()
    inp, conversation_id = _prepare(body, user, db)
    record, _ = collect(services.pipeline.run(inp))
    run = save_run(db, record, source="chat", dataset_fingerprint=services.dataset["fingerprint"],
                   conversation_id=conversation_id)
    return run.payload


@router.post("/ask/stream")
def ask_stream(body: AskIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> StreamingResponse:
    services = get_services()
    inp, conversation_id = _prepare(body, user, db)

    def events() -> Iterator[str]:
        yield f"data: {json.dumps({'type': 'started', 'conversation_id': conversation_id}, ensure_ascii=False)}\n\n"
        for event in services.pipeline.run(inp):
            if event["type"] == "result":
                with new_session() as session:  # the request session may already be closed
                    run = save_run(session, event["record"], source="chat",
                                   dataset_fingerprint=services.dataset["fingerprint"],
                                   conversation_id=conversation_id)
                    payload = run.payload
                yield f"data: {json.dumps({'type': 'result', 'result': payload}, ensure_ascii=False)}\n\n"
            else:
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/conversations")
def conversations(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(select(Conversation).where(Conversation.username == user.username)
                      .order_by(Conversation.updated_at.desc()).limit(50)).scalars()
    return [{"id": c.id, "title": c.title, "updated_at": c.updated_at.isoformat()} for c in rows]


@router.post("/conversations")
def create_conversation(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    convo = _conversation(db, user, None, "新的对话")
    return {"id": convo.id, "title": convo.title, "updated_at": convo.updated_at.isoformat()}


@router.get("/conversations/{conversation_id}")
def conversation(conversation_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    convo = db.get(Conversation, conversation_id)
    if convo is None or convo.username != user.username:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "对话不存在")
    runs = db.execute(select(Run).where(Run.conversation_id == convo.id).order_by(Run.created_at)).scalars()
    return {"id": convo.id, "title": convo.title, "runs": [r.payload for r in runs]}


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    run = db.get(Run, run_id)
    if run is None or (run.username != user.username and not user.is_admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    return run.payload | {"summary": run_summary(run)}
