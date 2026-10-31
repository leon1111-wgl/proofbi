/* Static demo (`vite build --mode demo`, served by GitHub Pages).
 *
 * There is no backend: every GET returns a response recorded by scripts/record_demo.py,
 * which ran the real API with the offline rules model on the SYNTHETIC warehouse. Asking
 * replays one of the recorded questions step by step. Conversations exist only in this
 * tab's memory; nothing is written anywhere. */
import { ApiError, getToken } from "./api";
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
      if (!res.ok) throw new ApiError(404, "静态演示没有录制这个请求。完整功能请按 README 在本地运行。");
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
}
const conversations = new Map<string, MemoryConversation[]>();
let nextConversationId = 1;

function userConversations(username: string): MemoryConversation[] {
  if (!conversations.has(username)) conversations.set(username, []);
  return conversations.get(username)!;
}

function openConversation(username: string, id: number | null | undefined, title: string): MemoryConversation {
  const list = userConversations(username);
  const found = id != null ? list.find((c) => c.id === id) : undefined;
  if (id != null && !found) throw new ApiError(404, "这段对话只存在于刷新之前的页面内存中（静态演示不保存对话）");
  if (found) return found;
  const convo = { id: nextConversationId++, title: title.slice(0, 60), updated_at: new Date().toISOString(), runs: [] };
  list.push(convo);
  return convo;
}

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
    const c = openConversation(username, Number(convo[1]), "");
    return { id: c.id, title: c.title, runs: c.runs } as T;
  }
  // mirrors file_for() in scripts/record_demo.py
  return load<T>(`${username}/${path.replace(/^\//, "").replace("?", "@")}.json`);
}

export async function demoPost<T>(path: string, body?: unknown): Promise<T> {
  if (path === "/api/auth/login") {
    const { username } = (body ?? {}) as { username?: string };
    const user = (await demoIndex()).users.find((u) => u.username === username);
    if (!user) throw new ApiError(401, "静态演示只提供页面上列出的演示身份");
    return { token: TOKEN_PREFIX + user.username, user } as T;
  }
  const replay = path.match(/^\/api\/queries\/([\w-]+)\/replay$/);
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

/** Replays a recorded question with the same events the real SSE stream sends. */
export async function demoAskStream(
  body: { question: string; conversation_id?: number | null; clarifications?: Record<string, string>; fault?: string | null },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const username = currentUser();
  const asks = await recordedAsks();
  const recorded = asks.find(
    (a) => normalize(a.question) === normalize(body.question) && (a.fault ?? null) === (body.fault ?? null) && sameChoices(a.clarifications, body.clarifications),
  );
  if (!recorded) {
    throw new ApiError(404, "静态演示只能回放录制好的问题（输入框上方可选）。想自由提问，请按 README 在本地运行完整服务。");
  }
  const convo = openConversation(username, body.conversation_id, body.question);
  onEvent({ type: "started", conversation_id: convo.id });
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const step of recorded.steps) {
    await wait(reduced ? 0 : 180, signal);
    onEvent(step);
  }
  const now = new Date().toISOString();
  const result: RunPayload = { ...recorded.result, conversation_id: convo.id, created_at: now };
  convo.runs.push(result);
  convo.updated_at = now;
  onEvent({ type: "result", result });
}
