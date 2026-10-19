"""Evaluation harness: result-set comparison, the case file and the CLI gate."""

from pathlib import Path

import pytest

from app.evals.compare import compare_results, gold_is_ordered
from app.evals.runner import load_cases, run_gold, summarize

CASES = Path(__file__).resolve().parents[1] / "evals" / "cases.yaml"


def test_exact_and_unordered_match():
    assert compare_results([["华东", 1.0], ["华南", 2.0]], [["华南", 2.0], ["华东", 1.0]], ordered=False)[0]
    assert not compare_results([["华东", 1.0], ["华南", 2.0]], [["华南", 2.0], ["华东", 1.0]], ordered=True)[0]


def test_prediction_may_have_extra_columns_in_any_order():
    pred = [[63, 352, 0.179]]  # repeat buyers, buyers, rate
    assert compare_results(pred, [[0.179]], ordered=False)[0]
    assert compare_results([["华东", 7, 0.5]], [[0.5, "华东"]], ordered=False)[0]


def test_rounding_tolerance():
    assert compare_results([[0.179]], [[0.17897727]], ordered=False)[0]
    assert not compare_results([[0.179]], [[0.1795]], ordered=False)[0]
    assert compare_results([[133620.97]], [[133620.9700000001]], ordered=False)[0]
    assert not compare_results([[133620.97]], [[133620.99]], ordered=False)[0]


def test_row_and_column_mismatches():
    assert "行数" in compare_results([[1], [2]], [[1]], ordered=False)[1]
    assert "列数" in compare_results([[1]], [[1, 2]], ordered=False)[1]
    assert not compare_results([["a", 1], ["b", 2]], [["a", 2], ["b", 1]], ordered=False)[0]


def test_ordered_detection():
    assert gold_is_ordered("SELECT a FROM t ORDER BY a")
    assert not gold_is_ordered("SELECT a FROM (SELECT a FROM t ORDER BY a) AS x")


def test_case_file_is_well_formed():
    cases = load_cases(CASES)
    assert 50 <= len(cases) <= 60
    assert {c.category for c in cases} == {"answer", "clarify", "refusal", "security"}
    assert {c.split for c in cases} == {"dev", "holdout"}
    for c in cases:
        if c.category == "answer":
            assert c.metrics and c.gold_sql, c.id
        if c.category == "refusal":
            assert c.reason, c.id


def test_every_gold_sql_passes_the_guard_and_runs(services):
    for case in load_cases(CASES):
        for sql in case.gold_sql:
            rows = run_gold(services, case, sql)
            assert rows, case.id


def test_summary_metrics():
    rows = [
        {"case_id": "a", "split": "dev", "category": "answer", "passed": True, "status": "answered",
         "checks": {"answered": True, "caliber": True, "execution": True, "numbers_verified": True},
         "latency_ms": 3.0, "corrections": 0},
        {"case_id": "b", "split": "holdout", "category": "answer", "passed": False, "status": "refused",
         "checks": {"answered": False, "caliber": False, "execution": False}, "latency_ms": 1.0, "corrections": 0},
        {"case_id": "c", "split": "dev", "category": "refusal", "passed": True, "status": "refused",
         "checks": {"refused": True, "reason": True}, "latency_ms": 0.1, "corrections": 0},
    ]
    m = summarize(rows)
    assert m["execution_accuracy"] == 0.5 and m["false_refusal_rate"] == 0.5 and m["refusal_accuracy"] == 1.0
    assert m["by_split"]["dev"]["pass_rate"] == 1.0 and m["failed_cases"] == ["b"]


def test_cli_gate(settings, tmp_path, monkeypatch):
    from app import config
    from app.evals import cli

    monkeypatch.setattr(config, "_settings", settings)
    report = tmp_path / "report.json"
    assert cli.main(["--split", "dev", "--gate", "0.9", "--gate-dev", "1.0", "--report", str(report)]) == 0
    assert report.exists()
    assert cli.main(["--split", "holdout", "--gate", "1.0"]) == 1  # the holdout set is not perfect


@pytest.mark.parametrize("split", ["dev"])
def test_dev_split_is_fully_green(services, split, tmp_path):
    from app.db import create_all, init_engine, new_session
    from app.evals.runner import run_suite

    init_engine(f"sqlite:///{tmp_path / 'eval.db'}")
    create_all()
    with new_session() as db:
        run = run_suite(services, db, [c for c in load_cases(CASES) if c.split == split])
    assert run.metrics["pass_rate"] == 1.0, run.metrics["failed_cases"]
