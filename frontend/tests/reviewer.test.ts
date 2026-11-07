/* The reviewer's probes (a separate session, 2026-11-07), written without reading the planner or understand.ts.
 * They are regression tests. They are not a blind set, and they do not count towards any score. */
import { describe, expect, it } from "vitest";
import { lastResultOf } from "../src/engine/conversation";
import { ask, engine, newConvo } from "./helpers";

async function turns(user: string, ...questions: string[]) {
  const convo = newConvo();
  let run: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const q of questions) run = await ask(user, q, convo);
  return run;
}
const numbersOf = (run: { answer: { verification: { counts: { unverified: number }; numbers: unknown[] } } }) => run.answer.verification;

describe("references resolve to the previous result, or are refused", () => {
  it("最低的那个的GMV is the lowest region, not the company", async () => {
    const run = await turns("leon", "上个月各区域GMV", "最低的那个的GMV");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters).toEqual({ region: ["东北"] });
    expect(run.plan.metrics).toEqual(["gmv"]);
    expect(run.plan.dimensions).toEqual([]);
    expect(run.plan.time.start).toBe("2026-09-01");
    expect(run.answer.text).toContain("东北");
    expect(run.queries[0].rows[0][0]).toBe(23414.99);
  });
  it("最高的那个的客单价 is the top region's", async () => {
    const run = await turns("leon", "上个月各区域GMV", "最高的那个的客单价");
    expect(run.plan.filters).toEqual({ region: ["华东"] });
    expect(run.plan.metrics).toEqual(["aov"]);
    expect(run.answer.text).toContain("379.61");
  });
  it("这个城市的客单价 keeps 上海 and does not rank", async () => {
    const run = await turns("leon", "上个月上海的GMV", "这个城市的客单价");
    expect(run.plan.filters).toEqual({ city: ["上海"] });
    expect(run.plan.dimensions).toEqual([]);
    expect(run.plan.metrics).toEqual(["aov"]);
  });
  it.each([
    ["第二名的客单价", "华南"], ["第2名的客单价", "华南"], ["排第一的客单价", "华东"], ["倒数第一的客单价", "东北"], ["垫底的客单价", "东北"],
    ["最高的那个呢", "华东"], ["最低的那家的客单价", "东北"], ["第一个的客单价", "华东"],
  ])("ordinal %s", async (q, region) => {
    const run = await turns("leon", "上个月各区域GMV", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters).toEqual({ region: [region] });
  });
  it.each(["它的客单价", "这个的客单价", "那个呢", "它呢"])("a pronoun over one row: %s", async (q) => {
    const run = await turns("leon", "上个月GMV最高的区域", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters).toEqual({ region: ["华东"] });
  });
  it.each(["它的客单价", "这个区域的客单价"])("a pronoun over a filter: %s", async (q) => {
    const run = await turns("leon", "上个月华东的GMV", q);
    expect(run.plan.filters).toEqual({ region: ["华东"] });
    expect(run.plan.metrics).toEqual(["aov"]);
  });
  it.each(["它们的客单价", "这些区域的客单价", "这几个的客单价"])("a plural reference over rows: %s", async (q) => {
    const run = await turns("leon", "上个月GMV前3的区域", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect([...run.plan.filters.region].sort()).toEqual(["华东", "华北", "华南"].sort());
    expect(run.plan.dimensions).toEqual(["region"]);
  });
  it.each(["它的客单价", "那个的客单价", "这个城市的客单价", "这家店的GMV"])("ambiguous over many rows is refused: %s", async (q) => {
    const run = await turns("leon", "上个月各城市GMV", q);
    expect(run.status, run.answer?.text).toBe("refused");
    expect(run.refusal.message).toMatch(/指|哪/);
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
  it.each(["那个的GMV", "它的客单价", "第二名的GMV", "这个城市的GMV", "最高的那个"])("nothing to refer to is refused: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.answer?.text).toBe("refused");
    expect(run.refusal.message).not.toMatch(/语义层里没有“[^”]{1,1}”/);
  });
  it("the list stays reachable after drilling into a row", async () => {
    expect((await turns("leon", "上个月各区域GMV", "最低的那个的GMV", "第一名呢")).plan.filters).toEqual({ region: ["华东"] });
    expect((await turns("leon", "上个月各区域GMV", "最低的那个的GMV", "那最高的呢")).plan.filters).toEqual({ region: ["华东"] });
    expect((await turns("leon", "上个月各区域GMV", "最低的那个的GMV", "它的退款率")).plan.filters).toEqual({ region: ["东北"] });
    expect((await turns("mia", "上个月各门店GMV", "最高的那家的客单价", "第二名呢")).plan.filters.store.length).toBe(1);
  });
  it("a new question forgets the list", async () => {
    const run = await turns("leon", "上个月各区域GMV", "8月的GMV", "第二名呢");
    expect(run.status, run.answer?.text).toBe("refused");
  });
  it("排名第二 and 倒数第二", async () => {
    expect((await turns("leon", "上个月各区域GMV", "排名第二的客单价")).plan.filters).toEqual({ region: ["华南"] });
    expect((await turns("leon", "上个月各区域GMV", "倒数第二的客单价")).status).toBe("answered");
  });
  it("a value and its 占比 after an inherited split", async () => {
    const run = await turns("leon", "上个月各门店订单数", "线下占多少");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.dimensions).toEqual(["channel"]);
    expect(run.answer.text).toMatch(/线下门店占/);
  });
  it("a refusal in between does not cancel an open clarification", async () => {
    const run = await turns("leon", "上个月华东的销售额", "那个的", "GMV");
    expect(run.plan.metrics).toEqual(["gmv"]);
    expect(run.plan.filters).toEqual({ region: ["华东"] });
  });
  it("after a comparison a reference is refused", async () => {
    const run = await turns("leon", "上个月各区域GMV同比", "最高的那个的客单价");
    expect(run.status, run.answer?.text).toBe("refused");
  });
  it("a reference to a month becomes that month", async () => {
    const run = await turns("leon", "今年每月的GMV", "最高的那个的订单数");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.time.start).toBe("2026-01-01");
    expect(run.plan.time.end).toBe("2026-01-31");
    expect(run.plan.dimensions).toEqual([]);
  });
  it("a superlative with a metric re-ranks the same split", async () => {
    const run = await turns("leon", "上个月各区域GMV", "最低的客单价");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.dimensions).toEqual(["region"]);
    expect(run.plan.metrics).toEqual(["aov"]);
    expect(run.plan.order).toBe("asc");
    expect(run.plan.limit).toBe(1);
  });
  it.each(["GMV最高", "上个月GMV排名", "上个月GMV前5"])("a ranking with nothing to rank is refused: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.answer?.text).toBe("refused");
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
  it("第一季度 is a period, not a rank", async () => {
    const run = await ask("leon", "第一季度的GMV");
    expect(run.status).toBe("answered");
    expect(run.plan.time.start).toBe("2026-01-01");
  });
  it("a recording feeds a live reference", () => {
    const last = lastResultOf({
      status: "answered", plan: { order: null },
      queries: [{ columns: ["region", "gmv"], rows: [["华东", 2], ["东北", 1]], column_meta: [{ key: "region", role: "dimension", time: false }, { key: "gmv", role: "metric" }] }],
    });
    expect(last).toMatchObject({ dimension: "region", values: ["华东", "东北"] });
  });
});

