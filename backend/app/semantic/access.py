"""Users, data scopes and row policies (``semantic/access.yaml``).

Row policies are SQL predicates with ``{regions}`` / ``{stores}`` placeholders. They are
expanded with literals built by sqlglot from the user profile, then parsed back into an
AST, so a value can never break out of its quotes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import sqlglot
import yaml
from sqlglot import exp

_SAFE_CODE = re.compile(r"^[A-Za-z0-9_]+$")


@dataclass(frozen=True)
class User:
    username: str
    name: str
    title: str
    role: str
    scope_type: str  # all | region | store
    regions: tuple[str, ...] = ()
    stores: tuple[str, ...] = ()
    permissions: frozenset[str] = field(default_factory=frozenset)

    def has(self, permission: str) -> bool:
        return permission in self.permissions

    @property
    def is_admin(self) -> bool:
        return "admin" in self.permissions

    def public(self, region_names: dict[str, str], store_names: dict[str, str]) -> dict[str, Any]:
        return {
            "username": self.username, "name": self.name, "title": self.title, "role": self.role,
            "permissions": sorted(self.permissions),
            "scope": {"type": self.scope_type, "regions": list(self.regions), "stores": list(self.stores),
                      "label": self.scope_label(region_names, store_names)},
        }

    def scope_label(self, region_names: dict[str, str], store_names: dict[str, str]) -> str:
        if self.scope_type == "all":
            return "全部区域"
        if self.scope_type == "region":
            return "、".join(region_names.get(r, r) for r in self.regions)
        return "、".join(store_names.get(s, s) for s in self.stores)


class AccessConfig:
    def __init__(self, data: dict[str, Any]):
        self.demo_password: str = str(data.get("demo_password", ""))
        self.users: dict[str, User] = {}
        for u in data["users"]:
            scope = u.get("scope") or {"type": "all"}
            user = User(
                username=u["username"], name=u["name"], title=u.get("title", ""), role=u.get("role", "analyst"),
                scope_type=scope["type"], regions=tuple(scope.get("regions") or ()),
                stores=tuple(scope.get("stores") or ()), permissions=frozenset(u.get("permissions") or ()),
            )
            if user.scope_type not in ("all", "region", "store"):
                raise ValueError(f"用户 {user.username} 的数据范围类型 {user.scope_type} 不受支持")
            for code in user.regions + user.stores:
                if not _SAFE_CODE.match(code):
                    raise ValueError(f"用户 {user.username} 的范围编码 {code!r} 不合法")
            self.users[user.username] = user
        self.row_policies: dict[str, dict[str, str]] = data.get("row_policies") or {}

    @classmethod
    def load(cls, path: str | Path) -> "AccessConfig":
        with open(path, encoding="utf-8") as fh:
            return cls(yaml.safe_load(fh))

    def predicate(self, table: str, user: User) -> exp.Expression | None:
        """Row filter for ``table`` as an AST, or None when the user sees every row."""
        if user.scope_type == "all":
            return None
        template = self.row_policies.get(user.scope_type, {}).get(table)
        if template is None:
            return None  # e.g. products: a shared catalogue
        values = {
            "regions": ", ".join(exp.Literal.string(v).sql() for v in user.regions) or "NULL",
            "stores": ", ".join(exp.Literal.string(v).sql() for v in user.stores) or "NULL",
        }
        return sqlglot.parse_one(template.format(**values), read="sqlite")

    def describe(self, user: User) -> dict[str, str]:
        """Human-readable policy per table, for the semantic-layer page."""
        out = {}
        for table in ("orders", "order_items", "customers", "stores", "regions", "products"):
            pred = self.predicate(table, user)
            out[table] = pred.sql(dialect="sqlite") if pred is not None else "全部行"
        return out
