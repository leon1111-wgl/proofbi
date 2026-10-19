from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(200), default="新的对话")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Run(Base):
    """One question and everything that happened while answering it."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    conversation_id: Mapped[int | None] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(String(16), default="chat")  # chat | eval | report
    question: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    verdict: Mapped[str | None] = mapped_column(String(16), nullable=True)
    corrections: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    model: Mapped[str] = mapped_column(String(200), default="")
    plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class QueryAttempt(Base):
    """Every SQL the writer produced, including the rejected ones (they are evidence too)."""

    __tablename__ = "query_attempts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    key: Mapped[str] = mapped_column(String(8))
    attempt: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(200), default="")
    sql_generated: Mapped[str] = mapped_column(Text)
    sql_checked: Mapped[str | None] = mapped_column(Text, nullable=True)
    sql_executed: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    violations: Mapped[list] = mapped_column(JSON, default=list)
    lint: Mapped[list] = mapped_column(JSON, default=list)
    notes: Mapped[list] = mapped_column(JSON, default=list)
    columns: Mapped[list] = mapped_column(JSON, default=list)
    column_meta: Mapped[list] = mapped_column(JSON, default=list)
    rows: Mapped[list] = mapped_column(JSON, default=list)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    elapsed_ms: Mapped[float] = mapped_column(Float, default=0.0)
    sql_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    executed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    policies: Mapped[dict] = mapped_column(JSON, default=dict)
    dataset_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Span(Base):
    __tablename__ = "spans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16))
    start_ms: Mapped[float] = mapped_column(Float)
    duration_ms: Mapped[float] = mapped_column(Float)
    input: Mapped[Any] = mapped_column(JSON, nullable=True)
    output: Mapped[Any] = mapped_column(JSON, nullable=True)


class EvalRun(Base):
    __tablename__ = "eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    triggered_by: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(200))
    dataset_fingerprint: Mapped[str] = mapped_column(String(64))
    total: Mapped[int] = mapped_column(Integer, default=0)
    passed: Mapped[int] = mapped_column(Integer, default=0)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    duration_ms: Mapped[float] = mapped_column(Float, default=0.0)


class EvalResult(Base):
    __tablename__ = "eval_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    eval_run_id: Mapped[int] = mapped_column(ForeignKey("eval_runs.id"), index=True)
    case_id: Mapped[str] = mapped_column(String(64))
    split: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(32))
    question: Mapped[str] = mapped_column(Text)
    username: Mapped[str] = mapped_column(String(64))
    passed: Mapped[bool] = mapped_column(Boolean)
    checks: Mapped[dict] = mapped_column(JSON, default=dict)
    expected: Mapped[dict] = mapped_column(JSON, default=dict)
    actual: Mapped[dict] = mapped_column(JSON, default=dict)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
