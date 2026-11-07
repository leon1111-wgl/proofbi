/* Browser-only loader: fetches the warehouse, checks it, opens the engine once for the whole tab. */
import { Engine } from "./pipeline";
import { Warehouse, sha256 } from "./warehouse";

export interface LoadProgress { phase: "download" | "open"; loaded: number; total: number }
export interface LoadedInfo { ms: number; gzip_bytes: number; sqlite_bytes: number; sqlite_sha256: string }

let pending: Promise<{ engine: Engine; info: LoadedInfo }> | null = null;

async function readGzipped(url: string, total: number, onProgress?: (p: LoadProgress) => void): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("这个浏览器不支持 DecompressionStream，无法在本地解压演示数据");
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载演示数据失败（HTTP ${res.status}）`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ phase: "download", loaded, total });
  }
  const packed = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { packed.set(c, at); at += c.length; }
  // A host may already have removed the gzip layer in transit.
  if (packed[0] !== 0x1f || packed[1] !== 0x8b) return packed;
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function loadEngine(base: string, onProgress?: (p: LoadProgress) => void): Promise<{ engine: Engine; info: LoadedInfo }> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof WebAssembly === "undefined") throw new Error("这个浏览器不支持 WebAssembly");
    const started = performance.now();
    const metaRes = await fetch(`${base}engine/warehouse.json`);
    if (!metaRes.ok) throw new Error(`下载演示数据失败（HTTP ${metaRes.status}）`);
    const meta = (await metaRes.json()) as Omit<LoadedInfo, "ms">;
    const bytes = await readGzipped(`${base}engine/warehouse.sqlite.gz`, meta.gzip_bytes, onProgress);
    onProgress?.({ phase: "open", loaded: meta.gzip_bytes, total: meta.gzip_bytes });
    if ((await sha256(bytes)) !== meta.sqlite_sha256) throw new Error("演示数据的指纹和构建时不一致，已停止");
    const warehouse = await Warehouse.open(bytes);
    return { engine: new Engine(warehouse), info: { ...meta, ms: Math.round(performance.now() - started) } };
  })();
  pending.catch(() => { pending = null; }); // a failed download can be retried by asking again
  return pending;
}
