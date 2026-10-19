"""OpenAI-compatible adapter, LLM components with fallbacks, and the WeCom webhook (all mocked)."""

import json

import httpx
import pytest

from app.agent.llm_components import LLMNarrator, LLMPlanner, LLMSQLWriter
from app.agent.narrator import QueryOutput, align_columns
from app.channels.wecom import send_markdown
from app.config import PROVIDER_PRESETS, Settings
from app.llm.base import ChatMessage, ChatModel, ChatResult, LLMError, extract_json, extract_sql
from app.llm.openai_compat import OpenAICompatModel
from app.semantic.compiler import split_plan
from app.semantic.plan import Plan
from app.semantic.timeparse import parse_time


def reply(content, usage=True):
    body = {"model": "m", "choices": [{"message": {"role": "assistant", "content": content}}]}
    if usage:
        body["usage"] = {"prompt_tokens": 12, "completion_tokens": 5}
    return httpx.Response(200, json=body)


def test_presets_cover_the_three_vendors():
    assert set(PROVIDER_PRESETS) == {"hunyuan", "doubao", "deepseek"}
    s = Settings()
    s.llm_provider, s.llm_preset = "openai_compat", "hunyuan"
    assert "llm" in (s.planner_mode, s.sql_writer_mode)


def test_request_shape_and_usage():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return reply("好的")

    model = OpenAICompatModel("https://example.test/v1/", "sk-test", "hunyuan-x", transport=httpx.MockTransport(handler))
    result = model.chat([ChatMessage("user", "hi")], json_mode=True)
    assert seen["url"] == "https://example.test/v1/chat/completions" and seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "hunyuan-x" and seen["body"]["response_format"] == {"type": "json_object"}
    assert (result.content, result.prompt_tokens, result.usage_estimated) == ("好的", 12, False)


def test_retries_on_429_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429, text="slow down") if len(calls) < 3 else reply("ok", usage=False)

    model = OpenAICompatModel("https://x.test/v1", "k", "m", transport=httpx.MockTransport(handler), sleep=lambda _: None)
    result = model.chat([ChatMessage("user", "hi")])
    assert len(calls) == 3 and result.usage_estimated


def test_bad_request_is_not_retried():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400, text="bad model")

    model = OpenAICompatModel("https://x.test/v1", "k", "m", transport=httpx.MockTransport(handler), sleep=lambda _: None)
    with pytest.raises(LLMError, match="400"):
        model.chat([ChatMessage("user", "hi")])
    assert len(calls) == 1


def test_missing_configuration_fails_fast():
    with pytest.raises(LLMError):
        OpenAICompatModel(None, "k", "m")


def test_extractors():
    assert extract_json('好的：```json\n{"kind": "plan"}\n```') == {"kind": "plan"}
    assert extract_json('前缀 {"a": 1} 后缀') == {"a": 1}
    assert extract_sql("```sql\nSELECT 1\n```") == "SELECT 1"
    assert extract_sql("SQL 如下：SELECT 2 FROM t") == "SELECT 2 FROM t"


class FakeModel(ChatModel):
    name = "fake"
    model = "fake-1"

    def __init__(self, replies):
        self.replies = list(replies)
        self.messages = []

    def chat(self, messages, temperature=0.0, json_mode=False):
        self.messages.append(messages)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return ChatResult(item, self.model, 10, 5)


@pytest.fixture()
def llm_planner(services):
    def _make(replies):
        return LLMPlanner(FakeModel(replies), services.layer, services.lookups, services.rules_planner)
    return _make


def test_llm_plan_is_validated_by_code(llm_planner, users):
    planner = llm_planner(['{"kind": "plan", "metrics": ["gmv"], "dimensions": ["region"], "filters": {},'
                           ' "time_expression": "上个月", "compare": null, "order": "desc", "limit": 3}'])
    out = planner.plan("上个月 GMV 前三的区域", users["leon"])
    assert out.kind == "plan" and out.plan.metrics == ["gmv"] and out.plan.limit == 3
    assert out.plan.time.start.isoformat() == "2026-09-01"  # relative dates are resolved by code


