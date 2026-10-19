"""Deterministic synthetic retail dataset for the fictional chain Leon优选 (SYNTHETIC).

    python -m app.warehouse.generate                    # writes data/warehouse.db
    python -m app.warehouse.generate --out /tmp/w.db

Same seed and generator version give identical table contents and the same fingerprint,
so eval gold results never drift. About 107k rows: 7 regions, 24 stores, 12k customers,
240 products, ~34k orders and ~60k order lines between 2024-10-01 and 2026-09-30.

The data has deliberate structure so that analysis questions have interesting answers:
regional growth differs (西南 fastest, 东北 flat), 华南 has a higher refund rate,
六一八 and 双十一 lift volume, online channels gain share over time, two stores open
mid-period, and some orders are cancelled (which the GMV definition must exclude).
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import itertools
import json
import math
import os
import random
import sqlite3
import tempfile
from datetime import date, timedelta
from pathlib import Path

SEED = 20261001
GENERATOR_VERSION = 1
DATASET_NAME = "Leon优选 零售经营数据（SYNTHETIC）"
DATE_START = date(2024, 10, 1)
DATE_END = date(2026, 9, 30)

REGIONS = [
    # region_id, name, share of customers, yearly growth of order volume
    ("east", "华东", 0.28, 0.15),
    ("south", "华南", 0.20, 0.12),
    ("north", "华北", 0.18, 0.10),
    ("central", "华中", 0.12, 0.20),
    ("southwest", "西南", 0.11, 0.35),
    ("northwest", "西北", 0.05, 0.08),
    ("northeast", "东北", 0.06, 0.02),
]

STORES = [
    # store_id, name, city, region_id, type, opened
    ("S01", "上海徐汇店", "上海", "east", "旗舰店", "2019-05-18"),
    ("S02", "上海浦东店", "上海", "east", "标准店", "2020-09-01"),
    ("S03", "杭州西湖店", "杭州", "east", "标准店", "2020-04-12"),
    ("S04", "南京新街口店", "南京", "east", "标准店", "2021-03-20"),
    ("S05", "苏州园区店", "苏州", "east", "社区店", "2025-06-01"),
    ("S06", "广州天河店", "广州", "south", "旗舰店", "2019-08-08"),
    ("S07", "深圳南山店", "深圳", "south", "标准店", "2020-06-18"),
    ("S08", "深圳福田店", "深圳", "south", "社区店", "2021-10-01"),
    ("S09", "厦门思明店", "厦门", "south", "社区店", "2022-01-15"),
    ("S10", "北京朝阳店", "北京", "north", "旗舰店", "2019-10-01"),
    ("S11", "北京海淀店", "北京", "north", "标准店", "2020-11-11"),
    ("S12", "天津和平店", "天津", "north", "标准店", "2021-05-01"),
    ("S13", "石家庄长安店", "石家庄", "north", "社区店", "2022-07-01"),
    ("S14", "武汉光谷店", "武汉", "central", "旗舰店", "2020-08-15"),
    ("S15", "长沙五一店", "长沙", "central", "标准店", "2021-04-30"),
    ("S16", "郑州二七店", "郑州", "central", "社区店", "2022-09-09"),
    ("S17", "成都春熙店", "成都", "southwest", "旗舰店", "2020-12-12"),
    ("S18", "重庆解放碑店", "重庆", "southwest", "标准店", "2021-08-01"),
    ("S19", "昆明翠湖店", "昆明", "southwest", "社区店", "2023-03-01"),
    ("S20", "西安小寨店", "西安", "northwest", "标准店", "2021-06-06"),
    ("S21", "兰州西关店", "兰州", "northwest", "社区店", "2022-10-10"),
    ("S22", "沈阳中街店", "沈阳", "northeast", "标准店", "2020-07-07"),
    ("S23", "哈尔滨中央大街店", "哈尔滨", "northeast", "社区店", "2021-12-01"),
    ("S24", "大连星海店", "大连", "northeast", "社区店", "2026-03-15"),
]
STORE_TYPE_WEIGHT = {"旗舰店": 1.6, "标准店": 1.0, "社区店": 0.7}

CATEGORIES = [
    # category, brands, (min price, max price), (min cost ratio, max cost ratio), weight, items
    ("生鲜", ("Leon Fresh", "Mia Farm"), (9, 168), (0.62, 0.78), 0.26,
     "有机菠菜 智利车厘子 澳洲西冷牛排 散养土鸡蛋 挪威三文鱼 秘鲁蓝莓 走地鸡 云南小番茄 海南香蕉 赣南脐橙 "
     "东海带鱼 内蒙古羊排 有机西兰花 阳光玫瑰葡萄 奇异果 鲜虾仁 黑猪五花肉 鲜香菇 水果玉米 山东大葱"),
    ("食品饮料", ("Leon Select", "Noah Snacks"), (6, 99), (0.55, 0.72), 0.24,
     "东北大米 冷榨花生油 全麦吐司 每日坚果 纯牛奶 无糖酸奶 挂耳咖啡 气泡水 乌龙茶饮料 黑巧克力 "
     "苏打饼干 手工水饺 意大利面 燕麦片 椴树蜂蜜 老陈醋 生抽酱油 速冻汤圆 牛肉干 椰子水"),
    ("日用百货", ("Emma Home", "Leon Select"), (9, 169), (0.50, 0.68), 0.18,
     "抽纸 洗衣凝珠 厨房湿巾 垃圾袋 保鲜膜 洗洁精 收纳箱 纯棉毛巾 软毛牙刷 平板拖把 "
     "植绒衣架 香薰蜡烛 浴巾 保温杯 不粘锅 竹砧板 晾衣架 除湿袋 马克杯 餐具套装"),
    ("美妆个护", ("Iris Beauty", "Ava Care"), (29, 399), (0.38, 0.58), 0.12,
     "氨基酸洗面奶 保湿面霜 防晒乳 修护精华液 洗发水 护发素 沐浴露 身体乳 口红 粉底液 "
     "卸妆水 补水面膜 爽肤水 眼霜 护手霜 美白牙膏 漱口水 电动牙刷头 淡香水 剃须刀片"),
    ("母婴", ("Noah Kids", "Lily Baby"), (19, 299), (0.48, 0.66), 0.08,
     "婴儿纸尿裤 婴儿湿巾 婴幼儿奶粉 儿童牙膏 宝宝米粉 婴儿洗衣液 儿童水杯 安抚奶嘴 婴儿润肤霜 儿童绘本 "
     "积木玩具 儿童袜子 婴儿连体衣 辅食机 儿童餐具 隔尿垫 婴儿浴盆 退热贴 儿童雨衣 学步鞋"),
    ("数码家电", ("Jack Digital", "Max Tech"), (59, 2999), (0.70, 0.86), 0.12,
     "无线耳机 移动电源 智能手环 蓝牙音箱 电动牙刷 高速吹风机 空气炸锅 扫地机器人 电饭煲 破壁机 "
     "加湿器 护眼台灯 机械键盘 无线鼠标 快充充电器 编织数据线 电热水壶 电动剃须刀 平板支架 智能门铃"),
]
BRAND_PRICE = {"Leon Select": 0.9, "Leon Fresh": 0.95}

MEMBER_LEVELS = [("普通会员", 0.58, 1.0), ("银卡会员", 0.25, 1.4), ("金卡会员", 0.13, 2.0), ("黑金会员", 0.04, 3.0)]
AGE_BANDS = [("18-24岁", 0.16), ("25-34岁", 0.38), ("35-44岁", 0.28), ("45-54岁", 0.12), ("55岁以上", 0.06)]
MONTH_FACTOR = {1: 1.05, 2: 0.85, 3: 0.95, 4: 0.95, 5: 1.0, 6: 1.25, 7: 0.95, 8: 0.95, 9: 1.0, 10: 1.05, 11: 1.45, 12: 1.15}
CUSTOMERS = 12_000
BASE_ORDERS_PER_DAY = 36.0

SCHEMA = """
CREATE TABLE regions (
  region_id   TEXT PRIMARY KEY,
  region_name TEXT NOT NULL
);
CREATE TABLE stores (
  store_id    TEXT PRIMARY KEY,
  store_name  TEXT NOT NULL,
  city        TEXT NOT NULL,
  region_id   TEXT NOT NULL REFERENCES regions(region_id),
  store_type  TEXT NOT NULL,
  opened_date TEXT NOT NULL
);
CREATE TABLE customers (
  customer_id  TEXT PRIMARY KEY,
  region_id    TEXT NOT NULL REFERENCES regions(region_id),
  city         TEXT NOT NULL,
  member_level TEXT NOT NULL,
  age_band     TEXT NOT NULL,
  signup_date  TEXT NOT NULL,
  phone        TEXT NOT NULL
);
CREATE TABLE products (
  product_id   TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  category     TEXT NOT NULL,
  brand        TEXT NOT NULL,
  unit_price   REAL NOT NULL,
  unit_cost    REAL NOT NULL
);
CREATE TABLE orders (
  order_id        TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(customer_id),
  store_id        TEXT NOT NULL REFERENCES stores(store_id),
  region_id       TEXT NOT NULL REFERENCES regions(region_id),
  channel         TEXT NOT NULL,
  order_date      TEXT NOT NULL,
  status          TEXT NOT NULL,
  gross_amount    REAL NOT NULL,
  discount_amount REAL NOT NULL,
  pay_amount      REAL NOT NULL,
  refund_amount   REAL NOT NULL
);
CREATE TABLE order_items (
  item_id     INTEGER PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(order_id),
  product_id  TEXT NOT NULL REFERENCES products(product_id),
  quantity    INTEGER NOT NULL,
  unit_price  REAL NOT NULL,
  line_amount REAL NOT NULL,
  pay_amount  REAL NOT NULL
);
CREATE INDEX ix_orders_date ON orders(order_date);
CREATE INDEX ix_orders_region ON orders(region_id, order_date);
CREATE INDEX ix_orders_store ON orders(store_id);
CREATE INDEX ix_orders_customer ON orders(customer_id);
CREATE INDEX ix_items_order ON order_items(order_id);
CREATE INDEX ix_items_product ON order_items(product_id);
CREATE TABLE dataset_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

