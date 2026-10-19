"""OpenAI-compatible chat adapter: 混元 (Hunyuan), 豆包 (Doubao / Ark), DeepSeek.

Non-streaming: every call in the pipeline needs the whole reply (a JSON plan, a SQL
statement, a short conclusion) before it can be checked. 408/409/429/5xx and network
errors are retried with exponential backoff; other 4xx fail immediately.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable

import httpx

from .base import ChatMessage, ChatModel, ChatResult, LLMError, LLMRetryableError, estimate_tokens

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class OpenAICompatModel(ChatModel):
    name = "openai_compat"

    def __init__(self, base_url: str | None, api_key: str | None, model: str, timeout: float = 60.0,
                 max_retries: int = 2, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        if not base_url or not api_key or not model:
            raise LLMError("openai_compat 需要 PROOFBI_LLM_BASE_URL（或 PROOFBI_LLM_PRESET）、"
                           "PROOFBI_LLM_API_KEY 和 PROOFBI_LLM_MODEL")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.max_retries = max_retries
        self.sleep = sleep
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"Authorization": f"Bearer {api_key}"},
            transport=transport,
        )

    def chat(self, messages: list[ChatMessage], temperature: float = 0.0, json_mode: bool = False) -> ChatResult:
        payload: dict = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            try:
                response = self.client.post(f"{self.base_url}/chat/completions", json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt == self.max_retries:
                    raise LLMRetryableError(f"网络错误：{exc}") from exc
            else:
                if response.status_code < 400:
                    return self._parse(response, payload)
                body = response.text[:300]
                if response.status_code not in RETRYABLE_STATUS:
                    raise LLMError(f"HTTP {response.status_code}: {body}")
                if attempt == self.max_retries:
                    raise LLMRetryableError(f"HTTP {response.status_code}: {body}")
            self.sleep(delay)
            delay *= 2
        raise LLMRetryableError("unreachable")

    def _parse(self, response: httpx.Response, payload: dict) -> ChatResult:
        try:
            data = response.json()
            content = data["choices"][0]["message"].get("content") or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"无法解析模型返回：{response.text[:200]}") from exc
        usage = data.get("usage") or {}
        if usage:
            return ChatResult(content, data.get("model", self.model), int(usage.get("prompt_tokens", 0)),
                              int(usage.get("completion_tokens", 0)))
        prompt = json.dumps(payload["messages"], ensure_ascii=False)
        return ChatResult(content, data.get("model", self.model), estimate_tokens(prompt), estimate_tokens(content),
                          usage_estimated=True)
