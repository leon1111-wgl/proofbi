// Walks the whole visitor flow on a production demo build, in a real browser, at desktop and 375px, light
// and dark. Every new feature is exercised for real, including the failure path when the engine cannot load.
//
//   cd frontend && pnpm build:demo && cd .. && node scripts/walkthrough.mjs
//
// Env: CHROME_PATH (a Chrome binary; Playwright's own is used when unset), PLAYWRIGHT_MODULE (path to the
// playwright module when it is not installed here), WALK_OUT (directory for screenshots and measure.json).
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "frontend", "dist");
const OUT = process.env.WALK_OUT ?? join(ROOT, "walkthrough-output");
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? `${process.env.PLAYWRIGHT_MODULE}/index.mjs` : "playwright");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".gz": "application/gzip", ".svg": "image/svg+xml", ".png": "image/png" };
// Like GitHub Pages: text and wasm are gzipped on the wire, an already compressed file is sent as it is.
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (!url.startsWith("/proofbi/")) { res.writeHead(404).end(); return; }
  let path = join(DIST, url.slice("/proofbi/".length));
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(DIST, "index.html");
  const ext = extname(path);
  const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" };
  if ([".html", ".js", ".css", ".json", ".wasm", ".svg"].includes(ext)) {
    const body = gzipSync(readFileSync(path));
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.length }).end(body);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": statSync(path).size });
  createReadStream(path).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}/proofbi/`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed++;
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` :: ${detail}` : ""}`);
};