TABLE_ORDER = ["regions", "stores", "customers", "products", "orders", "order_items"]


class _Picker:
    """Weighted choice with precomputed cumulative weights (random.choices recomputes them)."""

    def __init__(self, items, weights):
        self.items = list(items)
        self.cum = list(itertools.accumulate(weights))
        self.total = self.cum[-1]

    def pick(self, rng: random.Random):
        return self.items[bisect.bisect_right(self.cum, rng.random() * self.total)]


def _poisson(rng: random.Random, lam: float) -> int:
    # Normal approximation is fine for lam ~ 30-150 and keeps generation fast.
    return max(0, int(round(rng.gauss(lam, math.sqrt(lam)))))


def _products(rng: random.Random) -> list[tuple]:
    rows = []
    n = 0
    for category, brands, (lo, hi), (cost_lo, cost_hi), _, items in CATEGORIES:
        for item in items.split():
            base = math.exp(rng.uniform(math.log(lo), math.log(hi)))
            for brand in brands:
                n += 1
                price = round(base * BRAND_PRICE.get(brand, rng.uniform(1.0, 1.15)), 1) - 0.1
                price = round(max(price, 1.9), 2)
                cost = round(price * rng.uniform(cost_lo, cost_hi), 2)
                rows.append((f"P{n:04d}", f"{brand} {item}", category, brand, price, cost))
    return rows


