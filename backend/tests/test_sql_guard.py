"""Static SQL guard: injection and bypass attempts, and what legitimate SQL looks like after it."""

import pytest

from app.sqlsafe.guard import SqlGuard

TABLES = {"orders", "order_items", "customers", "products", "stores", "regions"}
BLOCKED = {"phone": "会员.手机号 是敏感字段，不允许查询", "unit_cost": "商品.成本价 需要“cost”数据权限"}


@pytest.fixture()
def guard():
    return SqlGuard(TABLES, BLOCKED, max_rows=1000, max_joins=6, max_chars=6000)


# (sql, expected violation code) -- security violations: fail closed, never retried
SECURITY = [
    ("SELECT 1; DROP TABLE orders", "multiple_statements"),
    ("SELECT order_id FROM orders; DELETE FROM orders", "multiple_statements"),
    ("DROP TABLE orders", "not_select"),
    ("DELETE FROM orders WHERE 1 = 1", "not_select"),
    ("UPDATE orders SET status = 'paid'", "not_select"),
    ("INSERT INTO orders (order_id) VALUES ('x')", "not_select"),
    ("REPLACE INTO orders (order_id) VALUES ('x')", "not_select"),
    ("CREATE TABLE t AS SELECT order_id FROM orders", "not_select"),
    ("ALTER TABLE orders ADD COLUMN x TEXT", "not_select"),
    ("ATTACH DATABASE '/tmp/evil.db' AS evil", "not_select"),
    ("PRAGMA table_info(orders)", "not_select"),
    ("VACUUM", "not_select"),
    ("SELECT order_id INTO backup FROM orders", "forbidden_statement"),
    ("SELECT name FROM sqlite_master", "system_table"),
    ("SELECT sql FROM SQLITE_SCHEMA", "system_table"),
    ("SELECT key FROM dataset_meta", "system_table"),
    ("SELECT order_id FROM main.sqlite_master", "schema_qualified"),
    ("SELECT name FROM pragma_table_info('orders')", "table_function"),
    ("SELECT value FROM json_each('[1,2]')", "table_function"),
    ("SELECT load_extension('/tmp/evil.so')", "function_not_allowed"),
    ("SELECT readfile('/etc/passwd')", "function_not_allowed"),
    ("SELECT randomblob(1000000000)", "function_not_allowed"),
    ("SELECT zeroblob(1000000000)", "function_not_allowed"),
    ("SELECT sqlite_version()", "function_not_allowed"),
    ("SELECT char(68, 82, 79, 80)", "function_not_allowed"),
    ("SELECT phone FROM customers", "blocked_column"),
    ("SELECT c.phone FROM customers AS c", "blocked_column"),
    ("SELECT customer_id FROM customers WHERE phone LIKE '100%'", "blocked_column"),
    ("SELECT customer_id FROM customers ORDER BY phone", "blocked_column"),
    ("SELECT product_id, unit_cost FROM products", "blocked_column"),
    ("WITH orders AS (SELECT order_id FROM regions) SELECT order_id FROM orders", "cte_shadows_table"),
    ("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r", "recursive_cte"),
    ("SELECT order_id FROM orders UNION SELECT name FROM sqlite_master", "system_table"),
    ("SELECT order_id FROM orders WHERE order_id IN (SELECT tbl_name FROM sqlite_master)", "system_table"),
]

# recoverable: handed back to the model for self-correction
RECOVERABLE = [
    ("SELEC order_id FROM orders", "parse_error"),
    ("SELECT order_id FROM orders WHERE", "parse_error"),
    ("SELECT * FROM orders", "select_star"),
    ("SELECT o.* FROM orders AS o", "select_star"),
    ("SELECT order_id FROM sales", "unknown_table"),
    ("SELECT order_id FROM public.orders", "schema_qualified"),
    ("SELECT a.order_id FROM orders a, orders b", "cartesian_join"),
    ("SELECT o.order_id FROM orders o CROSS JOIN order_items i", "cartesian_join"),
    ("SELECT o.order_id FROM orders o JOIN customers c", "cartesian_join"),
    ("SELECT o.order_id FROM orders o JOIN customers c ON 1 = 1", "cartesian_join"),
    ("SELECT o.order_id FROM orders o NATURAL JOIN customers c", "cartesian_join"),
    ("SELECT DATE_TRUNC('month', order_date) FROM orders", "function_not_allowed"),
    ("SELECT order_id FROM orders LIMIT (SELECT 5)", "limit_not_literal"),
]


