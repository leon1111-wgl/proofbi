"""HTTP API: auth, asking, provenance, replay, access control and admin-only endpoints."""

from conftest import sse_events


def test_health_and_login(client, login):
    assert client.get("/api/health").json()["synthetic"] is True
    assert client.post("/api/auth/login", json={"username": "leon", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "nobody", "password": "proofbi-demo"}).status_code == 401
    me = client.get("/api/auth/me", headers=login("mia")).json()
    assert me["scope"]["label"] == "华东" and me["scope"]["type"] == "region"


def test_requires_token(client):
    assert client.post("/api/ask", json={"question": "上个月 GMV"}).status_code == 401
    assert client.get("/api/semantic", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_demo_users_list(client):
    data = client.get("/api/auth/demo-users").json()
    assert {u["username"] for u in data["users"]} == {"leon", "jack", "mia", "emma", "noah"}


def test_answer_numbers_link_to_queries(client, login):
    h = login("leon")
    r = client.post("/api/ask", json={"question": "上个月华东区复购率是多少？"}, headers=h)
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] == "answered" and run["answer"]["verification"]["verdict"] == "pass"
    number = run["answer"]["verification"]["numbers"][0]
    query = client.get(f"/api/queries/{number['ref']['query_id']}", headers=h).json()
    assert query["status"] == "ok" and query["rows"][number["ref"]["row"]]
    assert "region_name" in query["sql"] and query["executed_sql"] and query["dataset_fingerprint"]
    assert query["question"] == "上个月华东区复购率是多少？"


def test_replay_reproduces_the_result_hash(client, login):
    h = login("mia")
    run = client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=h).json()
    query_id = run["queries"][0]["query_id"]
    replay = client.post(f"/api/queries/{query_id}/replay", headers=h).json()
    assert replay["match"] is True and replay["replay_hash"] == run["queries"][0]["result_hash"]
    assert replay["dataset_changed"] is False


def test_other_users_cannot_read_my_queries(client, login):
    run = client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=login("leon")).json()
    query_id = run["queries"][0]["query_id"]
    assert client.get(f"/api/queries/{query_id}", headers=login("mia")).status_code == 404
    assert client.get(f"/api/runs/{run['run_id']}", headers=login("emma")).status_code == 404
    assert client.get(f"/api/queries/q_doesnotexist", headers=login("leon")).status_code == 404


def test_admin_can_read_everyone(client, login):
    run = client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=login("mia")).json()
    assert client.get(f"/api/queries/{run['queries'][0]['query_id']}", headers=login("leon")).status_code == 200


def test_clarify_then_answer_in_the_same_conversation(client, login):
    h = login("leon")
    first = client.post("/api/ask", json={"question": "上个月销售额是多少？"}, headers=h).json()
    assert first["status"] == "clarify" and first["clarification"]["term"] == "销售额"
    second = client.post("/api/ask", json={"question": "上个月销售额是多少？", "conversation_id": first["conversation_id"],
                                           "clarifications": {"销售额": "gmv"}}, headers=h).json()
    assert second["status"] == "answered" and second["plan"]["metrics"] == ["gmv"]
    convo = client.get(f"/api/conversations/{first['conversation_id']}", headers=h).json()
    assert [r["status"] for r in convo["runs"]] == ["clarify", "answered"]


def test_follow_up_uses_conversation_context(client, login):
    h = login("leon")
    first = client.post("/api/ask", json={"question": "上个月华东区复购率是多少？"}, headers=h).json()
    second = client.post("/api/ask", json={"question": "那华南呢？", "conversation_id": first["conversation_id"]},
                         headers=h).json()
    assert second["status"] == "answered"
    assert second["plan"]["metrics"] == ["repurchase_rate"] and second["plan"]["filters"] == {"region": ["华南"]}


def test_conversations_are_private(client, login):
    convo = client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=login("leon")).json()["conversation_id"]
    assert client.get(f"/api/conversations/{convo}", headers=login("mia")).status_code == 404
    r = client.post("/api/ask", json={"question": "上个月的 GMV", "conversation_id": convo}, headers=login("mia"))
    assert r.status_code == 404


