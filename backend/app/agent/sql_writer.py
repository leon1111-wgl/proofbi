"""SQL writers: the template writer (offline, compiles the semantic layer) and fault injection.

Faults reproduce, deterministically, the mistakes real models make, so the self-correction
loop, the 口径 lint, the guard and the number verifier can be demonstrated and tested
without an API key. They only affect the first attempt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta

from ..semantic.compiler import QuerySpec, compile_spec
from ..semantic.layer import SemanticLayer

FAULTS = {
    "sql_error": "第一次生成的 SQL 引用了不存在的字段（模拟模型幻觉出列名）",
    "caliber_drift": "第一次生成的 SQL 漏掉了订单状态过滤（模拟口径偏差：把已取消订单算进 GMV）",
    "wrong_period": "第一次生成的 SQL 把月末少算一天（模拟时间边界错误）",
    "unsafe_sql": "第一次生成的 SQL 试图读取客户手机号（模拟被注入的模型）",
    "number_hallucination": "回答里的第一个数字被改错（模拟模型编造数字）",
}


@dataclass
class WriteResult:
    sql: str
    note: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0


class TemplateSQLWriter:
    name = "template"

    def __init__(self, layer: SemanticLayer, max_rows: int):
        self.layer = layer
        self.max_rows = max_rows

    def write(self, spec: QuerySpec, attempt: int, feedback: list[str], previous_sql: str | None, *,
              fault: str | None = None, allowed_columns: dict[str, set[str]] | None = None) -> WriteResult:
        sql = compile_spec(spec, self.layer, self.max_rows)
        if attempt == 0 and fault:
            broken = inject_fault(sql, spec, self.layer, fault)
            if broken != sql:
                return WriteResult(broken, note=FAULTS.get(fault))
        return WriteResult(sql)


def inject_fault(sql: str, spec: QuerySpec, layer: SemanticLayer, fault: str) -> str:
    if fault == "sql_error":
        for good, bad in (("o.pay_amount", "o.amount"), ("oi.pay_amount", "oi.amount"), ("o.order_id", "o.id"),
                          ("oi.quantity", "oi.qty")):
            if good in sql:
                return sql.replace(good, bad, 1)
    if fault == "caliber_drift":
        metric_filter = layer.metrics[spec.metrics[0]].filter
        return re.sub(re.escape(metric_filter) + r"\s+AND\s+", "", sql, count=1)
    if fault == "wrong_period":
        end = spec.time.end.isoformat()
        return sql.replace(f"'{end}'", f"'{(spec.time.end - timedelta(days=1)).isoformat()}'", 1)
    if fault == "unsafe_sql":
        return "SELECT c.phone, COUNT(*) AS orders FROM customers AS c JOIN orders AS o ON o.customer_id = c.customer_id GROUP BY c.phone LIMIT 100"
    return sql
