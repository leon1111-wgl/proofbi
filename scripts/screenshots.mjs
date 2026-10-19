// Regenerate the README screenshots against a running ProofBI server.
//
//   BASE_URL=http://127.0.0.1:8000 node scripts/screenshots.mjs
//
// Start the server on a fresh database first (PROOFBI_DATABASE_URL=sqlite:////tmp/shots.db),
// so the conversation lists in the shots are clean. Optional:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright   (default: import "playwright")
//   CHROME_PATH=/path/to/chrome                          (default: Playwright's Chromium)
//   OUT_DIR=docs/assets
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, "index.mjs")).href
  : "playwright";
const { chromium } = await import(moduleUrl);

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8000";
const OUT = process.env.OUT_DIR ?? "docs/assets";
const VIEWPORT = { width: 1440, height: 900 };
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "light", locale: "zh-CN" });
const page = await context.newPage();

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`saved ${name}.png`);
};

async function loginAs(name) {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.removeItem("proofbi.token"));
  await page.goto(`${BASE}/`);
  await page.locator(".account", { hasText: `${name} ·` }).click();
  await page.waitForURL("**/ask");
}

async function newConversation() {
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.waitForURL(/\/ask$/);
}

async function ask(question, fault) {
  if (fault !== undefined) await page.locator(".composer select").selectOption(fault);
  const before = await page.locator("article.answer").count();
  await page.locator(".composer textarea").fill(question);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll("article.answer").length > n, before);
  await page.waitForTimeout(500);
}

// 1. login
await page.goto(`${BASE}/`);
await page.evaluate(() => localStorage.removeItem("proofbi.token"));
await page.goto(`${BASE}/`);
await page.locator(".account").first().waitFor();
await shot("login");

// 2. an answer with a chart, derived numbers and the execution chain
await loginAs("Leon");
await ask("上个月各区域复购率同比");
await shot("ask-answer");

// 3. an injected hallucination is flagged red; an injected SQL error is corrected
await newConversation();
await ask("上个月华东区的 GMV", "number_hallucination");
await shot("hallucination");
await newConversation();
await ask("上个月的 GMV 是多少？", "sql_error");
await page.locator(".composer select").selectOption("");
await page.locator("article.answer").last().getByRole("link", { name: "查看链路" }).click();
await page.waitForURL("**/traces/**");
await page.locator(".span-row", { hasText: "执行" }).first().click();
await shot("self-correction");

// 4. semantic layer and row policies
await page.goto(`${BASE}/semantic`);
await page.locator("table").first().waitFor();
await shot("semantic");
await page.getByRole("button", { name: "数据权限" }).click();
await shot("policies");

// 5. evaluation report
await page.goto(`${BASE}/evals`);
await page.locator(".kpi").first().waitFor();
await shot("evals");

// 6. Mia: refusal + clarification, then number provenance under row-level security
await loginAs("Mia");
await ask("华南区上个月 GMV 是多少？");
await ask("华东区上个月营收怎么样？");
await shot("refusal-clarify");
await newConversation();
await ask("上个月复购率是多少？");
await page.locator(".numchip-verified").first().click();
await page.getByRole("button", { name: "重新执行并比对结果指纹" }).click();
await page.getByText("结果一致").waitFor();
await page.setViewportSize({ width: VIEWPORT.width, height: 1500 });
await page.locator(".drawer .tabs button").first().click();
await shot("provenance");
await page.setViewportSize(VIEWPORT);
await page.keyboard.press("Escape");

// 7. dark mode
await loginAs("Leon");
await page.emulateMedia({ colorScheme: "dark" });
await page.locator(".convo-item").last().click();
await page.locator("article.answer").first().waitFor();
await shot("dark");

await browser.close();
