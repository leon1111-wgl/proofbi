import { demoAskStream, demoGet, demoPost } from "./demo";
import type { RunPayload, StepEvent } from "./types";

/** Static GitHub Pages build: answers come from recorded responses (see demo.ts). */
export const DEMO = import.meta.env.VITE_DEMO === "1";

const TOKEN_KEY = "proofbi.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives only in memory for this tab */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function headers(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function parse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `请求失败（${res.status}）`;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg: string }) => d.msg).join("；");
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event("proofbi:logout"));
  }
  throw new ApiError(res.status, message);
}

export const api = {
  get: <T,>(path: string) => (DEMO ? demoGet<T>(path) : fetch(path, { headers: headers() }).then((r) => parse<T>(r))),
  post: <T,>(path: string, body?: unknown) =>
    DEMO
      ? demoPost<T>(path, body)
      : fetch(path, {
          method: "POST",
          headers: headers({ "Content-Type": "application/json" }),
          body: JSON.stringify(body ?? {}),
        }).then((r) => parse<T>(r)),
};

export interface AskBody {
  question: string;
  conversation_id?: number | null;
  clarifications?: Record<string, string>;
  fault?: string | null;
}

type StreamEvent = { type: "started"; conversation_id: number } | StepEvent | { type: "result"; result: RunPayload };

/** POST + Server-Sent Events. EventSource cannot send a body or an Authorization
 * header, so the stream is read from fetch() and split on blank lines. */
export async function askStream(body: AskBody, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  if (DEMO) return demoAskStream(body, onEvent, signal);
  const res = await fetch("/api/ask/stream", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await parse(res);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
