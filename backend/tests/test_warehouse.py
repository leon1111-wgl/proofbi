"""The synthetic warehouse is reproducible and internally consistent."""

import sqlite3

import pytest

from app.warehouse.generate import fingerprint, generate, read_meta


def q(path, sql):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def test_same_seed_same_fingerprint(warehouse_path, tmp_path):
    again = generate(tmp_path / "again.db")
    assert again["fingerprint"] == read_meta(warehouse_path)["fingerprint"]
    conn = sqlite3.connect(tmp_path / "again.db")
    try:
        assert fingerprint(conn) == again["fingerprint"]
    finally:
        conn.close()


def test_size_is_about_100k_rows(warehouse_path):
    meta = read_meta(warehouse_path)
    assert meta["synthetic"] is True
    assert 90_000 <= meta["total_rows"] <= 130_000
    assert meta["date_start"] == "2024-10-01" and meta["date_end"] == "2026-09-30"


def test_line_payments_add_up_to_order_payment(warehouse_path):
    rows = q(warehouse_path, """
        SELECT COUNT(*) FROM orders o
        JOIN (SELECT order_id, ROUND(SUM(pay_amount), 2) AS s FROM order_items GROUP BY order_id) i
          ON i.order_id = o.order_id
        WHERE ABS(i.s - o.pay_amount) > 0.001""")
    assert rows[0][0] == 0


def test_refunds_and_statuses(warehouse_path):
    assert q(warehouse_path, "SELECT COUNT(*) FROM orders WHERE status = 'refunded' AND refund_amount <> pay_amount")[0][0] == 0
    assert q(warehouse_path, "SELECT COUNT(*) FROM orders WHERE status <> 'refunded' AND refund_amount <> 0")[0][0] == 0
    statuses = {r[0] for r in q(warehouse_path, "SELECT DISTINCT status FROM orders")}
    assert statuses == {"paid", "refunded", "cancelled"}


def test_no_orders_before_a_store_opens(warehouse_path):
    rows = q(warehouse_path, """
        SELECT COUNT(*) FROM orders o JOIN stores s ON o.store_id = s.store_id
        WHERE o.order_date < s.opened_date""")
    assert rows[0][0] == 0


def test_order_region_matches_store_region(warehouse_path):
    rows = q(warehouse_path, """
        SELECT COUNT(*) FROM orders o JOIN stores s ON o.store_id = s.store_id WHERE o.region_id <> s.region_id""")
    assert rows[0][0] == 0


def test_phone_numbers_are_obviously_fake(warehouse_path):
    rows = q(warehouse_path, "SELECT COUNT(*) FROM customers WHERE phone NOT LIKE '100%'")
    assert rows[0][0] == 0


def test_read_only_connection_cannot_write(warehouse_path):
    conn = sqlite3.connect(f"file:{warehouse_path}?mode=ro", uri=True)
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM orders")
    finally:
        conn.close()
