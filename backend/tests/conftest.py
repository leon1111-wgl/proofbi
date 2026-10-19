import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.warehouse.generate import generate


@pytest.fixture(scope="session")
def warehouse_path(tmp_path_factory):
    """One synthetic warehouse for the whole test session (~1.5 s to build)."""
    path = tmp_path_factory.mktemp("warehouse") / "warehouse.db"
    generate(path)
    return str(path)


def make_settings(warehouse_path: str, db_path) -> Settings:
    s = Settings()
    s.warehouse_path = warehouse_path
    s.database_url = f"sqlite:///{db_path}"
    s.jwt_secret = "test-secret-with-at-least-32-bytes!!"
    s.demo = True
    return s


@pytest.fixture(scope="session")
def services(warehouse_path, tmp_path_factory):
    from app.services import Services

    return Services(make_settings(warehouse_path, tmp_path_factory.mktemp("db") / "app.db"))


@pytest.fixture()
def users(services):
    return services.access.users


@pytest.fixture()
def settings(warehouse_path, tmp_path):
    return make_settings(warehouse_path, tmp_path / "app.db")


@pytest.fixture()
def client(settings):
    from app.main import create_app

    app = create_app(settings, seed_eval=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def login(client):
    def _login(username: str) -> dict:
        r = client.post("/api/auth/login", json={"username": username, "password": "proofbi-demo"})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['token']}"}

    return _login


@pytest.fixture()
def ask(services):
    """Run one question through the pipeline (no HTTP) and return the RunRecord."""
    from app.agent.pipeline import AskInput, collect

    def _ask(username: str, question: str, **kwargs):
        record, _ = collect(services.pipeline.run(AskInput(question, services.access.users[username], **kwargs)))
        return record

    return _ask


def sse_events(response) -> list[dict]:
    return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
