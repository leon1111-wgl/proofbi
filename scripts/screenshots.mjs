// Regenerate the README screenshots from the static demo build: the same recordings that
// GitHub Pages serves, so the shots need no backend and come out the same every time.
//
//   cd frontend && pnpm build:demo && pnpm preview --mode demo --port 4173 --strictPort &
//   node scripts/screenshots.mjs
//
// Optional:
//   BASE_URL=http://127.0.0.1:4173/proofbi/                (default)
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright     (default: import "playwright")
//   CHROME_PATH=/path/to/chrome                            (default: Playwright's Chromium)
//   OUT_DIR=docs/assets
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, "index.mjs")).href
  : "playwright";
const { chromium } = await import(moduleUrl);

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:4173/proofbi/").replace(/\/?$/, "/");
const OUT = process.env.OUT_DIR ?? "docs/assets";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const errors = [];

async function session(options, fn) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    reducedMotion: "reduce", // replay steps instantly, no edge animation in the stills
    ...options,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await fn(page);
  await context.close();
}

const shot = async (page, name, fullPage = false) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`saved ${name}.png`);
};

async function loginAs(page, name) {
  await page.goto(`${BASE}login`);
  await page.locator(".account", { hasText: `${name} ·` }).click();
  await page.waitForURL("**/ask");
}

/** Replays a recorded question; `tag` picks among recordings of the same question (fault demos). */
async function ask(page, question, tag) {
  const before = await page.locator("article.answer").count();
  const pick = page.locator(".suggestion, .replay-chips .chip").filter({ hasText: question });
  await (tag ? pick.filter({ hasText: tag }) : pick).first().click();
  await page.waitForFunction((n) => document.querySelectorAll("article.answer").length > n, before);
  await page.waitForTimeout(300);
}

async function newConversation(page) {
  await page.getByRole("button", { name: "新建对话" }).first().click();
  await page.waitForURL(/\/ask$/);
}

// 1. landing: hero and the live lineage specimen
await session({ viewport: { width: 1440, height: 1480 } }, async (page) => {
  await page.goto(BASE);
  await page.locator(".specimen .numchip").nth(2).hover();
  await shot(page, "landing");
});

// 2. sign-in, 3. an answer whose derived number lights two result cells
await session({}, async (page) => {
  await page.goto(`${BASE}login`);
  await page.locator(".account").first().waitFor();
  await shot(page, "login");

  await loginAs(page, "Leon");
  await ask(page, "上个月各区域复购率同比");
  await page.locator("article.answer .numchip-derived").first().hover();
  await page.setViewportSize({ width: 1440, height: 1180 });
  await shot(page, "ask-answer");
  await page.setViewportSize({ width: 1440, height: 900 });

  // 4. an injected wrong number: the chain breaks before the result rows
  await newConversation(page);
  await ask(page, "上个月华东区的 GMV", "数字被改错");
  await page.locator("article.answer .numchip-unverified").first().hover();
  await page.setViewportSize({ width: 1440, height: 1180 });
  await shot(page, "hallucination");
  await page.setViewportSize({ width: 1440, height: 900 });

  // 5. an injected column-name hallucination is corrected on the second attempt
  await newConversation(page);
  await ask(page, "上个月的 GMV 是多少？", "列名幻觉");
  await page.locator("article.answer").last().getByRole("link", { name: "查看链路" }).click();
  await page.waitForURL("**/traces/**");
  await page.locator(".span-row", { hasText: "执行" }).first().click();
  await shot(page, "self-correction");

  // 6. semantic layer, row policies, offline evaluation
  await page.getByRole("link", { name: /语义层/ }).first().click();
  await page.locator("table").first().waitFor();
  await shot(page, "semantic");
  await page.getByRole("button", { name: "数据权限" }).click();
  await shot(page, "policies");
  await page.getByRole("link", { name: /评测报告/ }).first().click();
  await page.locator(".kpi").first().waitFor();
  await shot(page, "evals");
});

// 7. Mia: refusal + clarification, then number provenance under row-level security
await session({}, async (page) => {
  await loginAs(page, "Mia");
  await ask(page, "华南区上个月 GMV 是多少？");
  await ask(page, "华东区上个月营收怎么样？");
  await shot(page, "refusal-clarify");
  await newConversation(page);
  await ask(page, "上个月复购率是多少？");
  await page.locator("article.answer .numchip-verified").first().click();
  await page.getByRole("button", { name: "重新执行并比对结果指纹" }).click();
  await page.getByText("结果一致").waitFor();
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.locator(".drawer .tabs button").first().click();
  await shot(page, "provenance");
});

// 8. dark theme
await session({ colorScheme: "dark" }, async (page) => {
  await loginAs(page, "Jack");
  await ask(page, "上个月的 GMV 和毛利率");
  await page.locator("article.answer .numchip").last().hover();
  await shot(page, "dark");
});

// 9. a phone: tapping a number lights its lineage
await session({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
  await loginAs(page, "Emma");
  await ask(page, "上个月华南区的退款率");
  await page.locator("article.answer .numchip").first().tap();
  await page.locator(".lineage").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "mobile");
});

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
