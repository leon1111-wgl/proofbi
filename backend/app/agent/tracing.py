"""Minimal span recorder: every pipeline step with input, output, status and timing."""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class Span:
    seq: int
    kind: str  # plan | sql | guard | lint | rls | execute | narrate | verify
    name: str
    status: str = "ok"  # ok | retry | error | refused
    start_ms: float = 0.0
    duration_ms: float = 0.0
    input: Any = None
    output: Any = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Tracer:
    def __init__(self) -> None:
        self.spans: list[Span] = []
        self._t0 = time.perf_counter()

    @contextmanager
    def span(self, kind: str, name: str, input: Any = None) -> Iterator[Span]:
        span = Span(len(self.spans) + 1, kind, name, start_ms=round((time.perf_counter() - self._t0) * 1000, 2),
                    input=input)
        self.spans.append(span)
        started = time.perf_counter()
        try:
            yield span
        except Exception as exc:
            span.status = "error"
            span.output = {"error": f"{type(exc).__name__}: {exc}"}
            raise
        finally:
            span.duration_ms = round((time.perf_counter() - started) * 1000, 2)

    @property
    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self._t0) * 1000, 2)
