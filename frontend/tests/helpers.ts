import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Engine, type Payload } from "../src/engine/pipeline";
import { userOf } from "../src/engine/pack";
import type { Conversation } from "../src/engine/understand";
import { Warehouse } from "../src/engine/warehouse";

let shared: Promise<Engine> | null = null;
export function engine(): Promise<Engine> {
  shared ??= Warehouse.open(new Uint8Array(gunzipSync(readFileSync(new URL("../public/engine/warehouse.sqlite.gz", import.meta.url))))).then((w) => new Engine(w));
  return shared;
}
export const newConvo = (): Conversation => ({ lastPlan: null, pending: null, lastResult: null, lastSplit: null });

export async function ask(username: string, question: string, convo: Conversation = newConvo(), clarifications?: Record<string, string>): Promise<Payload> {
  const e = await engine();
  let result: Payload | null = null;
  for await (const ev of e.ask({ question, user: userOf(username), convo, clarifications })) {
    if (ev.type === "result") result = ev.result;
  }
  return result!;
}