const answerOf = (page, n) => page.locator("article.answer").nth(n);
async function ask(page, question) {
  const before = await page.locator("article.answer").count();
  await page.getByLabel("输入问题").fill(question);
  await page.getByLabel("输入问题").press("Enter");
  await answerOf(page, before).waitFor({ timeout: 60000 });
  return answerOf(page, before);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function signIn(page, name) {
  await page.goto(`${BASE}login`);
  await page.locator("button.account", { hasText: name }).click();
  await page.getByLabel("输入问题").waitFor();
}

async function walk(width, height, scheme) {
  const tag = `${width}-${scheme}`;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: width < 500 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  const shot = (name) => page.screenshot({ path: join(OUT, `${tag}-${name}.png`), fullPage: false });

  // intro
  await page.goto(BASE);
  await page.getByRole("link", { name: /进入控制台/ }).first().waitFor();
  check(`${tag} intro says what answers`, (await page.locator(".provenance").innerText()).includes("当场回答"));
  check(`${tag} intro has no side scroll`, await noSideScroll(page));
  await shot("intro");
  await page.getByRole("link", { name: /进入控制台/ }).first().click();
  await page.locator("button.account", { hasText: "Leon" }).click();
  await page.getByLabel("输入问题").waitFor();

  // main task: a typed question, answered in the browser
  check(`${tag} welcome lists live and recorded`, (await page.locator(".welcome").innerText()).includes("当场回答") && (await page.locator(".welcome").innerText()).includes("录制回放"));
  await shot("welcome");
  let card = await ask(page, "上个月华东区复购率是多少？");
  let text = await card.innerText();
  check(`${tag} answer labelled as the browser engine`, text.includes("浏览器当场回答"));
  check(`${tag} answer has the number`, text.includes("17.9%"), text.slice(0, 120));
  check(`${tag} numbers verified`, text.includes("可核对") || (await card.locator(".num-link, [aria-label*='一致']").count()) > 0);
  await shot("answer");

  // every number links to its query, row and column, and replays for real
  const number = card.locator("[aria-label^='17.9%']").first();
  if (width < 500) {
    await number.tap(); // first tap lights the path
    await number.tap(); // second tap opens the evidence
  } else {
    await number.click();
  }
  const drawer = page.locator(".drawer");
  await drawer.waitFor();
  let drawerText = await drawer.innerText();
  check(`${tag} provenance names the cell`, drawerText.includes("复购率") && drawerText.includes("第 0 行"), drawerText.slice(0, 200));
  await drawer.getByRole("button", { name: /重新执行并比对/ }).click();
  await drawer.getByText("这个数字可以复现").waitFor({ timeout: 10000 });
  check(`${tag} replay re-executes and matches`, true);
  await shot("provenance");
  await page.keyboard.press("Escape");
  if (await drawer.isVisible()) await drawer.getByRole("button").first().click();

  // follow-up, then a clarification answered in words
  card = await ask(page, "那华南呢");
  text = await card.innerText();
  check(`${tag} follow-up keeps metric and period`, text.includes("华南") && text.includes("复购率") && text.includes("2026-09-01"), text.slice(0, 120));
  card = await ask(page, "上个月华东的销售额");
  check(`${tag} ambiguous word asks`, (await card.innerText()).includes("不同口径"));
  card = await ask(page, "按净销售额");
  text = await card.innerText();
  check(`${tag} clarified in words keeps the question`, text.includes("净销售额") && text.includes("华东"), text.slice(0, 120));
  card = await ask(page, "上个月销售额是多少");
  await card.locator(".clarify-option").first().click();
  await answerOf(page, (await page.locator("article.answer").count()) - 1).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("article.answer").length > 0 && [...document.querySelectorAll("article.answer")].at(-1).innerText.includes("已确认"), null, { timeout: 15000 });
  check(`${tag} clarified by button`, true);

  // refusal with a next step that really works
  card = await ask(page, "上个月华东新客的GMV");
  text = await card.innerText();
  check(`${tag} unknown word refused and named`, text.includes("新客") && text.includes("已拒答"), text.slice(0, 160));
  await shot("refusal");
  const count = await page.locator("article.answer").count();
  await card.locator(".next-steps .chip").first().click();
  await answerOf(page, count).waitFor({ timeout: 15000 });
  check(`${tag} next step answers`, (await answerOf(page, count).innerText()).includes("13.36"), (await answerOf(page, count).innerText()).slice(0, 120));

  // pasted SQL goes through the guard
  card = await ask(page, "SELECT phone FROM customers");
  text = await card.innerText();
  check(`${tag} unsafe SQL refused`, text.includes("安全校验") && text.includes("敏感"), text.slice(0, 160));
  card = await ask(page, "SELECT region_id, COUNT(*) AS n FROM orders GROUP BY region_id");
  check(`${tag} safe SQL returns a table`, (await card.locator("table").count()) > 0);

  // recordings keep their label, and an unmatched number stays red
  const chip = page.locator(".replay-chips .chip", { hasText: "数字被改错" });
  const n2 = await page.locator("article.answer").count();
  await chip.click();
  await answerOf(page, n2).waitFor({ timeout: 20000 });
  text = await answerOf(page, n2).innerText();
  check(`${tag} recording labelled`, text.includes("录制回放"), text.slice(0, 100));
  check(`${tag} unmatched number flagged`, text.includes("找不到") || text.includes("标红"), text.slice(0, 200));
  await shot("recording");

  // every tab
  const go = async (label, short) => {
    if (width < 500) await page.locator(".strip-link", { hasText: short }).click();
    else await page.locator(".rail-link", { hasText: label }).click();
  };
  await go("语义层", "语义层");
  await page.getByRole("heading", { name: /语义层/ }).first().waitFor();
  check(`${tag} semantic page has no side scroll`, await noSideScroll(page));
  await shot("semantic");
  await go("链路追踪", "链路");
  await page.getByRole("heading", { name: "链路追踪" }).waitFor();
  await page.locator("table tbody tr").first().waitFor();
  const liveRow = page.locator("table tbody tr", { hasText: "上个月华东新客的GMV" }).first();
  await liveRow.waitFor({ timeout: 10000 });
  check(`${tag} live runs are in the trace list`, true);
  await liveRow.click();
  await page.getByText("问题解析").first().waitFor({ timeout: 10000 });
  check(`${tag} a live run opens its trace`, (await page.locator(".page").first().innerText()).includes("新客"));
  await shot("trace");
  await go("评测报告", "评测");
  await page.getByText("第一次运行").first().waitFor({ timeout: 10000 });
  const evalText = await page.locator(".page").first().innerText();
  check(`${tag} blind first run is shown with its commit`, evalText.includes("a270971") && evalText.includes("108/130"), evalText.slice(0, 200));
  check(`${tag} evals page has no side scroll`, await noSideScroll(page));
  await shot("evals");

  // another identity: row-level security
  await page.evaluate(() => localStorage.removeItem("proofbi.token"));
  await signIn(page, "Mia");
  card = await ask(page, "华南区上个月 GMV 是多少？");
  text = await card.innerText();
  check(`${tag} Mia refused outside her scope`, text.includes("超出数据权限"), text.slice(0, 120));
  card = await ask(page, "上个月的GMV");
  text = await card.innerText();
  check(`${tag} Mia answered inside her scope`, text.includes("数据范围：华东") && text.includes("13.36"), text.slice(0, 160));
  await card.getByRole("button", { name: /q1/ }).click();
  await drawer.waitFor();
  drawerText = await drawer.innerText();
  check(`${tag} executed SQL shows the row policy`, drawerText.includes("region_id IN ('east')"));
  await shot("policy");
  if (await drawer.isVisible()) await page.keyboard.press("Escape");
  if (await drawer.isVisible()) await drawer.getByRole("button").first().click();
  card = await ask(page, "全公司上个月的GMV");
  check(`${tag} whole company refused for a scoped identity`, (await card.innerText()).includes("超出数据权限"));

  check(`${tag} no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

async function failurePath() {
  // the engine cannot load: the visitor is told, recordings still work, a retry works
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let blocked = true;
  await page.route("**/engine/warehouse.sqlite.gz", (route) => (blocked ? route.abort() : route.continue()));
  await signIn(page, "Leon");
  await page.getByLabel("输入问题").fill("上个月的GMV");
  await page.getByLabel("输入问题").press("Enter");
  await page.getByText("没有加载成功").first().waitFor({ timeout: 20000 });
  check("failure: engine failure is explained", true);
  await page.locator(".suggestion, .chip", { hasText: "哪个区域上个月 GMV 最高" }).last().click(); // the last one is the recording
  await page.locator("article.answer").first().waitFor({ timeout: 20000 });
  check("failure: recordings still answer", (await page.locator("article.answer").first().innerText()).includes("录制回放"));
  blocked = false;
  const card = await ask(page, "上个月的GMV");
  check("failure: asking again retries and answers", (await card.innerText()).includes("46.78"));
  await context.close();

  // no WebAssembly at all
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await c2.newPage();
  await p2.addInitScript(() => { delete globalThis.WebAssembly; });
  await signIn(p2, "Leon");
  await p2.getByLabel("输入问题").fill("上个月的GMV");
  await p2.getByLabel("输入问题").press("Enter");
  await p2.getByText("不支持 WebAssembly").first().waitFor({ timeout: 20000 });
  check("failure: a browser without WebAssembly is told so", true);
  await c2.close();
}

async function measure() {
  // cold cache, a 10 Mbps / 40 ms connection, 4x slower CPU for the phone profile
  const out = {};
  for (const [name, cpu, width] of [["desktop", 1, 1280], ["phone", 4, 375]]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const sizes = {};
    cdp.on("Network.loadingFinished", (e) => { sizes[e.requestId] = e.encodedDataLength; });
    const urls = {};
    cdp.on("Network.responseReceived", (e) => { urls[e.requestId] = e.response.url; });
    await signIn(page, "Leon");
    const beforeAsk = new Set(Object.keys(urls));
    const started = Date.now();
    await page.locator(".suggestion", { hasText: "上个月各区域复购率同比" }).first().click();
    await page.locator("article.answer").first().waitFor({ timeout: 120000 });
    const first = Date.now() - started;
    const engineFiles = Object.entries(urls).filter(([id]) => !beforeAsk.has(id)).map(([id, url]) => ({ file: url.split("/").pop(), bytes: sizes[id] ?? 0 }));
    const t2 = Date.now();
    await ask(page, "上个月各门店的客单价");
    const second = Date.now() - t2;
    out[name] = { first_answer_ms: first, next_answer_ms: second, engine_download_bytes: engineFiles.reduce((s, f) => s + f.bytes, 0), files: engineFiles, cpu_throttle: cpu };
    await context.close();
  }
  writeFileSync(join(OUT, "measure.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

try {
  for (const [w, h] of [[1280, 800], [375, 812]]) for (const scheme of ["light", "dark"]) await walk(w, h, scheme);
  await failurePath();
  await measure();
} catch (e) {
  failures.push(`stopped: ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length ? 1 : 0);
