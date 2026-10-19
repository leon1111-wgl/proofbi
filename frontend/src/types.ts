export interface Scope {
  type: "all" | "region" | "store";
  regions: string[];
  stores: string[];
  label: string;
}

export interface User {
  username: string;
  name: string;
  title: string;
  role: string;
  permissions: string[];
  scope: Scope;
}

export interface CellRef {
  query_id: string;
  row: number;
  column: string;
  label: string;
  value: number | string | null;
}

export interface NumberCheck {
  text: string;
  start: number;
  end: number;
  value: number;
  unit: string;
  status: "verified" | "derived" | "unverified";
  ref: CellRef | null;
  refs: CellRef[];
  formula: string | null;
}

export interface Verification {
  verdict: "pass" | "fail" | "none";
  counts: { verified: number; derived: number; unverified: number };
  numbers: NumberCheck[];
}

export interface ColumnMeta {
  key: string;
  label: string;
  role: "dimension" | "metric" | "component";
  format: "currency" | "percent" | "integer" | "number" | "text";
  unit: string;
  time?: boolean;
}

export interface AttemptSummary {
  id: string;
  attempt: number;
  status: "ok" | "rejected" | "lint" | "error" | "security";
  error: string | null;
  violations: { code: string; message: string; security: boolean }[];
  lint: { code: string; message: string }[];
  notes?: string[];
  sql: string;
  key?: string;
}

export type Cell = number | string | null;