describe("a follow-up never silently drops a filter", () => {
  it("a metric alone inherits, and says so", async () => {
    const run = await turns("leon", "上个月上海的GMV", "客单价多少");
    expect(run.plan.filters).toEqual({ city: ["上海"] });
    expect(run.plan.time.start).toBe("2026-09-01");
    expect(run.plan_view.notes.join("")).toContain("上海");
  });
  it("a complete new question says it did not inherit", async () => {
    const run = await turns("leon", "上个月上海的GMV", "8月的退款率");
    expect(run.plan.filters).toEqual({});
    expect(run.plan_view.notes.join("")).toMatch(/没有沿用.*上海/);
  });
  it("a contradicting city replaces the region, and says so", async () => {
    const run = await turns("leon", "上个月华东的GMV", "北京呢");
    expect(run.plan.filters).toEqual({ city: ["北京"] });
    expect(run.plan_view.notes.join("")).toContain("华东");
  });
  it("a city inside the region keeps it", async () => {
    const run = await turns("leon", "上个月华东的GMV", "上海呢");
    expect(run.plan.filters).toEqual({ region: ["华东"], city: ["上海"] });
  });
});

describe("references under row-level security", () => {
  it("Mia: the lowest city stays inside her scope", async () => {
    const run = await turns("mia", "上个月各城市GMV", "最低的那个的GMV");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters).toEqual({ city: ["苏州"] });
    expect(run.queries[0].rows[0][0]).toBe(18935.8);
    expect(run.queries[0].policies.orders).toContain("east");
  });
  it("Mia: 这个城市 over her filter", async () => {
    const run = await turns("mia", "上个月杭州的GMV", "这个城市的客单价");
    expect(run.plan.filters).toEqual({ city: ["杭州"] });
    expect(run.queries[0].policies.orders).toContain("east");
  });
  it("Mia: a reference then another region is refused", async () => {
    const run = await turns("mia", "上个月各城市GMV", "最高的那个的GMV", "那华南呢");
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).toBe("permission");
  });
  it("Mia: a contradicting city outside her scope is refused, not replaced", async () => {
    const run = await turns("mia", "上个月华东的GMV", "北京呢");
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).toBe("permission");
  });
  it("Noah: a channel reference stays in his store", async () => {
    const run = await turns("noah", "上个月各渠道GMV", "最高的那个的订单数");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters.channel.length).toBe(1);
    expect(run.queries[0].policies.orders).toContain("S01");
  });
  it("Noah: his own store by reference", async () => {
    const run = await turns("noah", "上个月各门店GMV", "它的客单价");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.queries[0].policies.orders).toContain("S01");
  });
  it("Noah: a reference to his region is refused as wider than the store", async () => {
    const run = await turns("noah", "上个月各区域GMV", "最高的那个的GMV");
    expect(run.status, run.answer?.text).toBe("refused");
    expect(run.refusal.reason).toBe("permission");
  });
  it("pasted SQL clears what a reference could point at", async () => {
    const run = await turns("mia", "上个月各城市GMV", "SELECT city, COUNT(*) AS n FROM stores GROUP BY city", "最高的那个的GMV");
    expect(run.status, run.answer?.text).toBe("refused");
  });
});

