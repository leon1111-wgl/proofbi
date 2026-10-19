"""The structured form of a question: which metrics, split by what, filtered how, when.

Both planners (rules and LLM) produce a ``Plan``; everything downstream (permission
checks, SQL, lints, answers) works on this object rather than on free text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .timeparse import TimeRange


@dataclass
class Plan:
    metrics: list[str]
    time: TimeRange
    dimensions: list[str] = field(default_factory=list)
    filters: dict[str, list[str]] = field(default_factory=dict)
    compare: str | None = None  # mom (环比) | yoy (同比)
    compare_time: TimeRange | None = None
    order: str | None = None  # desc | asc
    order_by: str | None = None
    limit: int | None = None
    notes: list[str] = field(default_factory=list)
    inherited: list[str] = field(default_factory=list)  # parts carried over from the previous question

    def to_dict(self) -> dict[str, Any]:
        return {
            "metrics": list(self.metrics), "dimensions": list(self.dimensions),
            "filters": {k: list(v) for k, v in self.filters.items()}, "time": self.time.to_dict(),
            "compare": self.compare, "compare_time": self.compare_time.to_dict() if self.compare_time else None,
            "order": self.order, "order_by": self.order_by, "limit": self.limit,
            "notes": list(self.notes), "inherited": list(self.inherited),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Plan":
        return cls(
            metrics=list(data["metrics"]), time=TimeRange.from_dict(data["time"]),
            dimensions=list(data.get("dimensions") or []),
            filters={k: list(v) for k, v in (data.get("filters") or {}).items()},
            compare=data.get("compare"),
            compare_time=TimeRange.from_dict(data["compare_time"]) if data.get("compare_time") else None,
            order=data.get("order"), order_by=data.get("order_by"), limit=data.get("limit"),
            notes=list(data.get("notes") or []), inherited=list(data.get("inherited") or []),
        )


@dataclass
class Clarification:
    term: str
    question: str
    options: list[dict[str, str]]  # [{value, label, description}]

    def to_dict(self) -> dict[str, Any]:
        return {"term": self.term, "question": self.question, "options": self.options}


@dataclass
class Refusal:
    reason: str  # permission | sensitive | out_of_range | unknown_metric | unsupported | write | export | forecast | off_topic
    message: str
    suggestions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"reason": self.reason, "message": self.message, "suggestions": self.suggestions}


REFUSAL_TEXT = {
    "permission": "超出数据权限",
    "sensitive": "敏感数据",
    "out_of_range": "超出数据范围",
    "unknown_metric": "语义层中没有该指标",
    "unsupported": "口径不支持该拆分",
    "write": "只读系统",
    "export": "不提供明细导出",
    "forecast": "不做预测",
    "off_topic": "与经营数据无关",
    "security": "SQL 安全校验未通过",
}
