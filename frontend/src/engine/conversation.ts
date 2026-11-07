/* What a conversation remembers about its last answer, so that "最低的那个" or "它" can resolve to a
 * concrete value. No engine dependency: replays of recordings use this too. */

export interface LastResult {
  dimension: string;
  values: string[]; // as returned
  ranked: string[]; // first place first
  best: string;
  worst: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function lastResultOf(payload: any): LastResult | null {
  if (payload?.status !== "answered" || payload.pasted_sql) return null;
  const q = payload.queries?.[0];
  if (!q) return null;
  const meta: any[] = q.column_meta ?? [];
  const dims = meta.filter((m) => m.role === "dimension");
  // a comparison has a period column too: its rows do not rank one way
  if (dims.length !== 1 || dims[0].key === "period") return null;
  const metric = meta.find((m) => m.role === "metric");
  if (!metric || !q.rows?.length) return null;
  const at = q.columns.indexOf(dims[0].key), by = q.columns.indexOf(metric.key);
  const rows = (q.rows as unknown[][]).map((r) => ({ value: String(r[at]), n: Number(r[by] ?? 0) }));
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  return {
    dimension: dims[0].key,
    values: rows.map((r) => r.value),
    ranked: (payload.plan?.order ? rows : sorted).map((r) => r.value),
    best: sorted[0].value,
    worst: sorted[sorted.length - 1].value,
  };
}
