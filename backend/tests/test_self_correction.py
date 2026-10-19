"""Self-correction: recoverable errors go back to the writer (at most twice), security
violations stop immediately, and wrong numbers are flagged."""

from dataclasses import replace

import pytest

from app.agent.pipeline import AskInput, Pipeline, collect
from app.agent.sql_writer import WriteResult


class ScriptedWriter:
    """Returns the given SQL strings in order and records the feedback it received."""

    name = "scripted"

    def __init__(self, sqls):
        self.sqls = list(sqls)
        self.feedback = []

    def write(self, spec, attempt, feedback, previous_sql, *, fault=None, allowed_columns=None):
        self.feedback.append(list(feedback))
        return WriteResult(self.sqls[min(attempt, len(self.sqls) - 1)])


GOOD = ("SELECT ROUND(SUM(o.pay_amount), 2) AS gmv FROM orders AS o WHERE o.status IN ('paid', 'refunded') "
        "AND o.order_date BETWEEN '2026-09-01' AND '2026-09-30'")


@pytest.fixture()
def run_with_writer(services, users):
    def _run(writer, question="上个月的 GMV 是多少？", user="leon"):
        class Patched:
            def __getattr__(self, name):
                return writer if name == "sql_writer" else getattr(services, name)
        record, steps = collect(Pipeline(Patched()).run(AskInput(question, users[user])))
        return record, steps
    return _run


@pytest.mark.parametrize("fault,first_status", [
    ("sql_error", "error"),
    ("caliber_drift", "lint"),
    ("wrong_period", "lint"),
])
def test_offline_faults_are_corrected_on_the_second_attempt(ask, fault, first_status):
    clean = ask("leon", "上个月华东区的 GMV")
    record = ask("leon", "上个月华东区的 GMV", fault=fault)
    assert record.status == "answered" and record.corrections == 1
    assert [a.status for a in record.attempts] == [first_status, "ok"]
    final = [a for a in record.attempts if a.status == "ok"][0]
    assert final.rows == [a for a in clean.attempts if a.status == "ok"][0].rows


def test_execution_error_message_is_fed_back(run_with_writer):
    writer = ScriptedWriter([GOOD.replace("o.pay_amount", "o.amount"), GOOD])
    record, _ = run_with_writer(writer)
    assert record.status == "answered" and record.corrections == 1
    assert "no such column: o.amount" in writer.feedback[1][0]


def test_gives_up_after_two_corrections(run_with_writer):
    writer = ScriptedWriter(["SELECT SUM(o.nope) FROM orders AS o"] * 5)
    record, steps = run_with_writer(writer)
    assert record.status == "failed" and len(record.attempts) == 3
    assert "自我纠错 2 次" in record.error
    assert steps[-1]["status"] == "error"


def test_security_violation_is_not_retried(run_with_writer):
    writer = ScriptedWriter(["SELECT phone FROM customers", GOOD])
    record, _ = run_with_writer(writer)
    assert record.status == "refused" and record.refusal["reason"] == "security"
    assert len(record.attempts) == 1 and record.attempts[0].status == "security"


def test_stacked_statement_from_model_is_refused(run_with_writer):
    record, _ = run_with_writer(ScriptedWriter([GOOD + "; DROP TABLE orders"]))
    assert record.status == "refused" and record.attempts[0].violations[0]["code"] == "multiple_statements"


def test_model_sql_cannot_escape_row_policies(run_with_writer):
    """Even if the model ignores the plan and asks for another region, RLS filters it."""
    south = GOOD + " AND o.region_id = 'south'"
    writer = ScriptedWriter([south])
    record, _ = run_with_writer(writer, question="上个月的 GMV 是多少？", user="mia")
    # lint flags nothing about regions (the plan has no region filter), the policy view does the work
    final = [a for a in record.attempts if a.status == "ok"][0]
    assert final.rows == [[None]]
    assert final.policies["orders"] == "region_id IN ('east')"


def test_unsafe_model_sql_fault(ask):
    record = ask("leon", "上个月的 GMV 是多少？", fault="unsafe_sql")
    assert record.status == "refused" and record.refusal["reason"] == "security"


def test_hallucinated_number_is_flagged(ask):
    record = ask("leon", "上个月的 GMV 是多少？", fault="number_hallucination")
    assert record.status == "answered"
    verification = record.answer["verification"]
    assert verification["verdict"] == "fail" and verification["counts"]["unverified"] == 1


def test_every_answer_number_points_to_a_successful_query(ask):
    record = ask("leon", "上个月各区域 GMV 排名")
    ok_ids = {a.id for a in record.attempts if a.status == "ok"}
    numbers = record.answer["verification"]["numbers"]
    assert numbers and all(n["ref"]["query_id"] in ok_ids for n in numbers)


def test_steps_are_streamed_in_order(services, users):
    events = list(services.pipeline.run(AskInput("上个月华东区复购率是多少？", users["leon"])))
    kinds = [e.get("step") for e in events if e["type"] == "step"]
    assert kinds[0] == "plan" and "execute" in kinds and kinds[-1] == "verify"
    assert events[-1]["type"] == "result"


def test_restricted_user_sees_scope_note(ask):
    record = ask("mia", "上个月的 GMV 是多少？")
    assert record.scope == {"type": "region", "label": "华东", "restricted": True}
    assert any("行级权限" in n for n in record.plan_view["notes"])


def test_record_is_serialisable(ask):
    record = ask("leon", "上个月 GMV 环比")
    payload = record.public("abc")
    assert payload["queries"][0]["dataset_fingerprint"] == "abc"
    assert replace(record).id == record.id


def test_comparison_answer_has_both_periods(ask):
    record = ask("leon", "上个月净收入环比变化")
    assert record.answer["charts"][0]["type"] == "compare"
    assert "环比" in record.answer["text"] and record.answer["verification"]["counts"]["derived"] == 1