describe("累计 and 占比 are computed or refused, consistently", () => {
  it("累计 covers all the data", async () => {
    const run = await ask("leon", "累计GMV");
    expect(run.plan.time.start).toBe("2024-10-01");
    expect(run.plan.time.end).toBe("2026-09-30");
    expect(run.plan_view.notes.join("")).toContain("累计");
  });
  it.each([["各区域累计GMV", ["region"]], ["历史累计订单数", []], ["有史以来的销量", []]])("%s", async (q, dims) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.time.start).toBe("2024-10-01");
    expect(run.plan.dimensions).toEqual(dims);
  });
  it("今年累计 is this year", async () => {
    const run = await ask("leon", "今年累计GMV");
    expect(run.plan.time.start).toBe("2026-01-01");
  });
  it("上个月累计 is that month", async () => {
    const run = await ask("leon", "上个月累计GMV");
    expect(run.plan.time.start).toBe("2026-09-01");
    expect(run.plan.time.end).toBe("2026-09-30");
  });
  it("a running total by month has no definition", async () => {
    const run = await ask("leon", "今年每月累计GMV");
    expect(run.status, run.answer?.text).toBe("refused");
  });
  it("各渠道GMV占比 states verified shares", async () => {
    const run = await ask("leon", "上个月各渠道GMV占比");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.dimensions).toEqual(["channel"]);
    const v = numbersOf(run);
    expect(v.counts.unverified).toBe(0);
    const shares = (v.numbers as { unit: string; status: string; formula: string | null }[]).filter((n) => n.unit === "%");
    expect(shares.length).toBe(3);
    for (const s of shares) {
      expect(s.status).toBe("derived");
      expect(s.formula).toContain("占比");
    }
    expect(run.answer.text).toMatch(/小程序\s*41\.4%/);
  });
  it.each(["华东GMV占全公司多少", "上个月华东GMV占比", "上个月华东的GMV占比是多少"])("a value's share uses the whole as denominator: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.answer.text).toMatch(/华东.*占\s*28\.6%/);
    expect(numbersOf(run).counts.unverified).toBe(0);
    expect(run.plan.dimensions).toEqual(["region"]);
    expect(run.plan.filters).toEqual({});
  });
  it("占比最高 is the largest share", async () => {
    const run = await ask("leon", "上个月GMV占比最高的品类");
    expect(run.status).toBe("answered");
    expect(run.answer.text).toMatch(/占比最高的品类是数码家电/);
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
  it.each(["上个月各区域退款率占比", "上个月各区域客单价占比", "上个月各区域下单用户数占比"])("a metric that cannot be added has no share: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.answer?.text).toBe("refused");
  });
  it.each(["GMV占比", "上个月GMV的比例"])("a share with no parts is refused: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.answer?.text).toBe("refused");
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
  it("Mia: shares inside her scope say so", async () => {
    const run = await ask("mia", "上个月各城市GMV占比");
    expect(run.status).toBe("answered");
    expect(run.plan_view.notes.join("")).toContain("华东");
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
  it("Mia: her region's share of the company is refused", async () => {
    for (const q of ["华东GMV占全公司多少", "上个月华东GMV占比"]) {
      const run = await ask("mia", q);
      expect(run.status, run.answer?.text).toBe("refused");
      expect(run.refusal.reason).toBe("permission");
    }
  });
  it("Noah: shares inside his store", async () => {
    const run = await ask("noah", "上个月各渠道GMV占比");
    expect(run.status).toBe("answered");
    expect(run.queries[0].policies.orders).toContain("S01");
    expect(run.plan_view.notes.join("")).toContain("上海徐汇店");
  });
});

describe("the answer says what was asked", () => {
  it.each([
    ["GMV最高的城市的客单价", "city", ["GMV", "客单价"]],
    ["销量最高的商品的GMV", "product", ["销量", "GMV"]],
    ["退款率最高的渠道的GMV", "channel", ["退款率", "GMV"]],
    ["客单价最高的区域的订单数", "region", ["客单价", "订单数"]],
    ["华东上个月GMV最高的城市的订单数", "city", ["GMV", "订单数"]],
  ])("%s", async (q, dim, labels) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.dimensions).toEqual([dim]);
    expect(run.plan.limit).toBe(1);
    for (const l of labels) expect(run.answer.text).toContain(l);
    expect(numbersOf(run).counts.unverified).toBe(0);
    const row = run.queries[0].rows[0] as unknown[];
    const cols = run.queries[0].columns as string[];
    const second = cols.indexOf(run.plan.metrics[1]);
    const refs = (numbersOf(run).numbers as { ref: { column: string; row: number } | null }[]).filter((n) => n.ref?.column === cols[second]);
    expect(refs.length, `${row}`).toBeGreaterThan(0);
  });
  it("metrics in different queries describe the same row", async () => {
    const run = await ask("jack", "上个月GMV最高的品类的毛利率");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.queries.length).toBe(2);
    expect(run.queries[1].rows.length).toBe(1);
    expect(run.queries[1].rows[0][0]).toBe(run.queries[0].rows[0][0]);
    expect(run.answer.text).toContain("毛利率");
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
  it("a split with two metrics states both", async () => {
    const run = await ask("leon", "上个月各区域的GMV和订单数");
    expect(run.answer.text).toContain("GMV");
    expect(run.answer.text).toContain("订单数");
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
  it("a trend with two metrics states both", async () => {
    const run = await ask("leon", "今年每月的GMV和退款率");
    expect(run.answer.text).toContain("退款率从");
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
  it("a comparison with two metrics states both", async () => {
    const run = await ask("leon", "上个月GMV和订单数环比");
    expect(run.answer.text).toContain("订单数");
    expect(numbersOf(run).counts.unverified).toBe(0);
  });
});

describe("everyday wording", () => {
  it.each([
    ["总订单数", ["order_count"]], ["总GMV", ["gmv"]], ["GMV总额", ["gmv"]], ["一共多少单", ["order_count"]], ["平均客单价", ["aov"]],
    ["总销量", ["items_sold"]], ["总成交额", ["gmv"]], ["订单总数", ["order_count"]], ["销量总量", ["items_sold"]], ["总退款金额", ["refund_amount"]],
  ])("%s", async (q, metrics) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.metrics).toEqual(metrics);
  });
  it.each([["车厘子上个月卖了多少件", "智利车厘子"], ["牛奶上个月的销量", "纯牛奶"], ["三文鱼卖了多少件", "挪威三文鱼"]])("a part of a product name: %s", async (q, family) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters.product.every((p: string) => p.endsWith(family))).toBe(true);
    expect(run.plan_view.notes.join("")).toContain(family);
  });
  it("a part of several product names asks which", async () => {
    const run = await ask("leon", "有机上个月的销量");
    expect(run.status).toBe("refused");
    expect(run.refusal.message).toContain("有机菠菜");
  });
  it.each(["不对，我说的是净销售额", "不是GMV，是净销售额", "错了，应该是净销售额", "我说的是净销售额"])("a correction replaces the metric: %s", async (q) => {
    const run = await turns("leon", "上个月华东的GMV", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.metrics).toEqual(["net_revenue"]);
    expect(run.plan.filters).toEqual({ region: ["华东"] });
    expect(run.plan.time.start).toBe("2026-09-01");
  });
  it("a correction replaces a value", async () => {
    const run = await turns("leon", "上个月华东的GMV", "不是华东，是华南");
    expect(run.plan.filters).toEqual({ region: ["华南"] });
    expect(run.plan.dimensions).toEqual([]);
  });
  it("a correction answers a clarification", async () => {
    const run = await turns("leon", "上个月华东的销售额", "不对，我说的是净销售额");
    expect(run.plan.metrics).toEqual(["net_revenue"]);
    expect(run.plan.filters).toEqual({ region: ["华东"] });
  });
  it.each([["mia", "我们部门上个月退款率"], ["mia", "我们团队上个月退款率"], ["noah", "我们店上个月退款率"], ["emma", "我们部门上个月GMV"]])("%s: %s", async (u, q) => {
    const run = await ask(u, q);
    expect(run.status, run.refusal?.message).toBe("answered");
  });
  it("an all-company identity's 部门 is not assumed", async () => {
    const run = await ask("leon", "我们部门上个月退款率");
    expect(run.status).toBe("refused");
    expect(run.refusal.message).toContain("部门");
  });
  it("年轻人买得多吗 is on topic and points to 年龄段", async () => {
    const run = await ask("leon", "年轻人买得多吗");
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).not.toBe("off_topic");
    expect(run.refusal.message).toContain("年轻人");
    expect(run.refusal.message).toContain("年龄段");
    expect(run.refusal.next_steps.join("")).toContain("年龄段");
  });
  it.each(["每个周一的订单", "周末的GMV", "工作日的订单数", "按周看GMV"])("%s is on topic and says what the calendar has", async (q) => {
    const run = await ask("leon", q);
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).not.toBe("off_topic");
    expect(run.refusal.message).toMatch(/按月|按天/);
    expect(run.refusal.next_steps.join("")).toContain("每天");
  });
  it.each(["今天天气怎么样", "给我讲个笑话", "写首诗"])("%s stays off topic", async (q) => {
    const run = await ask("leon", q);
    expect(run.refusal.reason).toBe("off_topic");
  });
});