@pytest.mark.parametrize("sql,code", SECURITY)
def test_security_violations_fail_closed(guard, sql, code):
    result = guard.check(sql)
    assert not result.ok
    assert code in {v.code for v in result.violations}, result.violations
    assert result.security_violation


@pytest.mark.parametrize("sql,code", RECOVERABLE)
def test_recoverable_errors_go_back_to_the_model(guard, sql, code):
    result = guard.check(sql)
    assert not result.ok
    assert code in {v.code for v in result.violations}, result.violations
    assert not result.security_violation


@pytest.mark.parametrize("sql", [
    "SELECT COUNT(*) FROM orders",
    "SELECT r.region_name, ROUND(SUM(o.pay_amount), 2) AS gmv FROM orders AS o "
    "JOIN regions AS r ON o.region_id = r.region_id WHERE o.status IN ('paid', 'refunded') GROUP BY r.region_name",
    "WITH m AS (SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id) SELECT COUNT(*) FROM m WHERE n >= 2",
    "SELECT order_id FROM orders WHERE EXISTS (SELECT 1 FROM order_items AS oi WHERE oi.order_id = orders.order_id)",
    "SELECT SUBSTR(order_date, 1, 7) AS m, STRFTIME('%Y', order_date), IIF(status = 'paid', 1, 0) FROM orders",
    "SELECT order_id, ROW_NUMBER() OVER (PARTITION BY region_id ORDER BY pay_amount DESC) AS rk FROM orders",
    "SELECT region_id FROM orders UNION ALL SELECT region_id FROM stores",
    "SELECT o.order_id FROM orders AS o LEFT JOIN customers AS c USING (customer_id)",
])
def test_legitimate_analytics_sql_passes(guard, sql):
    result = guard.check(sql)
    assert result.ok, result.violations


def test_missing_limit_is_added(guard):
    result = guard.check("SELECT order_id FROM orders")
    assert result.ok and result.sql.rstrip().endswith("LIMIT 1000")
    assert any("LIMIT" in n for n in result.notes)


def test_large_limit_is_clamped(guard):
    result = guard.check("SELECT order_id FROM orders LIMIT 50000")
    assert result.ok and "LIMIT 1000" in result.sql and "50000" not in result.sql


def test_comments_do_not_survive_normalisation(guard):
    result = guard.check("SELECT order_id FROM orders /* ; DROP TABLE orders */ -- trailing\nLIMIT 5")
    assert result.ok
    assert "DROP" not in result.sql and "/*" not in result.sql and "--" not in result.sql


def test_string_literals_are_data_not_code(guard):
    result = guard.check("SELECT order_id FROM orders WHERE channel = '; DROP TABLE orders; --'")
    assert result.ok and result.tables == ["orders"]


def test_table_name_case_and_quoting_are_normalised(guard):
    for sql in ('SELECT order_id FROM ORDERS', 'SELECT order_id FROM "Orders"', "SELECT order_id FROM [orders]"):
        result = guard.check(sql)
        assert result.ok and result.tables == ["orders"], sql


def test_too_long_and_too_many_joins(guard):
    assert guard.check("SELECT 1 FROM orders WHERE " + " OR ".join(["1 = 1"] * 2000)).violations[0].code == "too_long"
    joins = " ".join(f"JOIN regions r{i} ON r{i}.region_id = o.region_id" for i in range(7))
    result = guard.check(f"SELECT o.order_id FROM orders o {joins}")
    assert "too_many_joins" in {v.code for v in result.violations}
