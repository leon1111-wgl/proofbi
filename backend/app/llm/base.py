"""Provider-neutral chat types. The agent only speaks these; adapters translate."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ChatMessage:
    role: str  # system | user | assistant
    content: str


@dataclass
class ChatResult:
    content: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    usage_estimated: bool = False


class LLMError(Exception):
    """Non-retryable failure (bad request, auth, unknown model)."""


class LLMRetryableError(LLMError):
    """Rate limit, timeout, 5xx, connection reset."""


class ChatModel(ABC):
    name: str = "base"
    model: str = ""

    @abstractmethod
    def chat(self, messages: list[ChatMessage], temperature: float = 0.0, json_mode: bool = False) -> ChatResult: ...


def estimate_tokens(text: str) -> int:
    """Rough count for vendors that omit usage: ~1 token per CJK char, ~4 chars per token otherwise."""
    cjk = len(re.findall(r"[一-鿿]", text))
    return cjk + max(0, len(text) - cjk) // 4 + 1


def extract_json(text: str) -> dict:
    """First JSON object in a model reply (tolerates ```json fences and prose around it)."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("回复中没有 JSON 对象")
        candidate = text[start:end + 1]
    value = json.loads(candidate)
    if not isinstance(value, dict):
        raise ValueError("JSON 不是对象")
    return value


def extract_sql(text: str) -> str:
    """SQL from a model reply: the ```sql block if present, else the text from SELECT/WITH on."""
    fenced = re.search(r"```(?:sql|sqlite)?\s*(.+?)```", text, re.S | re.I)
    if fenced:
        return fenced.group(1).strip()
    m = re.search(r"\b(SELECT|WITH)\b", text, re.I)
    return text[m.start():].strip() if m else text.strip()
