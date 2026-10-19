"""Semantic layer: loading, validation, time resolution and the compiler."""

from datetime import date
from pathlib import Path

import pytest
import yaml

from app.semantic.compiler import compile_spec, split_plan
from app.semantic.layer import SemanticError, SemanticLayer
from app.semantic.plan import Plan
from app.semantic.timeparse import OutOfRange, default_range, parse_time, previous_period
from app.services import check_dimension_values

YAML = Path(__file__).resolve().parents[1] / "semantic" / "retail.yaml"


@pytest.fixture(scope="module")
def layer():
    return SemanticLayer.load(YAML)


@pytest.fixture(scope="module")
def raw():
    return yaml.safe_load(YAML.read_text(encoding="utf-8"))


def test_layer_loads_all_metrics(layer):
    assert {"gmv", "net_revenue", "order_count", "buyer_count", "aov", "avg_order_value", "items_sold",
            "refund_amount", "refund_rate", "repurchase_rate", "gross_profit", "gross_margin"} <= set(layer.metrics)
    assert layer.calendar.today == date(2026, 10, 1)


def test_unknown_alias_is_rejected(raw):
    broken = yaml.safe_load(yaml.safe_dump(raw, allow_unicode=True))
    broken["metrics"]["gmv"]["expr"] = "SUM(x.pay_amount)"
    with pytest.raises(SemanticError, match="未声明的表别名"):
        SemanticLayer(broken)


def test_ambiguous_term_must_point_to_metrics(raw):
    broken = yaml.safe_load(yaml.safe_dump(raw, allow_unicode=True))
    broken["ambiguous_terms"]["销售额"] = ["gmv", "sales_magic"]
    with pytest.raises(SemanticError, match="sales_magic"):
        SemanticLayer(broken)


def test_unparseable_expression_is_rejected(raw):
    broken = yaml.safe_load(yaml.safe_dump(raw, allow_unicode=True))
    broken["metrics"]["gmv"]["expr"] = "SUM(o.pay_amount"
    with pytest.raises(SemanticError):
        SemanticLayer(broken)


def test_declared_values_exist_in_the_warehouse(services):
    check_dimension_values(services.layer, services.warehouse)  # raises on drift


def test_value_drift_stops_startup(services, raw):
    broken = yaml.safe_load(yaml.safe_dump(raw, allow_unicode=True))
    broken["dimensions"]["region"]["values"].append("海外")
    with pytest.raises(SemanticError, match="海外"):
        check_dimension_values(SemanticLayer(broken), services.warehouse)


def test_join_paths_only_go_many_to_one(layer):
    assert [j.to_table for j in layer.join_path("order_items", "regions")] == ["orders", "regions"]
    assert layer.join_path("orders", "products") is None  # would fan out
    assert layer.join_path("orders", "order_items") is None


def test_repurchase_cannot_be_split_by_item_dimensions(layer):
    allowed = layer.allowed_dimensions("repurchase_rate")
    assert "region" in allowed and "category" not in allowed and "product" not in allowed
    assert "category" in layer.allowed_dimensions("gmv")


def test_sensitive_and_cost_columns(layer):
    assert "phone" not in layer.allowed_columns(frozenset({"cost", "admin"}))["customers"]
    assert "unit_cost" not in layer.allowed_columns(frozenset())["products"]
    assert "unit_cost" in layer.allowed_columns(frozenset({"cost"}))["products"]


@pytest.mark.parametrize("text,start,end", [
    ("上个月", "2026-09-01", "2026-09-30"),
    ("上上个月", "2026-08-01", "2026-08-31"),
    ("近 30 天", "2026-09-01", "2026-09-30"),
    ("最近两个月", "2026-08-01", "2026-09-30"),
    ("2025年第三季度", "2025-07-01", "2025-09-30"),
    ("2025Q4", "2025-10-01", "2025-12-31"),
    ("上季度", "2026-07-01", "2026-09-30"),
    ("今年上半年", "2026-01-01", "2026-06-30"),
    ("今年", "2026-01-01", "2026-09-30"),
    ("去年", "2025-01-01", "2025-12-31"),
    ("8月", "2026-08-01", "2026-08-31"),
    ("11月", "2025-11-01", "2025-11-30"),
    ("今年9月", "2026-09-01", "2026-09-30"),
    ("2026-09-15", "2026-09-15", "2026-09-15"),
    ("双十一", "2025-11-01", "2025-11-11"),
    ("上周", "2026-09-21", "2026-09-27"),
    ("昨天", "2026-09-30", "2026-09-30"),
    ("过去一周", "2026-09-24", "2026-09-30"),
])
def test_time_expressions(layer, text, start, end):
    tr = parse_time(text, layer.calendar)
    assert (tr.start.isoformat(), tr.end.isoformat()) == (start, end)


@pytest.mark.parametrize("text", ["本月", "2023年", "今天", "本季度"])
def test_periods_without_data_are_out_of_range(layer, text):
    with pytest.raises(OutOfRange):
        parse_time(text, layer.calendar)


def test_partial_period_is_clamped_with_a_note(layer):
    tr = parse_time("2024年", layer.calendar)
    assert tr.start == date(2024, 10, 1) and tr.notes


def test_default_window_and_previous_periods(layer):
    tr = default_range(layer.calendar, trend=False)
    assert (tr.start, tr.end, tr.explicit) == (date(2026, 9, 1), date(2026, 9, 30), False)
    month = parse_time("上个月", layer.calendar)
    assert previous_period(month, "mom").start == date(2026, 8, 1)
    assert previous_period(month, "yoy").end == date(2025, 9, 30)


def _run(services, plan):
    rows = []
    for spec in split_plan(plan, services.layer):
        rows.append(services.warehouse.execute(compile_spec(spec, services.layer, 1000),
                                               services.layer.allowed_columns(frozenset({"cost"}))).rows)
    return rows


def test_every_metric_compiles_and_runs(services):
    layer = services.layer
    month = parse_time("上个月", layer.calendar)
    for key in layer.metrics:
        (rows,) = _run(services, Plan(metrics=[key], time=month))
        assert rows and rows[0][-1] is not None, key
        for dim in ("region", "month"):
            if dim in layer.allowed_dimensions(key):
                assert _run(services, Plan(metrics=[key], time=month, dimensions=[dim]))[0], (key, dim)


def test_category_split_does_not_double_count(services):
    """GMV by category is computed on allocated line payments, so the parts add up to the
    order-level total. Joining orders to lines and summing order amounts would not."""
    month = parse_time("上个月", services.layer.calendar)
    (total,) = _run(services, Plan(metrics=["gmv"], time=month))
    (by_category,) = _run(services, Plan(metrics=["gmv"], time=month, dimensions=["category"]))
    assert round(sum(r[1] for r in by_category), 2) == pytest.approx(total[0][0], abs=0.01)


def test_metrics_with_different_filters_become_separate_queries(services):
    month = parse_time("上个月", services.layer.calendar)
    specs = split_plan(Plan(metrics=["gmv", "gross_margin", "order_count"], time=month), services.layer)
    assert [s.metrics for s in specs] == [["gmv", "order_count"], ["gross_margin"]]
    assert specs[1].item_grain
