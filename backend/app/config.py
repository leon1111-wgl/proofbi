"""Runtime configuration.

Every setting comes from an environment variable prefixed with ``PROOFBI_`` so the same
image runs in dev, CI and production. The default is fully offline: a rule-based planner
plus template SQL, which keeps tests and the CI eval gate reproducible.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Base URLs of OpenAI-compatible chat endpoints. Model IDs change often, so they are
# never hard-coded: copy them from each vendor's console into PROOFBI_LLM_MODEL.
PROVIDER_PRESETS: dict[str, str] = {
    "hunyuan": "https://api.hunyuan.cloud.tencent.com/v1",  # 腾讯 · 混元
    "doubao": "https://ark.cn-beijing.volces.com/api/v3",  # 字节 · 火山方舟
    "deepseek": "https://api.deepseek.com/v1",
}


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(f"PROOFBI_{name}")
    return value if value not in (None, "") else default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    return int(value) if value is not None else default


def _env_float(name: str, default: float) -> float:
    value = _env(name)
    return float(value) if value is not None else default


@dataclass
class Settings:
    # storage
    database_url: str = f"sqlite:///{BACKEND_DIR / 'data' / 'proofbi.db'}"
    warehouse_path: str = str(BACKEND_DIR / "data" / "warehouse.db")
    semantic_path: str = str(BACKEND_DIR / "semantic" / "retail.yaml")
    access_path: str = str(BACKEND_DIR / "semantic" / "access.yaml")
    eval_cases_path: str = str(BACKEND_DIR / "evals" / "cases.yaml")

    # auth
    jwt_secret: str = "dev-only-insecure-secret-change-me-in-prod"
    jwt_expire_minutes: int = 720
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])
    demo: bool = True  # list demo accounts on the login page and seed one eval run

    # "today" for relative dates such as 上个月. The synthetic data ends 2026-09-30, so the
    # default anchor keeps every relative question reproducible.
    today: str | None = None

    # model: mock (offline rules + templates) | openai_compat
    llm_provider: str = "mock"
    llm_preset: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "offline-rules"
    llm_timeout: float = 60.0
    planner: str = "auto"  # rules | llm | auto (llm when a real provider is configured)
    sql_writer: str = "auto"  # template | llm | auto

    # query limits
    max_rows: int = 1000
    query_timeout_ms: int = 3000
    max_corrections: int = 2
    max_joins: int = 6
    max_sql_chars: int = 6000

    # channels
    wecom_webhook_key: str | None = None
    public_url: str = "http://localhost:8000"

    @classmethod
    def from_env(cls) -> "Settings":
        s = cls()
        s.database_url = _env("DATABASE_URL", s.database_url)
        s.warehouse_path = _env("WAREHOUSE_PATH", s.warehouse_path)
        s.semantic_path = _env("SEMANTIC_PATH", s.semantic_path)
        s.access_path = _env("ACCESS_PATH", s.access_path)
        s.eval_cases_path = _env("EVAL_CASES_PATH", s.eval_cases_path)
        s.jwt_secret = _env("JWT_SECRET", s.jwt_secret)
        s.jwt_expire_minutes = _env_int("JWT_EXPIRE_MINUTES", s.jwt_expire_minutes)
        origins = _env("CORS_ORIGINS")
        if origins:
            s.cors_origins = [o.strip() for o in origins.split(",") if o.strip()]
        s.demo = _env_bool("DEMO", s.demo)
        s.today = _env("TODAY", s.today)

        s.llm_provider = _env("LLM_PROVIDER", s.llm_provider)
        s.llm_preset = _env("LLM_PRESET")
        s.llm_base_url = _env("LLM_BASE_URL") or PROVIDER_PRESETS.get(s.llm_preset or "")
        s.llm_api_key = _env("LLM_API_KEY")
        s.llm_model = _env("LLM_MODEL", s.llm_model if s.llm_provider == "mock" else "")
        s.llm_timeout = _env_float("LLM_TIMEOUT", s.llm_timeout)
        s.planner = _env("PLANNER", s.planner)
        s.sql_writer = _env("SQL_WRITER", s.sql_writer)

        s.max_rows = _env_int("MAX_ROWS", s.max_rows)
        s.query_timeout_ms = _env_int("QUERY_TIMEOUT_MS", s.query_timeout_ms)
        s.max_corrections = _env_int("MAX_CORRECTIONS", s.max_corrections)
        s.max_joins = _env_int("MAX_JOINS", s.max_joins)
        s.max_sql_chars = _env_int("MAX_SQL_CHARS", s.max_sql_chars)

        s.wecom_webhook_key = _env("WECOM_WEBHOOK_KEY")
        s.public_url = _env("PUBLIC_URL", s.public_url).rstrip("/")
        return s

    @property
    def uses_llm(self) -> bool:
        return self.llm_provider != "mock"

    @property
    def planner_mode(self) -> str:
        return ("llm" if self.uses_llm else "rules") if self.planner == "auto" else self.planner

    @property
    def sql_writer_mode(self) -> str:
        return ("llm" if self.uses_llm else "template") if self.sql_writer == "auto" else self.sql_writer

    @property
    def model_label(self) -> str:
        if not self.uses_llm:
            return "offline · rules + template SQL"
        name = self.llm_preset or "openai_compat"
        return f"{name}:{self.llm_model} · planner={self.planner_mode} · sql={self.sql_writer_mode}"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def set_settings(settings: Settings) -> None:
    """Swap the process-wide settings (used by the app factory and tests)."""
    global _settings
    _settings = settings
