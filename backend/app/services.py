"""Process-wide services: semantic layer, access policies, warehouse, model components.

Built once at startup. A semantic layer whose enumerated values do not exist in the
warehouse stops the startup: a stale definition would silently filter to zero rows.
"""

from __future__ import annotations

from .agent.llm_components import LLMNarrator, LLMPlanner, LLMSQLWriter
from .agent.narrator import TemplateNarrator
from .agent.pipeline import Pipeline
from .agent.planner import Lookups, RulesPlanner
from .agent.sql_writer import TemplateSQLWriter
from .config import Settings
from .llm.openai_compat import OpenAICompatModel
from .semantic.access import AccessConfig
from .semantic.layer import SemanticError, SemanticLayer
from .sqlsafe.executor import Warehouse
from .warehouse.generate import ensure_warehouse

# trusted, fixed lookups (never model SQL)
_VALUE_SQL = {
    "region": "SELECT DISTINCT region_name FROM regions",
    "city": "SELECT DISTINCT city FROM stores",
    "store": "SELECT DISTINCT store_name FROM stores",
    "channel": "SELECT DISTINCT channel FROM orders",
    "category": "SELECT DISTINCT category FROM products",
    "brand": "SELECT DISTINCT brand FROM products",
    "member_level": "SELECT DISTINCT member_level FROM customers",
    "age_band": "SELECT DISTINCT age_band FROM customers",
}


def load_lookups(warehouse: Warehouse) -> Lookups:
    regions = dict(warehouse.trusted_rows("SELECT region_name, region_id FROM regions"))
    stores = warehouse.trusted_rows("SELECT store_name, store_id, region_id, city FROM stores")
    city_regions: dict[str, set[str]] = {}
    for _, _, region, city in stores:
        city_regions.setdefault(city, set()).add(region)
    return Lookups(
        region_codes=regions,
        store_codes={name: sid for name, sid, _, _ in stores},
        store_region={sid: region for _, sid, region, _ in stores},
        store_city={sid: city for _, sid, _, city in stores},
        city_regions=city_regions,
    )


def check_dimension_values(layer: SemanticLayer, warehouse: Warehouse) -> None:
    for key, sql in _VALUE_SQL.items():
        dim = layer.dimensions.get(key)
        if dim is None or not dim.values:
            continue
        actual = {row[0] for row in warehouse.trusted_rows(sql)}
        missing = sorted(set(dim.values) - actual)
        if missing:
            raise SemanticError(f"维度 {key} 声明的取值在数据中不存在：{missing}")


class Services:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.layer = SemanticLayer.load(settings.semantic_path, settings.today)
        self.access = AccessConfig.load(settings.access_path)
        self.dataset = ensure_warehouse(settings.warehouse_path)
        self.warehouse = Warehouse(settings.warehouse_path, settings.query_timeout_ms, settings.max_rows)
        self.lookups = load_lookups(self.warehouse)
        check_dimension_values(self.layer, self.warehouse)

        self.rules_planner = RulesPlanner(self.layer, self.lookups)
        self.template_writer = TemplateSQLWriter(self.layer, settings.max_rows)
        self.template_narrator = TemplateNarrator(self.layer)
        self.model = None
        if settings.uses_llm:
            self.model = OpenAICompatModel(settings.llm_base_url, settings.llm_api_key, settings.llm_model,
                                           settings.llm_timeout)
        self.planner = (LLMPlanner(self.model, self.layer, self.lookups, self.rules_planner)
                        if self.model and settings.planner_mode == "llm" else self.rules_planner)
        self.sql_writer = (LLMSQLWriter(self.model, self.layer, self.template_writer)
                           if self.model and settings.sql_writer_mode == "llm" else self.template_writer)
        self.narrator = (LLMNarrator(self.model, self.layer, self.template_narrator)
                         if self.model else self.template_narrator)
        self.pipeline = Pipeline(self)

    def usage_totals(self) -> dict[str, int]:
        totals = {"prompt_tokens": 0, "completion_tokens": 0, "calls": 0, "fallbacks": 0}
        for component in (self.planner, self.sql_writer, self.narrator):
            usage = getattr(component, "usage", None)
            if usage is not None:
                for key in totals:
                    totals[key] += getattr(usage, key)
        return totals

    def region_names(self) -> dict[str, str]:
        return self.lookups.region_names

    def store_names(self) -> dict[str, str]:
        return self.lookups.store_names


_services: Services | None = None


def get_services() -> Services:
    if _services is None:
        raise RuntimeError("services not initialised; call set_services() in the app factory")
    return _services


def set_services(services: Services) -> None:
    global _services
    _services = services