def _promo_factor(d: date) -> float:
    if d.month == 6 and d.day <= 18:
        return 0.9
    if d.month == 11 and d.day <= 11:
        return 0.85
    if d.month == 12 and d.day == 12:
        return 0.9
    return 1.0


def generate(path: str | os.PathLike) -> dict:
    """Write the warehouse to ``path`` atomically and return its metadata."""
    rng = random.Random(SEED)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # ---- dimensions ----
    regions = [(rid, name) for rid, name, _, _ in REGIONS]
    stores = list(STORES)
    products = _products(rng)
    product_by_cat: dict[str, _Picker] = {}
    for category, *_ in CATEGORIES:
        cat_products = [p for p in products if p[2] == category]
        # Zipf-like popularity inside a category
        weights = [1.0 / (i + 1) ** 0.8 for i in range(len(cat_products))]
        rng.shuffle(weights)
        product_by_cat[category] = _Picker(cat_products, weights)

    region_picker = _Picker([r[0] for r in REGIONS], [r[2] for r in REGIONS])
    level_picker = _Picker([m[0] for m in MEMBER_LEVELS], [m[1] for m in MEMBER_LEVELS])
    level_factor = {m[0]: m[2] for m in MEMBER_LEVELS}
    age_picker = _Picker([a[0] for a in AGE_BANDS], [a[1] for a in AGE_BANDS])
    cities_by_region: dict[str, list[str]] = {}
    for _, _, city, rid, _, _ in STORES:
        cities_by_region.setdefault(rid, []).append(city)

    customers = []
    by_region: dict[str, list[tuple[int, float]]] = {r[0]: [] for r in REGIONS}
    for i in range(1, CUSTOMERS + 1):
        rid = region_picker.pick(rng)
        level = level_picker.pick(rng)
        activity = rng.gammavariate(0.55, 1.0) * level_factor[level] + 0.02
        customers.append({
            "id": f"C{i:05d}", "region": rid, "city": rng.choice(cities_by_region[rid]),
            "level": level, "age": age_picker.pick(rng), "phone": f"100{rng.randrange(10**8):08d}",
            "first": None,
        })
        by_region[rid].append((i - 1, activity))
    customer_picker = {rid: _Picker([c for c, _ in rows], [w for _, w in rows]) for rid, rows in by_region.items()}

    growth = {r[0]: r[3] for r in REGIONS}
    share = {r[0]: r[2] for r in REGIONS}
    stores_by_region: dict[str, list[tuple]] = {}
    for s in stores:
        stores_by_region.setdefault(s[3], []).append(s)

    # ---- facts ----
    orders: list[tuple] = []
    items: list[tuple] = []
    total_days = (DATE_END - DATE_START).days
    order_no = 0
    item_no = 0
    category_names = [c[0] for c in CATEGORIES]
    category_weights = {c[0]: c[4] for c in CATEGORIES}
    d = DATE_START
    while d <= DATE_END:
        t = (d - DATE_START).days / total_days
        years = (d - DATE_START).days / 365.0
        weekday = 1.2 if d.weekday() >= 5 else 1.0
        festival = 2.0 if (d.month == 11 and 1 <= d.day <= 11) else 1.0
        open_stores = {rid: [s for s in rows if s[5] <= d.isoformat()] for rid, rows in stores_by_region.items()}
        for rid, _, _, _ in REGIONS:
            lam = BASE_ORDERS_PER_DAY * share[rid] * (1 + growth[rid]) ** years * MONTH_FACTOR[d.month] * weekday
            lam *= festival if d.month == 11 else 1.0
            if d.month == 11 and festival == 1.0:
                lam *= 0.8  # post-festival hangover keeps the month total sane
            for _ in range(_poisson(rng, lam)):
                order_no += 1
                cust = customers[customer_picker[rid].pick(rng)]
                store_choices = open_stores[rid]
                store = _Picker(store_choices, [STORE_TYPE_WEIGHT[s[4]] for s in store_choices]).pick(rng)

                online_shift = 0.08 * t + (0.05 if cust["level"] == "黑金会员" else 0.0)
                r = rng.random()
                channel = "线下门店" if r < 0.50 - online_shift else ("小程序" if r < 0.81 - online_shift * 0.4 else "App")

                lines = rng.choices([1, 2, 3, 4], weights=[0.52, 0.28, 0.13, 0.07])[0]
                weights = []
                for c in category_names:
                    w = category_weights[c]
                    if c == "美妆个护" and cust["level"] in ("金卡会员", "黑金会员"):
                        w *= 1.3
                    if c == "数码家电" and cust["level"] == "黑金会员":
                        w *= 1.5
                    if c == "母婴" and cust["age"] in ("25-34岁", "35-44岁"):
                        w *= 1.5
                    weights.append(w)
                cat_picker = _Picker(category_names, weights)
                picked: dict[str, list] = {}
                for _ in range(lines):
                    cat = cat_picker.pick(rng)
                    prod = product_by_cat[cat].pick(rng)
                    if prod[0] in picked:
                        picked[prod[0]][1] += 1
                        continue
                    if cat in ("生鲜", "食品饮料"):
                        qty = rng.choices([1, 2, 3], weights=[0.55, 0.30, 0.15])[0]
                    else:
                        qty = rng.choices([1, 2, 3], weights=[0.80, 0.15, 0.05])[0]
                    picked[prod[0]] = [prod, qty]

                promo = _promo_factor(d)
                order_lines = []
                gross = 0.0
                for prod, qty in picked.values():
                    price = round(prod[4] * promo, 2)
                    amount = round(price * qty, 2)
                    gross = round(gross + amount, 2)
                    order_lines.append([prod, qty, price, amount])

                discount = 0.0
                if cust["level"] == "黑金会员":
                    discount += gross * 0.05
                elif cust["level"] == "金卡会员":
                    discount += gross * 0.02
                coupon = rng.random()
                if gross >= 199 and coupon < 0.25:
                    discount += 20
                elif gross >= 99 and coupon < 0.25:
                    discount += 10
                discount = round(min(discount, gross * 0.3), 2)
                pay = round(gross - discount, 2)

                # allocate the order-level discount to lines so that SUM(line pay) == order pay exactly
                allocated = 0.0
                order_id = f"O{order_no:07d}"
                for idx, (prod, qty, price, amount) in enumerate(order_lines):
                    if idx == len(order_lines) - 1:
                        line_pay = round(pay - allocated, 2)
                    else:
                        line_pay = round(amount * pay / gross, 2) if gross else 0.0
                        allocated = round(allocated + line_pay, 2)
                    item_no += 1
                    items.append((item_no, order_id, prod[0], qty, price, amount, line_pay))

                cats = {line[0][2] for line in order_lines}
                p_cancel = 0.025 + (0.01 if channel == "App" else 0.0)
                p_refund = 0.045 * (1.45 if rid == "south" else 1.2 if rid == "northwest" else 1.0)
                if cats & {"数码家电", "美妆个护"}:
                    p_refund *= 1.4
                roll = rng.random()
                status = "cancelled" if roll < p_cancel else "refunded" if roll < p_cancel + p_refund else "paid"
                refund = pay if status == "refunded" else 0.0
                orders.append((order_id, cust["id"], store[0], rid, channel, d.isoformat(), status,
                               gross, discount, pay, refund))
                if cust["first"] is None:
                    cust["first"] = d
        d += timedelta(days=1)

    customer_rows = []
    for cust in customers:
        if cust["first"] is not None:
            signup = cust["first"] - timedelta(days=rng.randrange(0, 420))
        else:
            signup = date(2022, 1, 1) + timedelta(days=rng.randrange(0, (DATE_END - date(2022, 1, 1)).days))
        signup = max(signup, date(2022, 1, 1))
        customer_rows.append((cust["id"], cust["region"], cust["city"], cust["level"], cust["age"],
                              signup.isoformat(), cust["phone"]))

    # ---- write atomically ----
    fd, tmp_name = tempfile.mkstemp(prefix=".warehouse-", suffix=".db", dir=path.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        conn = sqlite3.connect(tmp)
        conn.executescript(SCHEMA)
        conn.executemany("INSERT INTO regions VALUES (?, ?)", regions)
        conn.executemany("INSERT INTO stores VALUES (?, ?, ?, ?, ?, ?)", stores)
        conn.executemany("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)", customer_rows)
        conn.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)", products)
        conn.executemany("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", orders)
        conn.executemany("INSERT INTO order_items VALUES (?, ?, ?, ?, ?, ?, ?)", items)
        conn.commit()
        meta = {
            "name": DATASET_NAME,
            "synthetic": True,
            "seed": SEED,
            "generator_version": GENERATOR_VERSION,
            "date_start": DATE_START.isoformat(),
            "date_end": DATE_END.isoformat(),
            "row_counts": {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLE_ORDER},
            "fingerprint": fingerprint(conn),
        }
        meta["total_rows"] = sum(meta["row_counts"].values())
        conn.executemany("INSERT INTO dataset_meta VALUES (?, ?)",
                         [(k, json.dumps(v, ensure_ascii=False)) for k, v in meta.items()])
        conn.commit()
        conn.execute("VACUUM")
        conn.close()
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return meta