export interface QueryView {
  query_id: string;
  key: string;
  title: string;
  status: string;
  sql: string;
  executed_sql: string | null;
  columns: string[];
  column_meta: ColumnMeta[];
  rows: Cell[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  sql_hash: string | null;
  result_hash: string | null;
  executed_at: string | null;
  policies: Record<string, string | null>;
  dataset_fingerprint: string | null;
  attempts: AttemptSummary[];
}

export interface Chart {
  query_id: string;
  type: "kpi" | "compare" | "bar" | "line" | "table";
  x?: string;
  y?: string;
  series?: string;
  items?: string[];
}

export interface TimeRange {
  start: string;
  end: string;
  label: string;
  explicit: boolean;
  notes: string[];
}

export interface PlanView {
  metrics: { key: string; label: string; description: string; filter: string }[];
  dimensions: { key: string; label: string }[];
  filters: { key: string; label: string; values: string[] }[];
  time: TimeRange;
  compare: { kind: string; label: string; time: TimeRange } | null;
  order: string | null;
  limit: number | null;
  notes: string[];
  inherited: string[];
}

export interface RunPayload {
  run_id: string;
  conversation_id: number | null;
  question: string;
  username: string;
  status: "answered" | "clarify" | "refused" | "failed";
  created_at: string;
  model: string;
  latency_ms: number;
  plan: { metrics: string[]; compare: string | null } | null;
  plan_view: PlanView | null;
  scope: { type: string; label: string; restricted: boolean };
  answer: { text: string; verification: Verification; charts: Chart[] } | null;
  clarification: { term: string; question: string; options: { value: string; label: string; description: string }[] } | null;
  refusal: { reason: string; label: string; message: string; suggestions: string[] } | null;
  error: string | null;
  queries: QueryView[];
  corrections: number;
  failed_attempts: AttemptSummary[];
  fault: string | null;
  source?: string;
  usage?: Record<string, number>;
}

export interface StepEvent {
  type: "step";
  step: string;
  status: string;
  title: string;
  detail?: unknown;
}

export interface Conversation {
  id: number;
  title: string;
  updated_at: string;
}

export interface Meta {
  dataset: { name: string; fingerprint: string; total_rows: number; row_counts: Record<string, number>; date_start: string; date_end: string; seed: number };
  calendar: { today: string; data_start: string; data_end: string };
  model: string;
  planner: string;
  sql_writer: string;
  narrator: string;
  faults: Record<string, string>;
  limits: { max_rows: number; timeout_ms: number; max_corrections: number };
  wecom_configured: boolean;
}

export interface ProvenanceQuery extends QueryView {
  run_id: string;
  attempt: number;
  username: string;
  question: string | null;
  sql_generated: string;
  error: string | null;
  violations: AttemptSummary["violations"];
  lint: AttemptSummary["lint"];
  notes: string[];
  run_created_at: string | null;
}

export interface ReplayResult {
  query_id: string;
  match: boolean;
  original_hash: string;
  replay_hash: string;
  row_count: number;
  elapsed_ms: number;
  executed_at: string;
  dataset_fingerprint: string;
  dataset_changed: boolean;
}

export interface TraceSummary {
  run_id: string;
  question: string;
  username: string;
  source: string;
  status: string;
  verdict: string | null;
  corrections: number;
  latency_ms: number;
  model: string;
  created_at: string;
  conversation_id: number | null;
  metrics: string[];
  refusal: string | null;
}

export interface SpanView {
  seq: number;
  kind: string;
  name: string;
  status: string;
  start_ms: number;
  duration_ms: number;
  input: unknown;
  output: unknown;
}

export interface TraceDetail {
  summary: TraceSummary;
  payload: RunPayload;
  spans: SpanView[];
  attempts: (AttemptSummary & { key: string; executed_sql: string | null; elapsed_ms: number; row_count: number })[];
}

export interface EvalMetrics {
  total: number;
  passed: number;
  pass_rate: number;
  execution_accuracy: number | null;
  caliber_accuracy: number | null;
  refusal_accuracy: number | null;
  false_refusal_rate: number | null;
  security_pass_rate: number | null;
  number_verified_rate: number | null;
  counts: Record<string, number>;
  by_split?: Record<string, EvalMetrics>;
  by_category?: Record<string, number | null>;
  latency_p50_ms?: number;
  latency_p95_ms?: number;
  self_corrections?: number;
  failed_cases?: string[];
}

export interface EvalRunInfo {
  id: number;
  created_at: string;
  triggered_by: string;
  model: string;
  dataset_fingerprint: string;
  total: number;
  passed: number;
  metrics: EvalMetrics;
  duration_ms: number;
}

export interface EvalCaseResult {
  case_id: string;
  split: string;
  category: string;
  question: string;
  user: string;
  passed: boolean;
  checks: Record<string, boolean>;
  expected: {
    metrics: string[];
    gold_sql: string[];
    term: string | null;
    reason: string[];
    expect: string;
    allowed_values: Record<string, string[]>;
    context: string | null;
    clarifications: Record<string, string>;
    fault: string | null;
    note: string;
  };
  actual: {
    status: string;
    metrics: string[] | null;
    refusal: RunPayload["refusal"];
    clarification: RunPayload["clarification"];
    answer: string | null;
    corrections: number;
    sql: (string | null)[];
    execution_detail?: string;
    [key: string]: unknown;
  };
  run_id: string | null;
  latency_ms: number;
}

export interface SemanticCatalog {
  name: string;
  description: string;
  calendar: { today: string; data_start: string; data_end: string };
  metrics: {
    key: string;
    label: string;
    description: string;
    type: string;
    expr: string | null;
    item_expr: string | null;
    filter: string;
    format: string;
    unit: string;
    components: string[];
    synonyms: string[];
    dimensions: string[];
    requires: string | null;
    accessible: boolean;
  }[];
  dimensions: { key: string; label: string; expr: string; table: string; description: string; synonyms: string[]; values: string[]; grain: string; time_grain: string | null }[];
  tables: { name: string; alias: string; label: string; description: string; columns: { name: string; label: string; description: string; sensitive: boolean; requires: string | null; readable: boolean }[] }[];
  joins: { from: string; to: string; on: string }[];
  ambiguous_terms: Record<string, string[]>;
  policies: (User & { tables: Record<string, string> })[];
}
