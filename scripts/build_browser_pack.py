"""Build what the browser engine needs, from the backend's own definitions.

    cd backend
    python -m app.warehouse.generate
    python ../scripts/build_browser_pack.py            # writes the three outputs below
    python ../scripts/build_browser_pack.py --check    # fails if pack.json is out of date

Outputs:
    frontend/src/engine/pack.json                      committed. Semantic layer, access rules, planner regexes.
                                                       The browser ports logic only, never a second copy of the data.
    frontend/public/engine/warehouse.sqlite.gz         not committed. The same SYNTHETIC warehouse without the phone column.
    frontend/public/engine/warehouse.json              not committed. Sizes, hashes and the source fingerprint.
    frontend/tests/fixtures/parity.json                not committed. What the Python pipeline answers, for the port to match.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.agent import planner as P  # noqa: E402
from app.agent.pipeline import AskInput, collect  # noqa: E402
from app.agent.verifier import ResultTable, verify_answer  # noqa: E402
from app.config import Settings  # noqa: E402
from app.evals.runner import load_cases  # noqa: E402
from app.semantic.plan import REFUSAL_TEXT  # noqa: E402
from app.services import Services  # noqa: E402
from app.sqlsafe import executor as X  # noqa: E402
from app.sqlsafe import guard as G  # noqa: E402

PACK = ROOT / "frontend" / "src" / "engine" / "pack.json"
PUBLIC = ROOT / "frontend" / "public" / "engine"
FIXTURES = ROOT / "frontend" / "tests" / "fixtures"

PATTERNS = ("WRITE_RE", "SENSITIVE_RE", "EXPORT_RE", "FORECAST_RE", "INJECTION_RE", "HELP_RE", "UNKNOWN_METRIC_RE",
            "DATA_WORDS_RE", "FOLLOWUP_RE", "MOM_RE", "YOY_RE", "TREND_RE", "TOPN_RE", "BOTTOMN_RE", "SUPER_DESC_RE",
            "SUPER_ASC_RE", "SINGULAR_RE", "PLURAL_RE", "RANK_DESC_RE", "RANK_ASC_RE")

# Questions that reach narrator and time branches the eval set does not, for the port to match.
EXTRA_QUESTIONS: list[tuple[str, str]] = [
    ("leon", "2025年第三季度各渠道的净销售额"), ("leon", "去年各区域的订单数"), ("leon", "今年上半年华南的退款金额"),
    ("leon", "近 30 天每天的订单数"), ("leon", "上上个月各品类的销量"), ("leon", "2026年8月华东和华南的GMV"),
    ("leon", "上个月各区域各渠道的GMV"), ("leon", "上个月各区域 GMV 环比"), ("leon", "上个月GMV同比"),
    ("leon", "上个月退款率环比"), ("leon", "双十一的GMV"), ("leon", "618各渠道的成交额"), ("leon", "上周的订单数"),
    ("leon", "2026-09-01到2026-09-15的GMV"), ("leon", "2026年9月15日的订单数"), ("leon", "8月的客单价"),
    ("leon", "11月的笔单价"), ("leon", "上个月销量最低的 3 个商品"), ("leon", "上个月GMV最低的门店"),
    ("leon", "上个月各年龄段的复购率"), ("leon", "上个月各会员等级的客单价"), ("leon", "上个月Jack Digital品牌的销量"),
    ("leon", "2023年的GMV"), ("leon", "明年GMV能到多少"), ("leon", "导出所有订单的明细"), ("leon", "下载全部明细"),
    ("leon", "把订单状态改成已退款"), ("leon", "所有会员的手机号"), ("leon", "上个月的净利润"), ("leon", "今天天气怎么样"),
    ("leon", "你能做什么"), ("leon", "上个月各品类的复购率"), ("leon", "上个月营收怎么样"), ("leon", "平均消费是多少"),
    ("leon", "上个月退款情况"), ("leon", "近两个月每月的GMV和订单数"), ("leon", "上个月的毛利额和毛利率"),
    ("leon", "最近一年GMV走势"), ("jack", "上个月各品类的毛利额"), ("mia", "上个月各城市的GMV"), ("mia", "上个月北京的订单数"),
    ("mia", "上个月的毛利率"), ("mia", "上个月杭州西湖店的GMV"), ("emma", "上个月各门店的退款率"),
    ("noah", "上个月各区域的GMV"), ("noah", "上个月上海的订单数"), ("noah", "上个月杭州的订单数"), ("noah", "今年每月的客单价"), ("noah", "上个月华东的GMV"),
    ("leon", "上个月GMV前3的区域同比"), ("leon", "上个月退款率最高的门店环比"), ("leon", "今年以来各月份的GMV排名"),
]


def js_regex(compiled: re.Pattern) -> dict[str, str]:
    return {"source": compiled.pattern, "flags": "i" if compiled.flags & re.IGNORECASE else ""}


def build_pack(s: Services) -> dict:
    layer, access, lk = s.layer, s.access, s.lookups
    cal = layer.calendar
    return {
        "calendar": {"today": cal.today.isoformat(), "data_start": cal.data_start.isoformat(),
                     "data_end": cal.data_end.isoformat(), "date_column": cal.date_column,
                     "default_range_days": cal.default_range_days, "default_trend_months": cal.default_trend_months},
        "tables": {t.name: {"alias": t.alias, "label": t.label,
                            "columns": {c.name: {"label": c.label, "sensitive": c.sensitive, "requires": c.requires}
                                        for c in t.columns.values()}} for t in layer.tables.values()},
        "joins": [{"from": j.from_table, "to": j.to_table, "on": j.on} for j in layer.joins],
        "dimensions": {d.key: {"label": d.label, "expr": d.expr, "table": d.table, "synonyms": d.synonyms,
                               "values": d.values, "value_synonyms": d.value_synonyms, "grain": d.grain,
                               "is_time": d.is_time} for d in layer.dimensions.values()},
        "metrics": {m.key: {"label": m.label, "description": m.description, "filter": m.filter, "format": m.format,
                            "type": m.type, "unit": m.unit, "components": m.components, "synonyms": m.synonyms,
                            "grain": m.grain, "requires": m.requires,
                            "expr": {"order": layer.metric_expr(m.key, False), "item": layer.metric_expr(m.key, True)},
                            "allowed_dimensions": layer.allowed_dimensions(m.key)} for m in layer.metrics.values()},
        "components": {c.key: {"label": c.label, "format": c.format, "unit": c.unit,
                               "expr": {"order": layer.metric_expr(c.key, False), "item": layer.metric_expr(c.key, True)}}
                       for c in layer.components.values()},
        "ambiguous": layer.ambiguous,
        "users": [{"username": u.username, "name": u.name, "title": u.title, "role": u.role, "scope_type": u.scope_type,
                   "regions": list(u.regions), "stores": list(u.stores), "permissions": sorted(u.permissions)}
                  for u in access.users.values()],
        "row_policies": access.row_policies,
        "lookups": {"region_codes": lk.region_codes, "store_codes": lk.store_codes, "store_region": lk.store_region,
                    "store_city": lk.store_city, "city_regions": {k: sorted(v) for k, v in lk.city_regions.items()}},
        "patterns": {name: js_regex(getattr(P, name)) for name in PATTERNS},
        "group_prefixes": list(P.GROUP_PREFIXES),
        "group_suffixes": list(P.GROUP_SUFFIXES),
        "guard": {"allowed_functions": sorted(X.AUTH_ALLOWED_FUNCTIONS | {"cast", "exists", "if"}),
                  "dangerous_functions": sorted(G.DANGEROUS_FUNCTIONS),
                  "authorizer_functions": sorted(X.AUTH_ALLOWED_FUNCTIONS),
                  "system_prefixes": list(G.SYSTEM_TABLE_PREFIXES), "internal_tables": sorted(G.INTERNAL_TABLES)},
        "limits": {"max_rows": s.settings.max_rows, "timeout_ms": s.settings.query_timeout_ms,
                   "max_joins": s.settings.max_joins, "max_sql_chars": s.settings.max_sql_chars},
        "refusal_text": REFUSAL_TEXT,
        "products": [r[0] for r in s.warehouse.trusted_rows("SELECT product_name FROM products ORDER BY product_id")],
        "dataset": {k: s.dataset[k] for k in ("name", "fingerprint", "total_rows")},
    }


def build_warehouse(source: Path, out_dir: Path, fingerprint: str) -> dict:
    """Same rows as the warehouse, minus the sensitive column and the secondary indexes.
    WITHOUT ROWID keeps the primary keys in the table itself, which saves about 300 KB once compressed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(source)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.sqlite"
        dst = sqlite3.connect(path)
        for table in ("regions", "stores", "customers", "products", "orders", "order_items"):
            sql = src.execute("SELECT sql FROM sqlite_master WHERE name = ?", (table,)).fetchone()[0]
            sql = re.sub(r",\s*phone\s+TEXT NOT NULL", "", sql)
            sql = re.sub(r"\s*REFERENCES \w+\(\w+\)", "", sql)
            if table != "order_items":  # INTEGER PRIMARY KEY is already the rowid
                sql += " WITHOUT ROWID"
            dst.execute(sql)
            cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})") if r[1] != "phone"]
            rows = src.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY 1")
            dst.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' * len(cols))})", rows)
        dst.commit()
        assert "phone" not in [r[1] for r in dst.execute("PRAGMA table_info(customers)")]
        dst.execute("VACUUM")
        dst.close()
        raw = path.read_bytes()
    packed = gzip.compress(raw, 9, mtime=0)
    (out_dir / "warehouse.sqlite.gz").write_bytes(packed)
    meta = {"source_fingerprint": fingerprint, "sqlite_bytes": len(raw), "gzip_bytes": len(packed),
            "sqlite_sha256": hashlib.sha256(raw).hexdigest(), "columns_removed": ["customers.phone"]}
    (out_dir / "warehouse.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


def outcome(s: Services, username: str, question: str, context_q: str | None, choices: dict, fault: str | None = None) -> dict:
    user = s.access.users[username]
    context = None
    if context_q:
        ctx, _ = collect(s.pipeline.run(AskInput(context_q, user)))
        context = ctx.plan
    record, _ = collect(s.pipeline.run(AskInput(question, user, context, dict(choices), fault)))
    by_id = {a.id: a for a in record.attempts}
    finals = [by_id[i] for i in record.final_attempts]
    answer = record.answer or {}
    verification = None
    if fault is None and record.answer:
        verification = answer["verification"]
    if fault == "number_hallucination" and record.answer:
        tables = [ResultTable(a.id, a.columns, a.rows, {m["key"]: m["label"] for m in a.column_meta}) for a in finals]
        verification = verify_answer(answer["text"], tables).to_dict()
    return {"user": username, "question": question, "context": context_q, "clarifications": choices, "fault": fault,
            "status": record.status, "refusal": record.refusal, "clarification": record.clarification,
            "plan": record.plan, "plan_view": record.plan_view,
            "queries": [{"sql": a.sql_generated, "columns": a.columns, "rows": a.rows, "meta": a.column_meta,
                         "policies": a.policies, "title": a.title, "key": a.key} for a in finals],
            "answer": answer.get("text"), "verification": verification, "charts": answer.get("charts")}


def build_parity(s: Services) -> dict:
    sys.path.insert(0, str(ROOT / "backend" / "tests"))
    sys.path.insert(0, str(ROOT / "scripts"))
    import test_sql_guard as T  # noqa: PLC0415
    from record_demo import ASKS  # noqa: PLC0415

    seen, cases = set(), []

    def add(*key) -> None:
        marker = json.dumps(key, ensure_ascii=False, sort_keys=True)
        if marker not in seen:
            seen.add(marker)
            cases.append(outcome(s, *key))

    for case in load_cases(ROOT / "backend" / "evals" / "cases.yaml"):
        if case.fault is None:
            add(case.user, case.question, case.context, dict(case.clarifications))
    for username, asks in ASKS.items():
        for question, _tag, fault in asks:
            if fault is None:
                add(username, question, None, {})
    for username, question in EXTRA_QUESTIONS:
        add(username, question, None, {})
    for question in ("上个月华东区的 GMV", "上个月的 GMV 是多少？", "上个月各区域的GMV"):
        add("leon", question, None, {}, "number_hallucination")

    guard = G.SqlGuard(set(s.layer.tables), s.layer.blocked_columns(frozenset()), s.settings.max_rows,
                       s.settings.max_joins, s.settings.max_sql_chars)
    attacks = []
    for sql, code in T.SECURITY + T.RECOVERABLE:
        result = guard.check(sql)
        attacks.append({"sql": sql, "ok": result.ok, "security": result.security_violation, "code": code})
    legit = [{"sql": sql, "ok": guard.check(sql).ok} for sql in T.LEGITIMATE]
    return {"cases": cases, "attacks": attacks, "legitimate": legit}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if pack.json differs from the backend definitions")
    args = parser.parse_args()
    settings = Settings.from_env()
    with tempfile.TemporaryDirectory() as tmp:
        settings.database_url = f"sqlite:///{Path(tmp) / 'unused.db'}"
        s = Services(settings)
        pack_text = json.dumps(build_pack(s), ensure_ascii=False, indent=None, separators=(",", ":")) + "\n"
        if args.check:
            if not PACK.exists() or PACK.read_text(encoding="utf-8") != pack_text:
                print("pack.json is out of date: run python ../scripts/build_browser_pack.py", file=sys.stderr)
                return 1
            print("pack.json is current")
            return 0
        PACK.parent.mkdir(parents=True, exist_ok=True)
        PACK.write_text(pack_text, encoding="utf-8")
        meta = build_warehouse(Path(settings.warehouse_path), PUBLIC, s.dataset["fingerprint"])
        FIXTURES.mkdir(parents=True, exist_ok=True)
        parity = build_parity(s)
        (FIXTURES / "parity.json").write_text(json.dumps(parity, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"pack {len(pack_text.encode()):,} bytes; warehouse {meta['sqlite_bytes']:,} raw, {meta['gzip_bytes']:,} gz; "
              f"parity {len(parity['cases'])} questions, {len(parity['attacks'])} attacks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