def fingerprint(conn: sqlite3.Connection) -> str:
    """sha256 over every table in primary-key order: identical data, identical fingerprint."""
    digest = hashlib.sha256()
    for table in TABLE_ORDER:
        digest.update(table.encode())
        for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1"):
            digest.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
    return digest.hexdigest()


def read_meta(path: str | os.PathLike) -> dict | None:
    if not Path(path).exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
        try:
            rows = conn.execute("SELECT key, value FROM dataset_meta").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return {k: json.loads(v) for k, v in rows}


def ensure_warehouse(path: str | os.PathLike) -> dict:
    """Generate the warehouse if it is missing or was built by an older generator."""
    meta = read_meta(path)
    if meta is None or meta.get("generator_version") != GENERATOR_VERSION:
        meta = generate(path)
    return meta


def main(argv: list[str] | None = None) -> int:
    from ..config import get_settings

    parser = argparse.ArgumentParser(description="Generate the synthetic ProofBI warehouse")
    parser.add_argument("--out", default=None, help="SQLite file to write (default: PROOFBI_WAREHOUSE_PATH)")
    args = parser.parse_args(argv)
    out = args.out or get_settings().warehouse_path
    meta = generate(out)
    print(f"{meta['name']} -> {out}")
    print("rows:", json.dumps(meta["row_counts"], ensure_ascii=False), "total", meta["total_rows"])
    print("fingerprint:", meta["fingerprint"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
