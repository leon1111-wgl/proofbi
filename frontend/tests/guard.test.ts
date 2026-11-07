/* The backend's attack list, through the browser's guard and engine. Same verdict, same security class.
 * Then what only the browser has: each line of defence checked alone, so that a test fails if one is removed. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userOf } from "../src/engine/pack";
import { applyRowPolicies, checkSql } from "../src/engine/sqlguard";
import { QueryError } from "../src/engine/warehouse";
import { ask, engine } from "./helpers";

const parity = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf-8"));
const mia = userOf("mia"), leon = userOf("leon"), noah = userOf("noah");
// the backend's own list blocks unit_cost as if the caller had no cost permission
const noCost = { ...leon, permissions: [] };

describe("guard verdicts match the backend's", () => {
  for (const a of parity.attacks as { sql: string; ok: boolean; security: boolean; code: string }[]) {
    it(`${a.code}: ${a.sql}`, async () => {
      const e = await engine();
      e.warehouse.useIdentity(noCost);
      const r = checkSql(a.sql, noCost, (s) => e.warehouse.parseCheck(s));
      expect(r.ok, r.error).toBe(a.ok);
      expect(r.security, r.error).toBe(a.security);
      expect(r.violations.map((v) => v.code)).toContain(a.code);
    });
  }
  for (const l of parity.legitimate as { sql: string; ok: boolean }[]) {
    it(`passes: ${l.sql}`, () => {
      const r = checkSql(l.sql, leon);
      expect(r.ok, r.error).toBe(true);
    });
  }
});

describe("guard details", () => {
  it("adds a missing LIMIT and tightens a large one", () => {
    expect(checkSql("SELECT order_id FROM orders", leon).sql).toMatch(/LIMIT 1000$/);
    expect(checkSql("SELECT order_id FROM orders LIMIT 99999", leon).sql).toMatch(/LIMIT 1000$/);
    expect(checkSql("SELECT order_id FROM orders LIMIT 10", leon).sql).toMatch(/LIMIT 10$/);
  });
  it("drops comments from what runs", () => {
    const r = checkSql("SELECT order_id /* ; DROP TABLE orders */ FROM orders -- hi\nLIMIT 3", leon);
    expect(r.ok).toBe(true);
    expect(r.sql).not.toMatch(/DROP|hi/);
  });
  it("a semicolon inside a string is not a second statement", () => {
    expect(checkSql("SELECT order_id FROM orders WHERE status = 'a;b' LIMIT 1", leon).ok).toBe(true);
  });
  it.each([
    ['SELECT "phone" FROM customers', "blocked_column"],
    ["SELECT [phone] FROM customers", "blocked_column"],
    ["SELECT `phone` FROM customers", "blocked_column"],
    ['SELECT "load_extension"(\'x\')', "function_not_allowed"],
    ["SELECT order_id FROM SQLITE_MASTER", "system_table"],
    ['SELECT sql FROM "sqlite_master"', "system_table"],
    ["WITH x AS (SELECT 1) DELETE FROM orders", "forbidden_statement"],
  ])("%s", (sql, code) => {
    const r = checkSql(sql, mia);
    expect(r.ok).toBe(false);
    expect(r.security).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain(code);
  });
  it("rejects what cannot be read structurally rather than guessing", () => {
    for (const sql of ["SELECT COUNT(*) FROM (orders)", "SELECT 1 WHERE 'x' IN orders", "SELECT order_id FROM orders LIMIT 1, 5"]) {
      expect(checkSql(sql, mia).ok, sql).toBe(false);
    }
  });
  it("cost column depends on the identity", () => {
    expect(checkSql("SELECT unit_cost FROM products", mia).security).toBe(true);
    expect(checkSql("SELECT unit_cost FROM products", leon).ok).toBe(true);
  });
});

