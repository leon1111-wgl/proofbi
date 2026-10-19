"""Static SQL validation on the sqlglot AST (first line of defence).

Rules: exactly one statement; a SELECT (or UNION of SELECTs) and nothing else; only
whitelisted tables, no schema prefixes, no system tables, no table functions; explicit
columns (``COUNT(*)`` is fine, ``SELECT *`` is not); no sensitive or unpermitted
columns; whitelisted functions only; every JOIN needs a column = column condition; no
recursive CTEs; LIMIT is a literal and at most ``max_rows`` (added when missing).

The SQL that is finally executed is regenerated from the validated AST, never the raw
string the model produced, so comments and formatting tricks do not survive.

Each violation is either a *security* violation (fail closed, no retry: stacked
statements, writes, system tables, sensitive columns, dangerous functions) or a
*recoverable* one that is handed back to the model for self-correction (syntax errors,
unknown tables or functions, SELECT *, a JOIN without condition).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError

logging.getLogger("sqlglot").setLevel(logging.ERROR)  # "falling back to Command" warnings

FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = tuple(
    getattr(exp, name) for name in (
        "Insert", "Update", "Delete", "Drop", "Create", "Alter", "Command", "Pragma", "Attach", "Detach",
        "Transaction", "Commit", "Rollback", "Merge", "Into", "Set", "Use", "Copy", "LoadData", "Grant",
        "TruncateTable", "Analyze", "Describe", "Cache", "Uncache", "Refresh",
    ) if hasattr(exp, name)
)

# typed sqlglot functions (sql_name) that may appear in analytics SQL
ALLOWED_FUNCTIONS = {
    "SUM", "COUNT", "AVG", "MIN", "MAX", "ROUND", "COALESCE", "NULLIF", "CAST", "SUBSTRING", "ABS", "LOWER",
    "UPPER", "LENGTH", "IF", "CASE", "DATE", "TIME_TO_STR", "TS_OR_DS_TO_TIMESTAMP", "ROW_NUMBER", "RANK",
    "DENSE_RANK", "LAG", "LEAD", "TRIM", "REPLACE", "STR_POSITION", "EXISTS", "GROUP_CONCAT", "STR_TO_TIME",
}
# functions sqlglot does not model (exp.Anonymous), by lower-case name
ALLOWED_ANONYMOUS = {"total", "julianday", "ifnull", "iif", "instr", "substr", "strftime"}
# names that are never a modelling mistake: reading files, loading code, probing the engine, DoS
DANGEROUS_FUNCTIONS = {
    "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "zeroblob", "randomblob",
    "sqlite_version", "sqlite_source_id", "sqlite_compileoption_used", "sqlite_compileoption_get",
    "sqlite_offset", "changes", "last_insert_rowid", "total_changes", "char", "chr", "printf", "format",
    "hex", "unhex", "quote", "random", "rand", "current_version", "likelihood", "unlikely", "likely",
}
SYSTEM_TABLE_PREFIXES = ("sqlite_", "pragma_")
INTERNAL_TABLES = {"dataset_meta"}


@dataclass
class Violation:
    code: str
    message: str
    security: bool

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "security": self.security}


@dataclass
class GuardResult:
    ok: bool
    sql: str | None = None
    tree: exp.Expression | None = None
    violations: list[Violation] = field(default_factory=list)
    tables: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def security_violation(self) -> bool:
        return any(v.security for v in self.violations)

    def error_text(self) -> str:
        return "；".join(v.message for v in self.violations)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "violations": [v.to_dict() for v in self.violations], "tables": self.tables,
                "notes": self.notes}


def _function_name(node: exp.Func) -> tuple[str, bool]:
    """(name, typed). Typed names are sqlglot's upper-case sql_name; anonymous are lower-case."""
    if isinstance(node, exp.Anonymous):
        return str(node.name).lower(), False
    return node.sql_name().upper(), True


def _has_column_equality(condition: exp.Expression) -> bool:
    for eq in condition.find_all(exp.EQ):
        if isinstance(eq.left, exp.Column) and isinstance(eq.right, exp.Column):
            return True
    return False


