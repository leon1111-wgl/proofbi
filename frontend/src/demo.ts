/* Static demo (`vite build --mode demo`, served by GitHub Pages).
 *
 * There is no backend. A typed question is answered on the spot by the browser engine in
 * ./engine: the rules planner ported to TypeScript, over the SYNTHETIC warehouse in SQLite WASM.
 * The listed questions replay what scripts/record_demo.py recorded from the real API with the
 * offline rules model; GET responses for those runs come from the same recording. Each answer
 * says which of the two produced it. Conversations and live runs exist only in this tab's memory;
 * nothing is written anywhere. */
import { ApiError, getToken } from "./api";
import type { Conversation as EngineConversation } from "./engine/understand";
import type { Engine } from "./engine/pipeline";
import type { Conversation, RunPayload, StepEvent, User } from "./types";

const ROOT = `${import.meta.env.BASE_URL}demo/`;
const TOKEN_PREFIX = "demo:";

export interface DemoIndex {
  users: User[];
  model: string;
  planner: string;
  dataset: { name: string; fingerprint: string; total_rows: number; date_start: string; date_end: string };
  recorded_at: string;
}

export interface RecordedAsk {
  question: string;
  tag: string;
  fault: string | null;
  clarifications: Record<string, string>;
  steps: StepEvent[];
  result: RunPayload;
  follow_up?: boolean;
}

const files = new Map<string, Promise<unknown>>();

function load<T>(file: string): Promise<T> {
  let pending = files.get(file);
  if (!pending) {
    pending = fetch(ROOT + file).then((res) => {
      // dev servers and SPA fallbacks answer a missing file with index.html and status 200
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
        throw new ApiError(404, "静态演示没有录制这个请求。完整功能请按 README 在本地运行。");
      }
      return res.json();
    });
    pending.catch(() => files.delete(file));
    files.set(file, pending);
  }
  return pending as Promise<T>;
}

export const demoIndex = () => load<DemoIndex>("index.json");

function currentUser(): string {
  const token = getToken();
  if (!token?.startsWith(TOKEN_PREFIX)) throw new ApiError(401, "请先选择一个演示身份");
  return token.slice(TOKEN_PREFIX.length);
}

/** Recorded questions for the signed-in identity, in recording order. */
export const recordedAsks = () => load<RecordedAsk[]>(`${currentUser()}/asks.json`);

// ---------------------------------------------------------------- in-memory conversations
interface MemoryConversation extends Conversation {
  runs: RunPayload[];
  state: EngineConversation;
}
const conversations = new Map<string, MemoryConversation[]>();
let nextConversationId = 1;

function userConversations(username: string): MemoryConversation[] {
  if (!conversations.has(username)) conversations.set(username, []);
  return conversations.get(username)!;
}

function findConversation(username: string, id: number): MemoryConversation {
  const found = userConversations(username).find((c) => c.id === id);
  if (!found) throw new ApiError(404, "这段对话只存在于刷新之前的页面内存中（静态演示不保存对话），已为你开始新对话");
  return found;
}

/** The conversation to append to; one lost to a page reload starts a new one instead of failing. */
function openConversation(username: string, id: number | null | undefined, title: string): MemoryConversation {
  const list = userConversations(username);
  const found = id != null ? list.find((c) => c.id === id) : undefined;
  if (found) return found;
  const convo: MemoryConversation = { id: nextConversationId++, title: title.slice(0, 60), updated_at: new Date().toISOString(), runs: [], state: { lastPlan: null, pending: null } };
  list.push(convo);
  return convo;
}

// ---------------------------------------------------------------- the browser engine
export interface EngineState { phase: "idle" | "loading" | "ready" | "failed"; percent: number; ms: number | null; downloadBytes: number | null; error: string | null }
let engineState: EngineState = { phase: "idle", percent: 0, ms: null, downloadBytes: null, error: null };
const engineListeners = new Set<(s: EngineState) => void>();
function setEngineState(next: Partial<EngineState>) {
  engineState = { ...engineState, ...next };
  engineListeners.forEach((f) => f(engineState));
}
export const currentEngineState = () => engineState;
export function onEngineState(f: (s: EngineState) => void): () => void {
  engineListeners.add(f);
  return () => engineListeners.delete(f);
}