describe("wording of a refusal", () => {
  const BROKEN = /“(价|名|午|家|总|半|公司总|一|个|的|费|店|天|高|多|少)”/;
  it.each(["上午的GMV", "半个月的GMV", "公司总收入", "第三名的GMV", "几家门店GMV最高", "上午下午的订单", "半年的GMV", "夜里的单量", "每家的GMV"])("does not name a fragment: %s", async (q) => {
    const run = await ask("leon", q);
    if (run.status !== "refused") return;
    expect(run.refusal.message).not.toMatch(BROKEN);
  });
  it("names the whole phrase", async () => {
    const run = await ask("leon", "上午的GMV");
    expect(run.status).toBe("refused");
    expect(run.refusal.message).toContain("上午");
  });
  it.each(["你是谁", "help", "帮助", "你好", "介绍一下你自己"])("%s gets an introduction, not a refusal", async (q) => {
    const run = await ask("leon", q);
    expect(run.refusal.reason).toBe("chat");
    expect(run.refusal.message).toContain("ProofBI");
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
  it.each(["谢谢", "好的", "嗯", "ok", "知道了", "明白了"])("%s is acknowledged", async (q) => {
    const run = await ask("leon", q);
    expect(run.refusal.reason).toBe("chat");
    expect(run.refusal.message).not.toContain("只回答");
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
});
void engine;
