"""口径 lint: equivalent SQL passes, SQL that answers a different question does not."""

import pytest
import sqlglot

from app.semantic.compiler import compile_spec, split_plan
from app.semantic.plan import Plan
from app.semantic.timeparse import parse_time, previous_period
from app.sqlsafe.lint import lint_sql

SEPT = "AND order_date BETWEEN '2026-09-01' AND '2026-09-30'"


@pytest.fixture()
def spec_for(services):
    def _spec(metric="gmv", filters=None, compare=None):
        month = parse_time("上个月", services.layer.calendar)
        plan = Plan(metrics=[metric], time=month, filters=filters or {}, compare=compare,
                    compare_time=previous_period(month, compare) if compare else None)
        return split_plan(plan, services.layer)[0]
    return _spec


def codes(services, spec, sql):
    issues = lint_sql(sqlglot.parse_one(sql, read="sqlite"), spec, services.layer, services.lookups.value_codes())
    return [i.code for i in issues]


def test_compiled_sql_is_always_clean(services, spec_for):
    for metric in services.layer.metrics:
        spec = spec_for(metric)
        assert codes(services, spec, compile_spec(spec, services.layer, 1000)) == [], metric


@pytest.mark.parametrize("sql", [
    f"SELECT SUM(pay_amount) FROM orders WHERE status IN ('paid', 'refunded') {SEPT}",
    f"SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' {SEPT}",
    f"SELECT SUM(pay_amount) FROM orders WHERE NOT status IN ('cancelled') {SEPT}",
    f"SELECT SUM(pay_amount) FROM orders WHERE (status = 'paid' OR status = 'refunded') {SEPT}",
    "SELECT SUM(pay_amount) FROM orders WHERE status != 'cancelled' AND order_date >= '2026-09-01' AND order_date < '2026-10-01'",
    "SELECT SUM(pay_amount) FROM orders WHERE status != 'cancelled' AND SUBSTR(order_date, 1, 7) = '2026-09'",
    "SELECT SUM(pay_amount) FROM orders WHERE status != 'cancelled' AND STRFTIME('%Y-%m', order_date) = '2026-09'",
    "SELECT SUM(pay_amount) FROM orders WHERE status != 'cancelled' AND order_date LIKE '2026-09%'",
])
def test_equivalent_forms_are_accepted(services, spec_for, sql):
    assert codes(services, spec_for("gmv"), sql) == []


@pytest.mark.parametrize("sql,code", [
    (f"SELECT SUM(pay_amount) FROM orders WHERE 1 = 1 {SEPT}", "missing_status_filter"),
    (f"SELECT SUM(pay_amount) FROM orders WHERE status = 'paid' {SEPT}", "wrong_status_filter"),
    (f"SELECT SUM(gross_amount) FROM orders WHERE status <> 'cancelled' {SEPT}", "wrong_aggregate"),
    ("SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' AND order_date >= '2026-09-01' "
     "AND order_date < '2026-09-30'", "wrong_time_range"),
    ("SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' "
     "AND order_date >= DATE('now', 'start of month', '-1 month')", "non_literal_date"),
    ("SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled'", "missing_time_filter"),
])
def test_caliber_mistakes_are_caught(services, spec_for, sql, code):
    assert code in codes(services, spec_for("gmv"), sql)


def test_status_inside_case_is_formula_not_filter(services, spec_for):
    spec = spec_for("refund_rate")
    sql = (f"SELECT COUNT(DISTINCT CASE WHEN status = 'refunded' THEN order_id END) * 1.0 / COUNT(DISTINCT order_id) "
           f"FROM orders WHERE status IN ('paid', 'refunded') {SEPT}")
    assert codes(services, spec, sql) == []


def test_net_revenue_accepts_paid_only(services, spec_for):
    spec = spec_for("net_revenue")
    assert codes(services, spec, f"SELECT SUM(pay_amount) FROM orders WHERE status = 'paid' {SEPT}") == []


def test_filter_values_must_appear(services, spec_for):
    spec = spec_for("gmv", {"region": ["华东"]})
    base = f"SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' {SEPT}"
    assert "missing_filter" in codes(services, spec, base)
    assert codes(services, spec, base + " AND region_id = 'east'") == []  # code instead of label is fine


def test_comparison_needs_both_periods(services, spec_for):
    spec = spec_for("gmv", compare="mom")
    both = ("SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' AND (order_date BETWEEN '2026-08-01' "
            "AND '2026-08-31' OR order_date BETWEEN '2026-09-01' AND '2026-09-30')")
    assert codes(services, spec, both) == []
    assert "wrong_time_range" in codes(services, spec, f"SELECT SUM(pay_amount) FROM orders WHERE status <> 'cancelled' {SEPT}")


def test_unknown_column_is_left_to_the_executor(services, spec_for):
    sql = f"SELECT SUM(o.amount) FROM orders AS o WHERE o.status <> 'cancelled' {SEPT.replace('order_date', 'o.order_date')}"
    assert codes(services, spec_for("gmv"), sql) == []
