"""FastAPI application factory.

    uvicorn app.main:app --reload --port 8000

If ``frontend/dist`` exists (``pnpm build``), the console is served from the same process,
so one container is enough for a demo deployment.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import __version__
from .api import ask, auth, evals, queries, reports, semantic, traces
from .config import Settings, get_settings, set_settings
from .db import create_all, init_engine, new_session
from .services import Services, set_services

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def _seed_eval_run(services: Services) -> None:
    """A fresh demo shows one offline eval run instead of an empty page."""
    from .evals.runner import load_cases, run_suite
    from .models import EvalRun

    with new_session() as db:
        if db.execute(select(EvalRun.id).limit(1)).first() is None:
            run_suite(services, db, load_cases(services.settings.eval_cases_path), triggered_by="startup")


def create_app(settings: Settings | None = None, seed_eval: bool | None = None) -> FastAPI:
    settings = settings or get_settings()
    set_settings(settings)
    init_engine(settings.database_url)
    create_all()
    services = Services(settings)
    set_services(services)
    if settings.demo if seed_eval is None else seed_eval:
        _seed_eval_run(services)

    app = FastAPI(title="ProofBI API", version=__version__,
                  description="可核对的 ChatBI：答案中的每个数字都能点开看到对应的 SQL、执行信息和结果行")
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])
    for module in (auth, ask, queries, semantic, traces, evals, reports):
        app.include_router(module.router)

    @app.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok", "version": __version__, "model": settings.model_label,
                "dataset": services.dataset["fingerprint"][:12], "synthetic": True}

    if FRONTEND_DIST.exists():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (FRONTEND_DIST / path).resolve()
            if path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


_app: FastAPI | None = None


def __getattr__(name: str):
    """Build ``app`` on first access so importing this module has no side effects."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
