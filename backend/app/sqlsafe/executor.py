"""Read-only execution against the warehouse (third line of defence).

Even if a crafted query slipped past the AST guard and the rewrite, the engine itself
refuses: the file is opened read-only (``mode=ro``) with ``PRAGMA query_only``, and a
SQLite authorizer allows only SELECT, reads of whitelisted columns and whitelisted
functions. A progress handler aborts long queries, and at most ``max_rows`` rows are
fetched. Each result carries a sha256 of its rows so a number can be re-checked later.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AUTH_ALLOWED_FUNCTIONS = {
    "sum", "count", "avg", "min", "max", "round", "coalesce", "ifnull", "nullif", "substr", "substring", "abs",
    "lower", "upper", "length", "iif", "date", "strftime", "julianday", "row_number", "rank", "dense_rank", "lag",
    "lead", "trim", "replace", "instr", "total", "group_concat", "like",
}


class QueryError(Exception):
    def __init__(self, message: str, kind: str = "execution"):
        super().__init__(message)
        self.kind = kind  # execution | timeout | denied


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    elapsed_ms: float
    result_hash: str
    executed_at: str
    denied: list[str] = field(default_factory=list)


def result_hash(columns: list[str], rows: list[list[Any]]) -> str:
    payload = json.dumps({"columns": columns, "rows": rows}, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def sql_hash(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


class Warehouse:
    def __init__(self, path: str | Path, timeout_ms: int = 3000, max_rows: int = 1000):
        self.path = Path(path).resolve()
        self.timeout_ms = timeout_ms
        self.max_rows = max_rows

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
        conn.execute("PRAGMA query_only = 1")
        return conn

    def trusted_rows(self, sql: str, params: tuple = ()) -> list[tuple]:
        """Fixed internal lookups (dimension values, region names). Never model SQL."""
        conn = self._connect()
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def execute(self, sql: str, allowed_columns: dict[str, set[str]]) -> QueryResult:
        allowed = {t.lower(): {c.lower() for c in cols} for t, cols in allowed_columns.items()}
        denied: list[str] = []

        def authorizer(action, arg1, arg2, _db, _source):
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ:
                table, column = (arg1 or "").lower(), (arg2 or "").lower()
                if table in allowed and (column == "" or column in allowed[table]):
                    return sqlite3.SQLITE_OK
                denied.append(f"读取 {table}.{column}")
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION:
                if (arg2 or "").lower() in AUTH_ALLOWED_FUNCTIONS:
                    return sqlite3.SQLITE_OK
                denied.append(f"函数 {arg2}")
                return sqlite3.SQLITE_DENY
            denied.append(f"操作码 {action}")
            return sqlite3.SQLITE_DENY

        conn = self._connect()
        started = time.perf_counter()
        deadline = started + self.timeout_ms / 1000

        def progress() -> int:
            return 1 if time.perf_counter() > deadline else 0

        conn.set_authorizer(authorizer)
        conn.set_progress_handler(progress, 2000)
        try:
            cursor = conn.execute(sql)
            columns = [d[0] for d in cursor.description or []]
            fetched = cursor.fetchmany(self.max_rows + 1)
        except sqlite3.DatabaseError as exc:
            message = str(exc)
            if "interrupted" in message:
                raise QueryError(f"查询超过 {self.timeout_ms} ms 被中止", "timeout") from exc
            if denied or "not authorized" in message or "prohibited" in message:
                raise QueryError(f"执行层拒绝：{'；'.join(denied) or message}", "denied") from exc
            raise QueryError(message, "execution") from exc
        finally:
            conn.close()
        elapsed = (time.perf_counter() - started) * 1000
        truncated = len(fetched) > self.max_rows
        rows = [list(r) for r in fetched[: self.max_rows]]
        return QueryResult(
            columns=columns, rows=rows, row_count=len(rows), truncated=truncated, elapsed_ms=round(elapsed, 2),
            result_hash=result_hash(columns, rows), executed_at=datetime.now(timezone.utc).isoformat(),
        )
