"""Row-level security by query rewriting (second line of defence).

Every reference to a physical table — in FROM, JOIN, subqueries, CTE bodies, EXISTS,
UNION branches — is replaced by a policy view:

    orders AS o   ->   (SELECT <allowed columns> FROM orders WHERE region_id IN ('east')) AS o

so the model's SQL can say whatever it likes about regions: the rows it can see are
already filtered, and sensitive columns do not exist in its scope. The filter comes from
the logged-in user's profile, not from the prompt, so prompt injection cannot widen it.
Admins get the same projection without a WHERE (sensitive columns stay out for everyone).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlglot import exp

from ..semantic.access import AccessConfig, User


@dataclass
class RewriteResult:
    tree: exp.Expression
    sql: str
    policies: dict[str, str | None] = field(default_factory=dict)  # table -> predicate SQL (None = all rows)

    @property
    def restricted(self) -> bool:
        return any(p is not None for p in self.policies.values())


def apply_row_policies(tree: exp.Expression, user: User, access: AccessConfig,
                       allowed_columns: dict[str, set[str]]) -> RewriteResult:
    tree = tree.copy()
    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    policies: dict[str, str | None] = {}
    # Collect first: the policy views contain table references (orders inside the
    # order_items policy) that are trusted and must not be wrapped again.
    for table in list(tree.find_all(exp.Table)):
        name = table.name.lower()
        if name in cte_names:
            continue
        columns = sorted(allowed_columns.get(name, set()))
        if not columns:
            raise PermissionError(f"没有可读取的 {name} 字段")
        view = exp.select(*[exp.column(c) for c in columns]).from_(exp.table_(name))
        predicate = access.predicate(name, user)
        if predicate is not None:
            view = view.where(predicate)
        alias_node = table.args.get("alias")
        alias = alias_node.this.copy() if alias_node is not None else table.this.copy()
        table.replace(exp.Subquery(this=view, alias=exp.TableAlias(this=alias)))
        policies[name] = predicate.sql(dialect="sqlite") if predicate is not None else None
    return RewriteResult(tree, tree.sql(dialect="sqlite", pretty=True, comments=False), policies)