describe("row-level security on the engine", () => {
  const regionsSeen = async (sql: string, user = mia) => {
    const e = await engine();
    return (await e.warehouse.execute(sql, user)).rows.map((r) => r[0]);
  };
  it("the shipped warehouse has no phone column at all", async () => {
    const e = await engine();
    await expect(e.warehouse.execute("SELECT phone FROM customers", leon)).rejects.toThrow(/no such column|phone/);
  });
  it("rewritten SQL returns only the identity's rows", async () => {
    const e = await engine();
    const checked = checkSql("SELECT region_id, COUNT(*) AS n FROM orders GROUP BY region_id", mia);
    const { sql, policies } = applyRowPolicies(checked, mia);
    expect(policies.orders).toBe("region_id IN ('east')");
    expect((await e.warehouse.execute(sql, mia)).rows.map((r) => r[0])).toEqual(["east"]);
  });
  // These reach the engine directly, skipping guard and rewrite: name resolution alone must hold.
  it.each([
    ["bare name", "SELECT DISTINCT region_id FROM orders"],
    ["parenthesised", "SELECT DISTINCT region_id FROM (orders)"],
    ["subquery", "SELECT DISTINCT region_id FROM (SELECT region_id FROM orders)"],
    ["CTE", "WITH x AS (SELECT region_id FROM orders) SELECT DISTINCT region_id FROM x"],
    ["UNION branch", "SELECT region_id FROM stores UNION SELECT region_id FROM orders"],
    ["IN table", "SELECT DISTINCT region_id FROM regions WHERE region_id IN (SELECT region_id FROM orders)"],
    ["different case", 'SELECT DISTINCT region_id FROM "ORDERS"'],
  ])("%s stays inside the policy view without any rewrite", async (_name, sql) => {
    expect(new Set(await regionsSeen(sql))).toEqual(new Set(["east"]));
  });
  it("the store manager sees one store through the views alone", async () => {
    expect(await regionsSeen("SELECT DISTINCT store_id FROM orders", noah)).toEqual(["S01"]);
    expect(await regionsSeen("SELECT DISTINCT store_id FROM stores", noah)).toEqual(["S01"]);
  });
  it.each([
    ["schema-qualified read", "SELECT COUNT(*) FROM main.orders"],
    ["view definitions", "SELECT sql FROM sqlite_temp_master"],
    ["system table", "SELECT sql FROM sqlite_master"],
    ["table-valued pragma", "SELECT name FROM pragma_table_info('orders')"],
    ["function", "SELECT sqlite_version()"],
    ["recursive CTE", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT MAX(x) FROM c"],
  ])("the authorizer denies a %s", async (_name, sql) => {
    const e = await engine();
    const err = await e.warehouse.execute(sql, mia).catch((x) => x);
    expect(err).toBeInstanceOf(QueryError);
    expect((err as QueryError).kind).toBe("denied");
  });
  it("cost columns do not exist for an identity without the permission", async () => {
    const e = await engine();
    const err = await e.warehouse.execute("SELECT unit_cost FROM products", mia).catch((x) => x);
    expect(err).toBeInstanceOf(QueryError);
  });
  it("writes fail on the engine even without any guard", async () => {
    const e = await engine();
    for (const sql of ["DELETE FROM orders", "UPDATE main.orders SET status = 'x'", "DROP TABLE main.orders", "CREATE TABLE t(a)"]) {
      const err = await e.warehouse.execute(sql, leon).catch((x) => x);
      expect(err, sql).toBeInstanceOf(QueryError);
    }
    expect((await e.warehouse.execute("SELECT COUNT(*) FROM orders", leon)).rows[0][0]).toBe(34282);
  });
  it("a long query is stopped by the progress handler", async () => {
    const e = await engine();
    const err = await e.warehouse.execute("SELECT COUNT(*) FROM orders a JOIN orders b ON 1 = 1 JOIN orders c ON 1 = 1", leon).catch((x) => x);
    expect((err as QueryError).kind).toBe("timeout");
  });
  it("switching identity replaces the views", async () => {
    expect(new Set(await regionsSeen("SELECT DISTINCT region_id FROM orders", mia))).toEqual(new Set(["east"]));
    expect((await regionsSeen("SELECT DISTINCT region_id FROM orders", leon)).length).toBe(7);
    expect(new Set(await regionsSeen("SELECT DISTINCT region_id FROM orders", userOf("emma")))).toEqual(new Set(["south"]));
  });
});

describe("pasted SQL through the whole pipeline", () => {
  it("unsafe SQL is refused as security", async () => {
    const run = await ask("mia", "SELECT phone FROM customers");
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).toBe("security");
  });
  it("safe SQL runs under the identity's policies and shows the rewrite", async () => {
    const run = await ask("mia", "SELECT region_id, COUNT(*) AS n FROM orders GROUP BY region_id");
    expect(run.status).toBe("answered");
    expect(run.queries[0].rows.map((r: unknown[]) => r[0])).toEqual(["east"]);
    expect(run.queries[0].executed_sql).toContain("region_id IN ('east')");
    expect(run.answer.verification.verdict).toBe("none");
  });
  it("a recoverable problem does not run and says so", async () => {
    const run = await ask("leon", "SELECT * FROM orders");
    expect(run.status).toBe("refused");
    expect(run.refusal.reason).toBe("sql_rejected");
  });
  it("replay re-executes and matches, for real", async () => {
    const e = await engine();
    const run = await ask("mia", "上个月的 GMV 是多少？");
    const id = run.queries[0].query_id;
    const replay = await e.replay(id, mia);
    expect(replay!.match).toBe(true);
    expect(replay!.replay_hash).toBe(run.queries[0].result_hash);
  });
  it("replay refuses a record whose SQL was altered", async () => {
    const e = await engine();
    const run = await ask("mia", "上个月的 GMV 是多少？");
    const id = run.queries[0].query_id;
    e.queries.get(id)!.attempt.sql_executed = "SELECT 1";
    await expect(e.replay(id, mia)).rejects.toThrow(/指纹/);
  });
});