class SqlGuard:
    def __init__(self, allowed_tables: set[str], blocked_columns: dict[str, str], max_rows: int = 1000,
                 max_joins: int = 6, max_chars: int = 6000):
        self.allowed_tables = {t.lower() for t in allowed_tables}
        self.blocked_columns = {k.lower(): v for k, v in blocked_columns.items()}
        self.max_rows = max_rows
        self.max_joins = max_joins
        self.max_chars = max_chars

    def check(self, sql: str) -> GuardResult:
        if not sql or not sql.strip():
            return GuardResult(False, violations=[Violation("empty", "没有生成 SQL", False)])
        if len(sql) > self.max_chars:
            return GuardResult(False, violations=[Violation("too_long", f"SQL 超过 {self.max_chars} 个字符", False)])
        try:
            statements = [s for s in sqlglot.parse(sql, read="sqlite") if s is not None]
        except (ParseError, TokenError) as exc:
            message = str(exc).splitlines()[0][:200]
            return GuardResult(False, violations=[Violation("parse_error", f"SQL 语法错误：{message}", False)])
        if len(statements) != 1:
            return GuardResult(False, violations=[
                Violation("multiple_statements", f"只允许一条语句，检测到 {len(statements)} 条", True)])
        root = statements[0]
        if not isinstance(root, (exp.Select, exp.SetOperation)):
            return GuardResult(False, violations=[
                Violation("not_select", f"只允许 SELECT 查询，检测到 {type(root).__name__.upper()}", True)])

        violations: list[Violation] = []
        notes: list[str] = []
        cte_names = {cte.alias_or_name.lower() for cte in root.find_all(exp.CTE)}
        tables: set[str] = set()
        joins = 0

        def add(code: str, message: str, security: bool) -> None:
            if not any(v.code == code and v.message == message for v in violations):
                violations.append(Violation(code, message, security))

        for node in root.walk():
            if isinstance(node, FORBIDDEN_NODES):
                add("forbidden_statement", f"不允许 {type(node).__name__.upper()}", True)
            elif isinstance(node, exp.With) and node.args.get("recursive"):
                add("recursive_cte", "不允许递归 CTE（WITH RECURSIVE）", True)
            elif isinstance(node, exp.CTE):
                name = node.alias_or_name.lower()
                if name in self.allowed_tables or name.startswith(SYSTEM_TABLE_PREFIXES) or name in INTERNAL_TABLES:
                    add("cte_shadows_table", f"CTE 名称 {name} 与数据表重名", True)
            elif isinstance(node, exp.Table):
                self._check_table(node, cte_names, tables, add)
            elif isinstance(node, exp.Func) and not isinstance(node, exp.Connector):  # AND / OR are Funcs too
                name, typed = _function_name(node)
                allowed = name in ALLOWED_FUNCTIONS if typed else name in ALLOWED_ANONYMOUS
                if not allowed:
                    dangerous = name.lower() in DANGEROUS_FUNCTIONS
                    add("function_not_allowed", f"函数 {name.lower()}() 不在白名单中", dangerous)
            elif isinstance(node, exp.Column):
                if isinstance(node.this, exp.Star):
                    add("select_star", "请显式列出字段，不要使用 t.*", False)
                else:
                    reason = self.blocked_columns.get(node.name.lower())
                    if reason:
                        add("blocked_column", reason, True)
            elif isinstance(node, exp.Star):
                if not isinstance(node.parent, exp.Count):
                    add("select_star", "请显式列出字段，不要使用 SELECT *", False)
            elif isinstance(node, exp.Join):
                joins += 1
                kind = (node.args.get("kind") or "").upper()
                on = node.args.get("on")
                using = node.args.get("using")
                if kind == "CROSS" or node.args.get("method"):
                    add("cartesian_join", "不允许 CROSS JOIN、逗号连接或 NATURAL JOIN，请写明关联条件", False)
                elif not using and (on is None or not _has_column_equality(on)):
                    add("cartesian_join", "JOIN 缺少“字段 = 字段”的关联条件", False)
        if joins > self.max_joins:
            add("too_many_joins", f"JOIN 数量 {joins} 超过上限 {self.max_joins}", False)
        if root.args.get("into"):
            add("forbidden_statement", "不允许 SELECT ... INTO", True)

        limit = root.args.get("limit")
        if limit is not None:
            value = limit.args.get("expression")
            if not (isinstance(value, exp.Literal) and value.is_int):
                add("limit_not_literal", "LIMIT 必须是整数常量", False)
            elif int(value.this) > self.max_rows:
                notes.append(f"LIMIT {value.this} 超过上限，已收紧为 {self.max_rows}")
                root.set("limit", exp.Limit(expression=exp.Literal.number(self.max_rows)))
        else:
            notes.append(f"未写 LIMIT，已自动加上 LIMIT {self.max_rows}")
            root.set("limit", exp.Limit(expression=exp.Literal.number(self.max_rows)))
        offset = root.args.get("offset")
        if offset is not None:
            value = offset.args.get("expression")
            if not (isinstance(value, exp.Literal) and value.is_int):
                add("limit_not_literal", "OFFSET 必须是整数常量", False)

        if violations:
            return GuardResult(False, violations=violations, tables=sorted(tables), notes=notes)

        normalized = root.sql(dialect="sqlite", pretty=True, comments=False)
        # Re-parse what we will execute: it must still be one plain SELECT.
        reparsed = [s for s in sqlglot.parse(normalized, read="sqlite") if s is not None]
        if len(reparsed) != 1 or not isinstance(reparsed[0], (exp.Select, exp.SetOperation)):
            return GuardResult(False, violations=[Violation("roundtrip", "SQL 规范化后结构发生变化", True)])
        return GuardResult(True, sql=normalized, tree=reparsed[0], tables=sorted(tables), notes=notes)

    def _check_table(self, node: exp.Table, cte_names: set[str], tables: set[str], add) -> None:
        if not isinstance(node.this, exp.Identifier):
            add("table_function", f"不允许表函数 {node.this.sql()}", True)
            return
        name = node.name.lower()
        if node.args.get("db") or node.args.get("catalog"):
            security = node.text("db").lower().startswith(SYSTEM_TABLE_PREFIXES) or name.startswith(SYSTEM_TABLE_PREFIXES)
            add("schema_qualified", f"不要使用库名前缀：{node.sql()}", security)
            return
        if name in cte_names:
            return
        if name.startswith(SYSTEM_TABLE_PREFIXES) or name in INTERNAL_TABLES:
            add("system_table", f"不允许访问系统表 {name}", True)
        elif name not in self.allowed_tables:
            add("unknown_table", f"表 {name} 不存在或不在白名单中，可用表：{', '.join(sorted(self.allowed_tables))}",
                False)
        else:
            tables.add(name)
