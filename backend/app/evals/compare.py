"""Result-set comparison for execution accuracy (EX).

The prediction may return extra columns (a ratio metric also returns its numerator and
denominator), but every gold column must be matched by one predicted column, row by row.
Rows are compared as a multiset unless the gold SQL has an ORDER BY at the top level.
Numbers are equal within display rounding: ±0.00006 for ratios (4 decimals),
±0.006 otherwise (2 decimals).
"""

from __future__ import annotations

from collections import Counter
from itertools import product
from typing import Any

import sqlglot


def gold_is_ordered(sql: str) -> bool:
    tree = sqlglot.parse_one(sql, read="sqlite")
    return tree.args.get("order") is not None


def _close(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        tol = 6e-5 if abs(b) <= 1 else 0.006
        return abs(float(a) - float(b)) <= tol
    return a == b


def _key(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 2) if abs(value) > 1 else round(value, 4)
    return value


def compare_results(pred_rows: list[list[Any]], gold_rows: list[list[Any]], ordered: bool) -> tuple[bool, str]:
    if len(pred_rows) != len(gold_rows):
        return False, f"行数不同：预测 {len(pred_rows)} 行，标准答案 {len(gold_rows)} 行"
    if not gold_rows:
        return True, "两边都为空"
    n_pred, n_gold = len(pred_rows[0]), len(gold_rows[0])
    if n_pred < n_gold:
        return False, f"列数不足：预测 {n_pred} 列，标准答案 {n_gold} 列"

    # candidate predicted columns for each gold column (same values, ignoring row order)
    def column(rows, i):
        return [r[i] for r in rows]

    candidates = []
    for g in range(n_gold):
        gold_col = column(gold_rows, g)
        matches = []
        for p in range(n_pred):
            pred_col = column(pred_rows, p)
            if Counter(map(_key, pred_col)) == Counter(map(_key, gold_col)) or all(
                    _close(a, b) for a, b in zip(sorted(pred_col, key=_sort_key), sorted(gold_col, key=_sort_key))):
                matches.append(p)
        if not matches:
            return False, f"标准答案第 {g + 1} 列在预测结果中找不到对应列"
        candidates.append(matches)

    for mapping in product(*candidates):
        if len(set(mapping)) != len(mapping):
            continue
        projected = [[row[p] for p in mapping] for row in pred_rows]
        if ordered:
            if all(all(_close(a, b) for a, b in zip(pr, gr)) for pr, gr in zip(projected, gold_rows)):
                return True, "一致（按顺序）"
        else:
            remaining = list(gold_rows)
            for pr in projected:
                hit = next((i for i, gr in enumerate(remaining) if all(_close(a, b) for a, b in zip(pr, gr))), None)
                if hit is None:
                    break
                remaining.pop(hit)
            else:
                return True, "一致（不计顺序）"
    return False, "列能对上，但行不一致" + ("（顺序不同）" if ordered else "")


def _sort_key(value: Any) -> tuple:
    if isinstance(value, (int, float)):
        return (0, float(value), "")
    return (1, 0.0, str(value))