def test_llm_plan_cannot_bypass_permissions(llm_planner, users):
    planner = llm_planner(['{"kind": "plan", "metrics": ["gmv"], "filters": {"region": ["华南"]}, "time_expression": "上个月"}'])
    out = planner.plan("看看华南", users["mia"])
    assert out.kind == "refuse" and out.refusal.reason == "permission"


def test_llm_unknown_metric_gets_one_retry(llm_planner, users):
    planner = llm_planner(['{"kind": "plan", "metrics": ["sales"]}',
                           '{"kind": "plan", "metrics": ["order_count"], "time_expression": "上个月"}'])
    out = planner.plan("上个月多少单", users["leon"])
    assert out.kind == "plan" and out.plan.metrics == ["order_count"]
    assert "未知指标" in planner.model.messages[1][-1].content


def test_screening_runs_before_the_model(llm_planner, users):
    planner = llm_planner([])  # any model call would fail: the screen must answer first
    assert planner.plan("导出客户手机号", users["leon"]).refusal.reason == "sensitive"
    assert planner.plan("上个月销售额多少", users["leon"]).kind == "clarify"


def test_llm_failure_falls_back_to_rules(llm_planner, users):
    planner = llm_planner([LLMError("timeout")])
    out = planner.plan("上个月华东区复购率是多少？", users["leon"])
    assert out.kind == "plan" and "fallback" in out.trace and planner.usage.fallbacks == 1


def test_llm_sql_writer_prompt_and_retry(services):
    model = FakeModel(["```sql\nSELECT 1\n```", "```sql\nSELECT 2\n```"])
    writer = LLMSQLWriter(model, services.layer, services.template_writer)
    month = parse_time("上个月", services.layer.calendar)
    spec = split_plan(Plan(metrics=["gmv"], time=month, filters={"region": ["华东"]}), services.layer)[0]
    allowed = services.layer.allowed_columns(frozenset())
    assert writer.write(spec, 0, [], None, allowed_columns=allowed).sql == "SELECT 1"
    system = model.messages[0][0].content
    assert "o.status IN ('paid', 'refunded')" in system and "phone" not in system and "unit_cost" not in system
    assert writer.write(spec, 1, ["执行报错：no such column"], "SELECT 1", allowed_columns=allowed).sql == "SELECT 2"
    assert "no such column" in model.messages[1][-1].content


def test_llm_sql_writer_falls_back_to_template(services):
    writer = LLMSQLWriter(FakeModel([LLMError("503")]), services.layer, services.template_writer)
    month = parse_time("上个月", services.layer.calendar)
    spec = split_plan(Plan(metrics=["gmv"], time=month), services.layer)[0]
    result = writer.write(spec, 0, [], None)
    assert result.sql.startswith("SELECT") and "回退" in result.note


def test_llm_narrator_output_is_still_verified(services, ask):
    record = ask("leon", "上个月的 GMV 是多少？")
    attempt = [a for a in record.attempts if a.status == "ok"][0]
    plan = Plan.from_dict(record.plan)
    spec = split_plan(plan, services.layer)[0]
    output = QueryOutput(spec, attempt.id, attempt.columns, attempt.rows,
                         align_columns(spec, attempt.columns, attempt.rows, services.layer))
    narrator = LLMNarrator(FakeModel(["上个月 GMV 为 46.78 万元，约 50 万元。"]), services.layer, services.template_narrator)
    text = narrator.narrate(plan, [output], question="上个月的 GMV 是多少？")
    from app.agent.verifier import ResultTable, verify_answer
    report = verify_answer(text, [ResultTable(attempt.id, attempt.columns, attempt.rows)])
    assert [n.status for n in report.numbers] == ["verified", "unverified"]


def test_wecom_payload():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"errcode": 0, "errmsg": "ok"})

    send_markdown("KEY123", "**日报**", transport=httpx.MockTransport(handler))
    assert seen["url"].endswith("/cgi-bin/webhook/send?key=KEY123")
    assert seen["body"] == {"msgtype": "markdown", "markdown": {"content": "**日报**"}}


def test_wecom_error_is_raised():
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"errcode": 93000, "errmsg": "invalid key"}))
    with pytest.raises(RuntimeError, match="93000"):
        send_markdown("bad", "x", transport=transport)