// Only the demo build carries the engine and its wasm: the bundler drops this import from the normal build.
const engineModule = import.meta.env.VITE_DEMO === "1" ? () => import("./engine/load") : null;

let liveEngine: Engine | null = null;
let onLoadProgress: ((percent: number) => void) | null = null;

/** Opens the engine once for the tab. Failure is reported, and the recordings keep working without it. */
export async function warmEngine(): Promise<Engine> {
  if (liveEngine) return liveEngine;
  if (!engineModule) throw new ApiError(405, "完整服务不使用浏览器引擎");
  setEngineState({ phase: "loading", error: null });
  try {
    const { loadEngine } = await engineModule();
    const { engine, info } = await loadEngine(ROOT.replace(/demo\/$/, ""), (p) => {
      const percent = Math.min(100, Math.round((p.loaded / p.total) * 100));
      setEngineState({ percent });
      onLoadProgress?.(percent);
    });
    liveEngine = engine;
    setEngineState({ phase: "ready", percent: 100, ms: info.ms, downloadBytes: info.gzip_bytes });
    return engine;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setEngineState({ phase: "failed", error: message });
    throw new ApiError(503, `浏览器引擎没有加载成功：${message}。录制回放不受影响，可以点上方列出的问题；再次提问会重试。`);
  }
}

const MEMORY_ONLY = "没有找到这条记录。浏览器当场回答的记录只保存在这个标签页，刷新后就没有了；录制的记录不受影响。";

// ---------------------------------------------------------------- API surface used by api.ts
export async function demoGet<T>(path: string): Promise<T> {
  if (path === "/api/auth/demo-users") return { users: (await demoIndex()).users, password: null } as T;
  const username = currentUser();
  if (path === "/api/conversations") {
    return [...userConversations(username)]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ id, title, updated_at }) => ({ id, title, updated_at })) as T;
  }
  const convo = path.match(/^\/api\/conversations\/(\d+)$/);
  if (convo) {
    const c = findConversation(username, Number(convo[1]));
    return { id: c.id, title: c.title, runs: c.runs } as T;
  }
  // a run the browser engine produced lives in memory, for this identity only
  const liveTrace = path.match(/^\/api\/traces\/(r_\w+)$/);
  if (liveTrace && liveEngine?.runs.get(liveTrace[1])?.username === username) return liveEngine.trace(liveTrace[1]) as T;
  const liveQuery = path.match(/^\/api\/queries\/(q_\w+)$/);
  if (liveQuery && liveEngine?.queries.get(liveQuery[1])?.run.username === username) return liveEngine.query(liveQuery[1]) as T;
  const list = path.match(/^\/api\/traces(?:\?source=(\w+))?$/);
  // mirrors file_for() in scripts/record_demo.py
  const recorded = () => load<T>(`${username}/${path.replace(/^\//, "").replace("?", "@")}.json`);
  if (list && liveEngine && (!list[1] || list[1] === "chat")) {
    const live = [...liveEngine.runs.values()].filter((r) => r.username === username).map((r) => liveEngine!.summary(r)).reverse();
    return [...live, ...((await recorded()) as unknown[])] as T;
  }
  if (liveTrace || liveQuery) {
    return recorded().catch(() => {
      throw new ApiError(404, MEMORY_ONLY);
    });
  }
  return recorded();
}

