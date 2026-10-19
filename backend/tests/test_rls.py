"""Row-level security: the rewrite filters every table reference, whatever the SQL says,
and the execution layer refuses what the rewrite never lets through."""

import pytest

from app.sqlsafe.executor import QueryError, Warehouse
from app.sqlsafe.guard import SqlGuard
from app.sqlsafe.rls import apply_row_policies

SEPT = "o.order_date BETWEEN '2026-09-01' AND '2026-09-30'"


def run_as(services, username, sql):
    user = services.access.users[username]
    allowed = services.layer.allowed_columns(user.permissions)
    guard = SqlGuard(set(services.layer.tables), services.layer.blocked_columns(user.permissions))
    checked = guard.check(sql)
    assert checked.ok, checked.violations
    rewritten = apply_row_policies(checked.tree, user, services.access, allowed)
    return rewritten, services.warehouse.execute(rewritten.sql, allowed)


def regions_seen(services, username, sql):
    _, result = run_as(services, username, sql)
    return {row[0] for row in result.rows}


@pytest.mark.parametrize("sql", [
    "SELECT region_id FROM orders GROUP BY region_id",
    "SELECT o.region_id FROM orders AS o WHERE o.region_id = 'south' OR 1 = 1 GROUP BY o.region_id",
    "SELECT t.region_id FROM (SELECT region_id FROM orders) AS t GROUP BY t.region_id",
    "WITH x AS (SELECT region_id FROM orders) SELECT region_id FROM x GROUP BY region_id",
    "SELECT region_id FROM orders UNION SELECT region_id FROM stores",
    "SELECT o.region_id FROM customers AS c JOIN orders AS o ON o.customer_id = c.customer_id GROUP BY o.region_id",
    "SELECT region_id FROM ORDERS GROUP BY region_id",
    'SELECT region_id FROM "orders" GROUP BY region_id',
    "SELECT regions.region_id FROM orders AS regions GROUP BY regions.region_id",
    "SELECT r.region_id FROM regions AS r WHERE EXISTS (SELECT 1 FROM orders AS o WHERE o.region_id = r.region_id)",
])
def test_bypass_attempts_only_see_own_region(services, sql):
    assert regions_seen(services, "mia", sql) <= {"east"}


def test_policy_applies_inside_subquery_filters(services):
    _, result = run_as(services, "mia", "SELECT COUNT(*) FROM order_items WHERE order_id IN "
                                       "(SELECT order_id FROM orders WHERE region_id = 'south')")
    assert result.rows == [[0]]


def test_region_scope_matches_explicit_filter(services):
    sql = f"SELECT ROUND(SUM(o.pay_amount), 2) FROM orders AS o WHERE o.status IN ('paid', 'refunded') AND {SEPT}"
    _, mia = run_as(services, "mia", sql)
    _, leon = run_as(services, "leon", sql + " AND o.region_id = 'east'")
    assert mia.rows == leon.rows


def test_store_scope(services):
    rewritten, result = run_as(services, "noah", "SELECT store_id, COUNT(*) FROM orders GROUP BY store_id")
    assert [r[0] for r in result.rows] == ["S01"]
    assert rewritten.policies["orders"] == "store_id IN ('S01')"
    # customers are visible only if they bought in Noah's store
    _, customers = run_as(services, "noah", "SELECT COUNT(*) FROM customers")
    _, buyers = run_as(services, "leon", "SELECT COUNT(DISTINCT customer_id) FROM orders WHERE store_id = 'S01'")
    assert customers.rows == buyers.rows


def test_admin_has_no_row_filter_but_still_no_phone(services):
    rewritten, result = run_as(services, "leon", "SELECT COUNT(DISTINCT region_id) FROM orders")
    assert result.rows == [[7]]
    assert rewritten.policies["orders"] is None
    rewritten, _ = run_as(services, "leon", "SELECT customer_id FROM customers LIMIT 1")
    assert "phone" not in rewritten.sql  # the policy view projects allowed columns only


def test_cost_column_only_for_cost_permission(services):
    _, result = run_as(services, "jack", "SELECT ROUND(AVG(unit_cost), 2) FROM products")
    assert result.rows[0][0] > 0
    guard = SqlGuard(set(services.layer.tables), services.layer.blocked_columns(services.access.users["mia"].permissions))
    assert not guard.check("SELECT unit_cost FROM products").ok


# ---------------------------------------------------------------- execution layer (third line)
@pytest.fixture()
def raw_executor(services):
    """Executes SQL directly, as if the guard and the rewrite had been bypassed."""
    allowed = services.layer.allowed_columns(frozenset())
    return lambda sql: services.warehouse.execute(sql, allowed)


@pytest.mark.parametrize("sql", [
    "SELECT name FROM sqlite_master",
    "SELECT phone FROM customers",
    "SELECT unit_cost FROM products",
    "SELECT key, value FROM dataset_meta",
    "PRAGMA table_info(orders)",
    "SELECT load_extension('x')",
    "SELECT hex(order_id) FROM orders",
    "DELETE FROM orders",
    "ATTACH DATABASE ':memory:' AS other",
])
def test_authorizer_denies_even_without_the_guard(raw_executor, sql):
    with pytest.raises(QueryError) as exc:
        raw_executor(sql)
    assert exc.value.kind in ("denied", "execution")


def test_runaway_query_is_interrupted(services):
    warehouse = Warehouse(services.settings.warehouse_path, timeout_ms=300, max_rows=10)
    with pytest.raises(QueryError) as exc:
        warehouse.execute("SELECT COUNT(*) FROM orders a, orders b, orders c", services.layer.allowed_columns(frozenset()))
    assert exc.value.kind == "timeout"


def test_rows_are_capped_and_hashed(services):
    warehouse = Warehouse(services.settings.warehouse_path, max_rows=5)
    allowed = services.layer.allowed_columns(frozenset())
    first = warehouse.execute("SELECT order_id FROM orders ORDER BY order_id", allowed)
    second = warehouse.execute("SELECT order_id FROM orders ORDER BY order_id", allowed)
    assert first.row_count == 5 and first.truncated
    assert first.result_hash == second.result_hash
