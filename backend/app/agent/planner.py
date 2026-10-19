"""Question -> Plan / Clarification / Refusal.

``RulesPlanner`` is the offline model: deterministic keyword matching against the
semantic layer (longest match first, so 毛利率 wins over 毛利 and 上海徐汇店 over 上海).
It is intentionally simple: it keeps CI reproducible and shows where an LLM planner adds
value. ``validate_plan`` is shared by both planners: permissions, metric ACLs, dimension
compatibility and data ranges are decided by code, never by the model.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from ..semantic.access import User
from ..semantic.layer import SemanticLayer
from ..semantic.plan import Clarification, Plan, Refusal
from ..semantic.timeparse import NUM, OutOfRange, TimeRange, cn_to_int, default_range, parse_time, previous_period


@dataclass
class Lookups:
    """Dimension codes read from the warehouse, used for permission checks."""
    region_codes: dict[str, str]  # 华东 -> east
    store_codes: dict[str, str]  # 上海徐汇店 -> S01
    store_region: dict[str, str]  # S01 -> east
    store_city: dict[str, str]  # S01 -> 上海
    city_regions: dict[str, set[str]]  # 上海 -> {east}

    @property
    def region_names(self) -> dict[str, str]:
        return {v: k for k, v in self.region_codes.items()}

    @property
    def store_names(self) -> dict[str, str]:
        return {v: k for k, v in self.store_codes.items()}

    def value_codes(self) -> dict[str, dict[str, str]]:
        return {"region": dict(self.region_codes), "store": dict(self.store_codes)}


@dataclass
class PlanOutcome:
    kind: str  # plan | clarify | refuse
    plan: Plan | None = None
    clarification: Clarification | None = None
    refusal: Refusal | None = None
    trace: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def refuse(cls, reason: str, message: str, suggestions: list[str] | None = None, **trace) -> "PlanOutcome":
        return cls("refuse", refusal=Refusal(reason, message, suggestions or []), trace=trace)


# ---------------------------------------------------------------- patterns
WRITE_RE = re.compile(
    r"删除|删掉|删了|清空|清除|篡改|插入|写入|drop\s+table|delete\s+from|truncate|alter\s+table|insert\s+into"
    r"|update\s+\w+\s+set|(?:把|将).{0,24}(?:改成|改为|修改|更新|删)|(?:修改|更新|改掉)(?:一下)?.{0,6}"
    r"(?:订单|数据|表|记录|状态|价格|金额|会员|客户|商品|门店)", re.I)
SENSITIVE_RE = re.compile(r"手机号|手机号码|电话|联系方式|身份证|住址|家庭地址|收货地址|邮箱|密码|银行卡")
EXPORT_RE = re.compile(r"导出|下载|全部明细|所有明细|明细数据|逐条|每一笔|每笔订单|所有订单的|列出所有|全部订单列表")
FORECAST_RE = re.compile(r"预测|预计|预估|将会|明年|下个月|下季度|下周|未来|会不会涨|能不能达到")
INJECTION_RE = re.compile(r"(?:忽略|无视|绕过|跳过|不要管).{0,10}(?:规则|限制|权限|指令|设置|提示|要求)"
                          r"|ignore\s+(?:all|previous|the)|system\s*prompt|你现在是|扮演", re.I)
HELP_RE = re.compile(r"(?:有哪些|支持哪些|能查哪些|可以问什么|能问什么|你能做什么|可以查什么)(?:指标|问题|数据)?")
UNKNOWN_METRIC_RE = re.compile(
    r"率|额|量|数|值|指数|nps|留存|转化|流失|库存|利润|满意度|日活|月活|dau|mau|点击|曝光|pv|uv|roi|ltv|人效|坪效"
    r"|周转|好评|差评|评分|成本", re.I)
DATA_WORDS_RE = re.compile(r"多少|是多少|怎么样|如何|情况|对比|趋势|排名|哪个|哪些|统计|看看|查一下|查询")
FOLLOWUP_RE = re.compile(r"^(?:那|那么|换成|改成|再看|再按|按|如果是|如果换成|看看|还有)|呢[？?]?$|^.{0,8}呢")
MOM_RE = re.compile(r"环比|比上月|较上月|相比上月|比上个月|较上个月|和上个月比|与上月相比|相比上个月|上一周期")
YOY_RE = re.compile(r"同比|去年同期|比去年|较去年|和去年比|相比去年|与去年相比")
TREND_RE = re.compile(r"趋势|走势|变化|波动|曲线")
TOPN_RE = re.compile(rf"(?:前|top|排名前|最高的|最多的|最好的)\s*{NUM}", re.I)
BOTTOMN_RE = re.compile(rf"(?:后|倒数|最低的|最少的|最差的)\s*{NUM}")
SUPER_DESC_RE = re.compile(r"最高|最多|最大|最好|最强|第一|领先|卖得最好|最畅销|冠军|最赚钱")
SUPER_ASC_RE = re.compile(r"最低|最少|最小|最差|垫底|最不")
SINGULAR_RE = re.compile(r"哪个|哪家|哪一|哪款|哪位|哪种|是哪|谁")
PLURAL_RE = re.compile(r"哪些")
RANK_DESC_RE = re.compile(r"排名|排行|排序|从高到低|降序")
RANK_ASC_RE = re.compile(r"从低到高|升序")
GROUP_PREFIXES = ("各个", "各", "每个", "每", "按照", "按", "分", "哪个", "哪家", "哪些", "哪一", "哪", "不同", "所有", "全部")
GROUP_SUFFIXES = ("排名", "排行", "排序", "分布", "对比", "占比", "拆分", "维度", "top", "前")


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).strip()


@dataclass
class _Entry:
    surface: str
    kind: str  # metric | ambiguous | dimension | value
    key: str
    values: tuple[str, ...] = ()


@dataclass
class _Match:
    start: int
    end: int
    entry: _Entry


class Vocabulary:
    def __init__(self, layer: SemanticLayer):
        entries: list[_Entry] = []
        for m in layer.metrics.values():
            for s in {m.label, *m.synonyms}:
                entries.append(_Entry(s, "metric", m.key))
        for term in layer.ambiguous:
            entries.append(_Entry(term, "ambiguous", term))
        for d in layer.dimensions.values():
            for s in {d.label, *d.synonyms}:
                entries.append(_Entry(s, "dimension", d.key))
            for v in d.values:
                entries.append(_Entry(v, "value", d.key, (v,)))
            for alias, targets in d.value_synonyms.items():
                entries.append(_Entry(alias, "value", d.key, tuple(targets)))
        store = layer.dimensions.get("store")
        city = layer.dimensions.get("city")
        if store and city:
            for name in store.values:
                for c in city.values:
                    short = name[len(c):]
                    if name.startswith(c) and len(short) >= 3:
                        entries.append(_Entry(short, "value", "store", (name,)))
        self.entries = entries

    def match(self, text: str) -> list[_Match]:
        lower = text.lower()
        found: list[_Match] = []
        for e in self.entries:
            needle = e.surface.lower()
            start = lower.find(needle)
            while start != -1:
                found.append(_Match(start, start + len(needle), e))
                start = lower.find(needle, start + 1)
        found.sort(key=lambda m: (-(m.end - m.start), m.start))
        taken: list[_Match] = []
        for m in found:
            if all(m.end <= t.start or m.start >= t.end for t in taken):
                taken.append(m)
        return sorted(taken, key=lambda m: m.start)


def _rank(text: str, has_dims: bool) -> tuple[str | None, int | None]:
    m = TOPN_RE.search(text)
    if m:
        return "desc", min(cn_to_int(m.group(1)), 100)
    m = BOTTOMN_RE.search(text)
    if m:
        return "asc", min(cn_to_int(m.group(1)), 100)
    if not has_dims:
        return None, None
    singular, plural = bool(SINGULAR_RE.search(text)), bool(PLURAL_RE.search(text))
    limit = 1 if singular else 5 if plural else None
    if SUPER_DESC_RE.search(text):
        return "desc", limit
    if SUPER_ASC_RE.search(text):
        return "asc", limit
    if RANK_ASC_RE.search(text):
        return "asc", None
    if RANK_DESC_RE.search(text):
        return "desc", None
    return None, None


class RulesPlanner:
    name = "rules"

    def __init__(self, layer: SemanticLayer, lookups: Lookups):
        self.layer = layer
        self.lookups = lookups
        self.vocab = Vocabulary(layer)

    def screen(self, question: str, clarifications: dict[str, str] | None = None) -> PlanOutcome | None:
        """Deterministic checks that run before any planner, rules or LLM: writes, sensitive
        data, exports, forecasts, and ambiguous metric words that need a clarification."""
        layer = self.layer
        text = normalize(question)
        clarifications = clarifications or {}
        trace: dict[str, Any] = {"planner": self.name}
        if WRITE_RE.search(text):
            return PlanOutcome.refuse("write", "ProofBI 是只读的问数工具，不能修改、删除或写入数据。", **trace)
        if SENSITIVE_RE.search(text):
            return PlanOutcome.refuse("sensitive", "手机号、地址等个人敏感信息不在可查询范围内，ProofBI 只提供聚合指标。", **trace)
        if EXPORT_RE.search(text):
            return PlanOutcome.refuse("export", "ProofBI 只回答聚合指标，不提供订单或客户明细导出。明细需求请走数据团队的审批流程。",
                                      **trace)
        if FORECAST_RE.search(text):
            return PlanOutcome.refuse(
                "forecast", f"ProofBI 只回答已经发生的数据（截至 {layer.calendar.data_end.isoformat()}），不做预测。", **trace)
        if HELP_RE.search(text):
            metrics = "、".join(m.label for m in layer.metrics.values())
            return PlanOutcome.refuse("off_topic", f"可以问这些指标：{metrics}；可按区域、城市、门店、渠道、品类、会员等级、月份等拆分。",
                                      **trace)
        for m in self.vocab.match(text):
            if m.entry.kind != "ambiguous":
                continue
            term = m.entry.key
            options = layer.ambiguous[term]
            if clarifications.get(term) not in options:
                return PlanOutcome("clarify", clarification=Clarification(
                    term=term,
                    question=f"“{term}”有不同口径，你想看哪一个？",
                    options=[{"value": k, "label": layer.metrics[k].label, "description": layer.metrics[k].description}
                             for k in options],
                ), trace=trace)
        return None

    def plan(self, question: str, user: User, context: dict | None = None,
             clarifications: dict[str, str] | None = None) -> PlanOutcome:
        layer = self.layer
        text = normalize(question)
        clarifications = clarifications or {}
        trace: dict[str, Any] = {"planner": self.name}
        screened = self.screen(question, clarifications)
        if screened is not None:
            return screened
        injection = bool(INJECTION_RE.search(text))

        matches = self.vocab.match(text)
        trace["matches"] = [{"text": text[m.start:m.end], "kind": m.entry.kind, "key": m.entry.key} for m in matches]

        # ---- metrics (ambiguous words were resolved by screen())
        metrics: list[str] = []
        notes: list[str] = []
        for m in matches:
            if m.entry.kind == "metric" and m.entry.key not in metrics:
                metrics.append(m.entry.key)
            elif m.entry.kind == "ambiguous":
                chosen = clarifications[m.entry.key]
                if chosen not in metrics:
                    metrics.append(chosen)
                notes.append(f"“{m.entry.key}”按{layer.metrics[chosen].label}口径统计（已确认）。")

        # ---- dimensions and filters
        dims: list[str] = []
        filters: dict[str, list[str]] = {}
        mentions: dict[str, int] = {}
        multi_value: set[str] = set()
        for i, m in enumerate(matches):
            if m.entry.kind == "value":
                vals = filters.setdefault(m.entry.key, [])
                for v in m.entry.values:
                    if v not in vals:
                        vals.append(v)
                mentions[m.entry.key] = mentions.get(m.entry.key, 0) + 1
                if len(m.entry.values) > 1:
                    multi_value.add(m.entry.key)
        for i, m in enumerate(matches):
            if m.entry.kind != "dimension":
                continue
            key = m.entry.key
            if key in dims:
                continue
            dim = layer.dimensions[key]
            prev = matches[i - 1] if i > 0 else None
            if prev and prev.entry.kind == "value" and prev.entry.key == key and m.start - prev.end <= 1:
                continue  # 华东区域 = the region 华东, not "by region"
            before = text[max(0, m.start - 4):m.start]
            after = text[m.end:m.end + 6].lower()
            if dim.is_time or any(before.endswith(p) for p in GROUP_PREFIXES) or any(s in after for s in GROUP_SUFFIXES):
                dims.append(key)
            elif key not in filters:
                dims.append(key)
        for key, count in mentions.items():
            if count >= 2 and key not in dims and key not in multi_value:
                dims.append(key)  # 华东和华南 -> compare the two
        if TREND_RE.search(text) and not any(layer.dimensions[d].is_time for d in dims):
            dims.append("month")

        # ---- follow-up questions inherit from the previous plan
        inherited: list[str] = []
        prev_plan = Plan.from_dict(context) if context else None
        is_followup = prev_plan is not None and not metrics and (
            bool(filters or dims) or FOLLOWUP_RE.search(text) is not None or parse_time_safe(text, layer) is not None)
        if not metrics:
            if is_followup:
                metrics = list(prev_plan.metrics)
                inherited.append("metrics")
            elif injection:
                return PlanOutcome.refuse("off_topic", "没有识别到要查询的指标。数据权限由系统强制执行，不能通过提问绕过。", **trace)
            elif UNKNOWN_METRIC_RE.search(text) or DATA_WORDS_RE.search(text):
                return PlanOutcome.refuse(
                    "unknown_metric", "语义层里没有定义这个指标，为了避免口径不一致，ProofBI 不会临时编一个口径。",
                    [m.label for m in layer.metrics.values()], **trace)
            else:
                return PlanOutcome.refuse("off_topic", "我只回答 Leon优选 经营数据相关的问题，例如“上个月华东区的复购率是多少？”",
                                          **trace)
        if is_followup:
            for key, vals in prev_plan.filters.items():
                if key not in filters:
                    filters[key] = list(vals)
            if not dims:
                dims = [d for d in prev_plan.dimensions if d not in filters]
                if dims:
                    inherited.append("dimensions")
            if len(inherited) == 1 and "metrics" in inherited:
                notes.append(f"沿用上一个问题的指标：{'、'.join(layer.label(k) for k in metrics)}。")

        # ---- time
        cal = layer.calendar
        stripped = YOY_RE.sub(" ", MOM_RE.sub(" ", text))
        try:
            time = parse_time(stripped, cal)
        except OutOfRange as exc:
            return PlanOutcome.refuse("out_of_range", str(exc), **trace)
        if time is None:
            if is_followup:
                time = prev_plan.time
                inherited.append("time")
            else:
                time = default_range(cal, trend=any(layer.dimensions[d].is_time for d in dims))
        if "time" in inherited:
            notes.append(f"沿用上一个问题的时间：{time.label}。")
        else:
            notes = list(time.notes) + notes

        compare = "mom" if MOM_RE.search(text) else "yoy" if YOY_RE.search(text) else None
        if compare is None and is_followup and prev_plan.compare and "time" in inherited:
            compare = prev_plan.compare
        compare_time = None
        if compare:
            # 环比 / 同比 compares whole periods; a month or day split on top of it would leave
            # every row with only one of the two periods
            dropped = [d for d in dims if layer.dimensions[d].is_time]
            if dropped:
                dims = [d for d in dims if d not in dropped]
                notes.append(f"{'同比' if compare == 'yoy' else '环比'}按整个统计周期对比，不再按{layer.label(dropped[0])}拆分。")
            compare_time = previous_period(time, compare)
            if compare_time.start < cal.data_start:
                notes.append(f"对比期（{compare_time.start.isoformat()} 起）没有完整数据，本次不做{'同比' if compare == 'yoy' else '环比'}。")
                compare, compare_time = None, None

        order, limit = _rank(text, bool(dims))
        if order is None and is_followup and prev_plan.order and "dimensions" in inherited:
            order, limit = prev_plan.order, prev_plan.limit
        if injection:
            notes.append("检测到“忽略权限 / 规则”之类的表述：已忽略，数据权限由系统强制执行。")

        plan = Plan(metrics=metrics, time=time, dimensions=dims, filters=filters, compare=compare,
                    compare_time=compare_time, order=order, order_by=metrics[0] if order else None, limit=limit,
                    notes=notes, inherited=inherited)
        return validate_plan(plan, user, layer, self.lookups, trace)


def parse_time_safe(text: str, layer: SemanticLayer) -> TimeRange | None:
    try:
        return parse_time(text, layer.calendar)
    except OutOfRange as exc:
        return exc.requested


def validate_plan(plan: Plan, user: User, layer: SemanticLayer, lookups: Lookups,
                  trace: dict[str, Any] | None = None) -> PlanOutcome:
    """Checks that hold for any planner. Returns the plan, or a refusal explaining why not."""
    trace = trace or {}
    if not plan.metrics:
        return PlanOutcome.refuse("unknown_metric", "没有识别到语义层中的指标。", [m.label for m in layer.metrics.values()],
                                  **trace)
    for key in plan.metrics:
        if key not in layer.metrics:
            return PlanOutcome.refuse("unknown_metric", f"语义层中没有指标 {key}。", [m.label for m in layer.metrics.values()],
                                      **trace)
        metric = layer.metrics[key]
        if metric.requires and not user.has(metric.requires):
            return PlanOutcome.refuse("permission", f"{metric.label}涉及成本数据，你的账号没有“{metric.requires}”权限。"
                                      "如需查看请联系财务或数据平台负责人。", **trace)
    for key in plan.dimensions:
        if key not in layer.dimensions:
            return PlanOutcome.refuse("unsupported", f"语义层中没有维度 {key}。", **trace)
        for m in plan.metrics:
            if key not in layer.allowed_dimensions(m):
                return PlanOutcome.refuse(
                    "unsupported", f"{layer.metrics[m].label}的口径不支持按{layer.dimensions[key].label}拆分"
                    f"（可用维度：{'、'.join(layer.label(d) for d in layer.allowed_dimensions(m))}）。", **trace)
    for key, values in plan.filters.items():
        dim = layer.dimensions.get(key)
        if dim is None:
            return PlanOutcome.refuse("unsupported", f"语义层中没有维度 {key}。", **trace)
        bad = [v for v in values if dim.values and v not in dim.values]
        if bad:
            return PlanOutcome.refuse("unsupported", f"{dim.label}中没有取值 {'、'.join(bad)}。", **trace)
        for m in plan.metrics:
            if key not in layer.allowed_dimensions(m):
                return PlanOutcome.refuse(
                    "unsupported", f"{layer.metrics[m].label}的口径不支持按{dim.label}筛选。", **trace)
    denied = _out_of_scope(plan, user, lookups)
    if denied:
        label = user.scope_label(lookups.region_names, lookups.store_names)
        return PlanOutcome.refuse("permission", f"你的数据权限是“{label}”，无法查询{denied}的数据。", **trace)
    if plan.limit is not None:
        plan.limit = max(1, min(int(plan.limit), 100))
    return PlanOutcome("plan", plan=plan, trace=trace)


def _out_of_scope(plan: Plan, user: User, lookups: Lookups) -> str | None:
    if user.scope_type == "all":
        return None
    allowed_regions = set(user.regions)
    if user.scope_type == "store":
        allowed_regions = {lookups.store_region.get(s, "") for s in user.stores}
    for name in plan.filters.get("region", []):
        if lookups.region_codes.get(name) not in allowed_regions:
            return name
    for name in plan.filters.get("store", []):
        code = lookups.store_codes.get(name)
        if user.scope_type == "store" and code not in user.stores:
            return name
        if user.scope_type == "region" and lookups.store_region.get(code or "") not in allowed_regions:
            return name
    for name in plan.filters.get("city", []):
        if user.scope_type == "store":
            if name not in {lookups.store_city.get(s) for s in user.stores}:
                return name
        elif not lookups.city_regions.get(name, set()) & allowed_regions:
            return name
    return None