export async function demoPost<T>(path: string, body?: unknown): Promise<T> {
  if (path === "/api/auth/login") {
    const { username } = (body ?? {}) as { username?: string };
    const user = (await demoIndex()).users.find((u) => u.username === username);
    if (!user) throw new ApiError(401, "静态演示只提供页面上列出的演示身份");
    return { token: TOKEN_PREFIX + user.username, user } as T;
  }
  const replay = path.match(/^\/api\/queries\/([\w-]+)\/replay$/);
  if (replay && liveEngine?.queries.get(replay[1])?.run.username === currentUser()) {
    const { userOf } = await engineModule!();
    return (await liveEngine.replay(replay[1], userOf(currentUser()))) as T;
  }
  if (replay) return load<T>(`${currentUser()}/api/queries/${replay[1]}/replay.json`);
  if (path === "/api/evals/run") {
    throw new ApiError(409, "静态演示不能重新运行评测。完整服务里管理员可以在这里触发；CI 每次提交都会运行同一套评测。");
  }
  throw new ApiError(405, "静态演示不支持这个操作，完整功能请按 README 在本地运行。");
}

const normalize = (q: string) => q.trim().replace(/\s+/g, " ");
const sameChoices = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

type StreamEvent = { type: "started"; conversation_id: number } | StepEvent | { type: "result"; result: RunPayload };
type AskBody = { question: string; conversation_id?: number | null; clarifications?: Record<string, string>; fault?: string | null; recording?: boolean };

/** A listed question replays its recording with the same events the real SSE stream sends. */
async function replayRecording(body: AskBody, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const username = currentUser();
  const asks = await recordedAsks();
  const recorded = asks.find(
    (a) => normalize(a.question) === normalize(body.question) && (a.fault ?? null) === (body.fault ?? null) && sameChoices(a.clarifications, body.clarifications),
  );
  if (!recorded) throw new ApiError(404, "这个问题没有录制。直接输入它，浏览器会当场回答。");
  const convo = openConversation(username, body.conversation_id, body.question);
  onEvent({ type: "started", conversation_id: convo.id });
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const step of recorded.steps) {
    await wait(reduced ? 0 : 180, signal);
    onEvent(step);
  }
  const now = new Date().toISOString();
  const result: RunPayload = { ...recorded.result, conversation_id: convo.id, created_at: now, engine: "recording" };
  convo.runs.push(result);
  convo.updated_at = now;
  // a follow-up typed after a replay continues from what was replayed
  if (result.status === "answered" && result.plan) convo.state = { lastPlan: result.plan as unknown as EngineConversation["lastPlan"], pending: null };
  if (result.status === "clarify" && result.clarification) {
    convo.state.pending = { question: result.question, term: result.clarification.term, options: result.clarification.options.map((o) => o.value), clarifications: {} };
  }
  onEvent({ type: "result", result });
}

/** A typed question is answered on the spot in this tab. */
async function answerLive(body: AskBody, onEvent: (event: StreamEvent) => void): Promise<void> {
  const username = currentUser();
  const convo = openConversation(username, body.conversation_id, body.question);
  onEvent({ type: "started", conversation_id: convo.id });
  const loadStep = (percent: number): StepEvent => ({ type: "step", step: "load", status: "running", title: `第一次提问：下载 SQLite WASM 和 SYNTHETIC 仓库（约 2 MB）${percent}%` });
  if (!liveEngine) {
    onEvent(loadStep(engineState.percent));
    onLoadProgress = (p) => onEvent(loadStep(p));
  }
  let engine: Engine;
  try {
    engine = await warmEngine();
  } finally {
    onLoadProgress = null;
  }
  const { userOf } = await engineModule!();
  for await (const event of engine.ask({ question: body.question, user: userOf(username), convo: convo.state, clarifications: body.clarifications, conversationId: convo.id })) {
    if (event.type === "step") onEvent(event as StepEvent);
    else {
      const result = event.result as unknown as RunPayload;
      const now = new Date().toISOString();
      convo.runs.push(result);
      convo.updated_at = now;
      onEvent({ type: "result", result });
    }
  }
}

export async function demoAskStream(body: AskBody, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  return body.recording || body.fault ? replayRecording(body, onEvent, signal) : answerLive(body, onEvent);
}
