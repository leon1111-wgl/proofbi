/* Findings from the independent review, as written by the reviewer. Each failed before its fix. */
import { describe, expect, it } from "vitest";
import { checkSql } from "../src/engine/sqlguard";
import { userOf } from "../src/engine/pack";
import { ask, newConvo } from "./helpers";

const refused = async (u: string, q: string, reason?: string | string[]) => {
  const run = await ask(u, q);
  expect(run.status, run.answer?.text).toBe("refused");
  if (reason) expect([reason].flat(), run.refusal.message).toContain(run.refusal.reason);
  return run;
};

describe("never answer a different question", () => {
  it.each(["上个月GMV前3的区域同比", "上个月退款率最高的门店环比", "上个月销量前5的商品环比"])("top N with a comparison is refused, not cut across periods: %s", async (q) => {
    const run = await refused("leon", q, "unsupported");
    expect(run.refusal.next_steps.length).toBeGreaterThan(0);
  });
  it("a ranked follow-up then a comparison is refused too", async () => {
    const c = newConvo();
    await ask("leon", "上个月各门店的退款率", c);
    await ask("leon", "前3", c);
    const run = await ask("leon", "环比呢", c);
    expect(run.status, run.answer?.text).toBe("refused");
  });
  it.each([
    ["上个月数码产品的GMV", { category: ["数码家电"] }],
    ["上个月生鲜商品的GMV", { category: ["生鲜"] }],
    ["上个月美妆产品卖了多少件", { category: ["美妆个护"] }],
    ["上个月华东门店的GMV", { region: ["华东"] }],
  ])("a value with a dimension word is a filter, not a split: %s", async (q, filters) => {
    const run = await ask("leon", q);
    expect(run.status).toBe("answered");
    expect(run.plan.dimensions).toEqual([]);
    expect(run.plan.filters).toEqual(filters);
  });
  it("a ranking keeps the split", async () => {
    const run = await ask("leon", "上个月生鲜商品销量前5");
    expect(run.plan.dimensions).toEqual(["product"]);
    expect(run.plan.limit).toBe(5);
  });
  it.each([
    ["前6个月各区域GMV", "2026-04-01", "2026-09-30"],
    ["前3个月各门店的GMV", "2026-07-01", "2026-09-30"],
    ["今年前6个月各区域GMV", "2026-01-01", "2026-06-30"],
    ["去年前3个月的GMV", "2025-01-01", "2025-03-31"],
  ])("前N个月 is a period, not a top N: %s", async (q, start, end) => {
    const run = await ask("leon", q);
    expect(run.status).toBe("answered");
    expect(run.plan.limit).toBe(null);
    expect(run.plan.time.start).toBe(start);
    expect(run.plan.time.end).toBe(end);
  });
  it.each(["上个月GMV环比下降的门店有哪些", "上个月GMV环比上升的区域", "上个月比上上个月下降的门店"])("a direction is a condition the layer cannot express: %s", async (q) => {
    await refused("leon", q);
  });
  it.each([["上个月GMV环比涨了多少", "mom"], ["上个月GMV同比下降了多少", "yoy"], ["上个月GMV比去年同期涨了吗", "yoy"]])("asking how much it moved still works: %s", async (q, compare) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.compare).toBe(compare);
  });
  it.each(["上个月华东的GMV", "上个月上海的GMV", "上个月上海各渠道的订单数"])("a store manager naming a wider area is refused: %s", async (q) => {
    await refused("noah", q, "permission");
  });
  it("a store manager naming their own store still works", async () => {
    const run = await ask("noah", "上个月徐汇店的GMV");
    expect(run.status).toBe("answered");
  });
  it("a region manager naming a city inside the region still works", async () => {
    const run = await ask("mia", "上个月上海的GMV");
    expect(run.status).toBe("answered");
    expect(run.queries[0].rows[0][0]).toBe(60471.84);
  });
  it("占比 with nothing to divide by is refused", async () => {
    await refused("leon", "上个月GMV占比");
  });
  it("占比 of a value is computed against its whole", async () => {
    const run = await ask("leon", "上个月线上GMV占比");
    expect(run.status).toBe("answered");
    expect(run.answer.text).toMatch(/小程序占 41\.4%.*App占 21\.8%/);
    expect(run.answer.verification.counts.unverified).toBe(0);
  });
  it("占比 with a split states the shares", async () => {
    const run = await ask("leon", "上个月各区域GMV占比");
    expect(run.status).toBe("answered");
    expect(run.answer.text).toContain("占比");
    expect(run.answer.verification.counts.unverified).toBe(0);
  });
  it("去年同期 alone names no period to compare", async () => {
    await refused("leon", "去年同期的GMV");
  });
  it("去年同期 in a follow-up keeps the period", async () => {
    const c = newConvo();
    await ask("leon", "上个月的GMV", c);
    const run = await ask("leon", "那去年同期呢", c);
    expect(run.status).toBe("answered");
    expect(run.plan.compare).toBe("yoy");
    expect(run.plan.time.start).toBe("2026-09-01");
  });
  it.each([["今年以来哪个月GMV最高", "month"], ["今年以来GMV最高的月份", "month"], ["上个月哪天单量最多", "date"]])("the best period is one row, not a change: %s", async (q, dim) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.dimensions).toEqual([dim]);
    expect(run.plan.limit).toBe(1);
    expect(run.answer.text).not.toContain("变为");
  });
  it("线上 listed apart says so", async () => {
    const run = await ask("leon", "上个月线上线下哪个卖得多");
    expect(run.status).toBe("answered");
    expect(run.plan_view?.notes.join("")).toContain("小程序和 App");
  });
  it("线上上个月 is last month", async () => {
    const run = await ask("leon", "线上上个月的GMV");
    expect(run.plan.time.start).toBe("2026-09-01");
  });
  it("退货最多 asks which refund measure", async () => {
    const run = await ask("leon", "上个月哪个品类退货最多");
    expect(run.status).toBe("clarify");
    expect(run.clarification.term).toBe("退款");
  });
  it("这家店 is the store manager's own store", async () => {
    const run = await ask("noah", "这家店上个月多少人来买");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.metrics).toEqual(["buyer_count"]);
  });
  it("next steps do not inherit the conversation", async () => {
    const c = newConvo();
    await ask("leon", "华南上个月退了多少钱", c);
    const run = await ask("leon", "上个月优惠券用了多少", c);
    expect(run.status).toBe("refused");
    expect(run.refusal.next_steps.join("")).not.toContain("华南");
  });
  it("a trend inside one month is by day", async () => {
    const run = await ask("leon", "近两周GMV趋势");
    expect(run.plan.dimensions).toEqual(["date"]);
    expect(run.answer.text).not.toMatch(/2026-09 的 .* 变为 2026-09 的/);
  });
  it.each(["上个月退了多少单", "上个月退了几单", "上个月退掉多少单"])("refund counts: %s", async (q) => {
    const run = await ask("leon", q);
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.metrics).toEqual(["refund_rate"]);
  });
  it("a member level with a people word", async () => {
    const run = await ask("leon", "上个月黑金会员用户的GMV");
    expect(run.status, run.refusal?.message).toBe("answered");
    expect(run.plan.filters).toEqual({ member_level: ["黑金会员"] });
  });
  it("a brand with a product family names one product", async () => {
    const run = await ask("leon", "上个月Mia Farm的奇异果卖了多少件");
    expect(run.status).toBe("answered");
    expect(run.plan.filters).toEqual({ product: ["Mia Farm 奇异果"] });
    expect(run.answer.text).not.toContain("Leon Fresh");
  });
});

describe("guard", () => {
  const leon = userOf("leon");
  it("a self-referencing CTE is recursive even without the keyword", () => {
    const r = checkSql("WITH c AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM c) SELECT MAX(n) AS m FROM c", leon);
    expect(r.ok).toBe(false);
    expect(r.security).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain("recursive_cte");
  });
  it("a CTE with a column list is not read as a function", () => {
    const r = checkSql("WITH c(n) AS (SELECT region_id FROM regions) SELECT n FROM c", leon);
    expect(r.ok, r.error).toBe(true);
  });
});
