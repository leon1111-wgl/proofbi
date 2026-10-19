"""Application database (conversations, runs, SQL attempts, spans, eval results).

Separate from the warehouse: the warehouse is opened read-only for model SQL, while this
database is ordinary read-write storage owned by the app.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal: sessionmaker | None = None


def init_engine(url: str) -> None:
    global _engine, _SessionLocal
    connect_args = {}
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
        path = url.split("sqlite:///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
    _engine = create_engine(url, connect_args=connect_args)
    _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)


def create_all() -> None:
    from . import models  # noqa: F401  (register tables)

    Base.metadata.create_all(_engine)


def new_session() -> Session:
    assert _SessionLocal is not None, "init_engine() first"
    return _SessionLocal()


def get_db() -> Iterator[Session]:
    db = new_session()
    try:
        yield db
    finally:
        db.close()