def test_permission_refusal_over_http(client, login):
    run = client.post("/api/ask", json={"question": "华南区上个月 GMV 是多少？"}, headers=login("mia")).json()
    assert run["status"] == "refused" and run["refusal"]["reason"] == "permission"
    assert run["queries"] == []


def test_demo_faults_are_admin_only(client, login):
    body = {"question": "上个月的 GMV", "fault": "sql_error"}
    assert client.post("/api/ask", json=body, headers=login("mia")).status_code == 403
    run = client.post("/api/ask", json=body, headers=login("leon")).json()
    assert run["corrections"] == 1 and run["failed_attempts"][0]["status"] == "error"
    assert client.post("/api/ask", json={**body, "fault": "rm -rf"}, headers=login("leon")).status_code == 422


def test_stream_emits_steps_then_result(client, login):
    r = client.post("/api/ask/stream", json={"question": "近 3 个月退款率趋势"}, headers=login("leon"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r)
    assert events[0]["type"] == "started" and events[-1]["type"] == "result"
    assert any(e.get("step") == "execute" for e in events)
    result = events[-1]["result"]
    assert result["answer"]["charts"][0]["type"] == "line"
    assert client.get(f"/api/runs/{result['run_id']}", headers=login("leon")).status_code == 200


def test_semantic_catalog_and_policies(client, login):
    mine = client.get("/api/semantic", headers=login("mia")).json()
    assert {m["key"] for m in mine["metrics"]} >= {"gmv", "repurchase_rate"}
    margin = next(m for m in mine["metrics"] if m["key"] == "gross_margin")
    assert margin["accessible"] is False
    assert [p["username"] for p in mine["policies"]] == ["mia"]
    assert mine["policies"][0]["tables"]["orders"] == "region_id IN ('east')"
    everyone = client.get("/api/semantic", headers=login("leon")).json()
    assert len(everyone["policies"]) == 5


def test_meta_shows_dataset_and_model(client, login):
    meta = client.get("/api/meta", headers=login("leon")).json()
    assert meta["dataset"]["synthetic"] is True and meta["calendar"]["today"] == "2026-10-01"
    assert "sql_error" in meta["faults"]
    assert client.get("/api/meta", headers=login("mia")).json()["faults"] == {}


def test_traces_are_scoped(client, login):
    client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=login("leon"))
    client.post("/api/ask", json={"question": "上个月的 GMV"}, headers=login("mia"))
    mine = client.get("/api/traces", headers=login("mia")).json()
    assert {t["username"] for t in mine} == {"mia"}
    assert {t["username"] for t in client.get("/api/traces", headers=login("leon")).json()} >= {"leon", "mia"}
    detail = client.get(f"/api/traces/{mine[0]['run_id']}", headers=login("mia")).json()
    assert [s["kind"] for s in detail["spans"]][:3] == ["plan", "sql", "guard"]
    assert {"lint", "rls", "execute", "narrate", "verify"} <= {s["kind"] for s in detail["spans"]}


def test_eval_endpoints(client, login):
    assert client.post("/api/evals/run", headers=login("mia")).status_code == 403
    run = client.post("/api/evals/run", headers=login("leon")).json()
    assert run["total"] >= 50 and run["metrics"]["security_pass_rate"] == 1.0
    detail = client.get(f"/api/evals/runs/{run['id']}", headers=login("mia")).json()
    assert len(detail["results"]) == run["total"]


def test_daily_report_preview(client, login):
    assert client.post("/api/reports/daily", json={}, headers=login("mia")).status_code == 403
    report = client.post("/api/reports/daily", json={"send": False}, headers=login("leon")).json()
    assert "经营日报" in report["markdown"] and "/q/q_" in report["markdown"] and len(report["runs"]) == 3
    assert client.post("/api/reports/daily", json={"send": True}, headers=login("leon")).status_code == 409
