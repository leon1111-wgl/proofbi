import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, Play, X } from "lucide-react";
import { api } from "../api";
import { isAdmin, useAuth } from "../auth";
import { Drawer, Empty, ErrorBanner, SqlBlock, fullTime, ms, pct, useLoad } from "../components/ui";
import type { EvalCaseResult, EvalMetrics, EvalRunInfo } from "../types";

const CATEGORY: Record<string, string> = { answer: "回答", clarify: "澄清", refusal: "拒答", security: "安全" };
const CHECK: Record<string, string> = {
  answered: "已回答",
  caliber: "口径",
  execution: "结果一致",
  numbers_verified: "数字核对",
  scope: "权限范围",
  clarified: "澄清",
  refused: "拒答",
  reason: "拒答原因",
};

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function CaseDrawer({ result, onClose }: { result: EvalCaseResult; onClose: () => void }) {
  const e = result.expected;
  const a = result.actual;
  return (
    <Drawer
      title={
        <div>
          <b>{result.case_id}</b> <span className={`badge ${result.passed ? "badge-success" : "badge-danger"}`}>{result.passed ? "通过" : "未通过"}</span>
        </div>
      }
      onClose={onClose}
    >
      <div className="drawer-section">
        <dl className="kv">
          <dt>问题</dt>
          <dd>{result.question}</dd>
          <dt>提问人</dt>
          <dd>{result.user}</dd>
          <dt>类别</dt>
          <dd>
            {CATEGORY[result.category]} · {result.split}
          </dd>
          {e.context && (
            <>
              <dt>上一问</dt>
              <dd>{e.context}</dd>
            </>
          )}
          {e.fault && (
            <>
              <dt>注入故障</dt>
              <dd className="mono">{e.fault}</dd>
            </>
          )}
          {e.note && (
            <>
              <dt>说明</dt>
              <dd>{e.note}</dd>
            </>
          )}
          <dt>检查项</dt>
          <dd className="row row-wrap" style={{ gap: 4 }}>
            {Object.entries(result.checks).map(([k, ok]) => (
              <span key={k} className={`badge ${ok ? "badge-success" : "badge-danger"}`}>
                {ok ? <Check size={11} /> : <X size={11} />}
                {CHECK[k] ?? k}
              </span>
            ))}
          </dd>
        </dl>
      </div>
      <div className="drawer-section">
        <div className="section-title">期望</div>
        <dl className="kv">
          {e.metrics.length > 0 && (
            <>
              <dt>指标</dt>
              <dd className="mono">{e.metrics.join(", ")}</dd>
            </>
          )}
          {e.term && (
            <>
              <dt>澄清词</dt>
              <dd>{e.term}</dd>
            </>
          )}
          {e.reason.length > 0 && (
            <>
              <dt>拒答原因</dt>
              <dd className="mono">{e.reason.join(" / ")}</dd>
            </>
          )}
          {Object.keys(e.allowed_values).length > 0 && (
            <>
              <dt>允许出现</dt>
              <dd>{Object.entries(e.allowed_values).map(([k, v]) => `${k}: ${v.join("、")}`).join("；")}</dd>
            </>
          )}
        </dl>
        {e.gold_sql.map((sql, i) => (
          <div key={i} style={{ marginTop: 8 }}>
            <div className="faint" style={{ marginBottom: 4 }}>标准 SQL（人工编写，与编译器独立）</div>
            <SqlBlock sql={sql.trim()} />
          </div>
        ))}
      </div>
      <div className="drawer-section">
        <div className="section-title">
          实际
          <span className="spacer" />
          {result.run_id && <Link to={`/traces/${result.run_id}`}>查看链路</Link>}
        </div>
        <dl className="kv">
          <dt>状态</dt>
          <dd>{a.status}</dd>
          {a.metrics && (
            <>
              <dt>指标</dt>
              <dd className="mono">{a.metrics.join(", ")}</dd>
            </>
          )}
          {a.answer && (
            <>
              <dt>回答</dt>
              <dd>{a.answer}</dd>
            </>
          )}
          {a.refusal && (
            <>
              <dt>拒答</dt>
              <dd>
                {a.refusal.reason}：{a.refusal.message}
              </dd>
            </>
          )}
          {a.clarification && (
            <>
              <dt>澄清</dt>
              <dd>{a.clarification.question}</dd>
            </>
          )}
          {a.execution_detail && (
            <>
              <dt>结果比对</dt>
              <dd>{a.execution_detail}</dd>
            </>
          )}
          <dt>自我纠错</dt>
          <dd>{a.corrections} 次</dd>
        </dl>
        {a.sql.filter(Boolean).map((sql, i) => (
          <div key={i} style={{ marginTop: 8 }}>
            <div className="faint" style={{ marginBottom: 4 }}>生成的 SQL</div>
            <SqlBlock sql={sql!} />
          </div>
        ))}
      </div>
    </Drawer>
  );
}

function SplitRow({ name, m }: { name: string; m: EvalMetrics }) {
  return (
    <tr>
      <td>
        <b>{name === "dev" ? "开发集 dev" : "留出集 holdout"}</b>
        <div className="faint">{name === "dev" ? "构建规则时使用，作为回归门禁" : "规则冻结后编写，从未用来调规则"}</div>
      </td>
      <td className="num">
        {m.passed}/{m.total}
      </td>
      <td className="num">{pct(m.pass_rate)}</td>
      <td className="num">{pct(m.execution_accuracy)}</td>
      <td className="num">{pct(m.caliber_accuracy)}</td>
      <td className="num">{pct(m.refusal_accuracy)}</td>
      <td className="num">{pct(m.false_refusal_rate)}</td>
    </tr>
  );
}

export default function EvalsPage() {
  const { user } = useAuth();
  const runs = useLoad(() => api.get<EvalRunInfo[]>("/api/evals/runs"), []);
  const latest = runs.data?.[0];
  const detail = useLoad(
    () => (latest ? api.get<EvalRunInfo & { results: EvalCaseResult[] }>(`/api/evals/runs/${latest.id}`) : Promise.resolve(null)),
    [latest?.id],
  );
  const [filter, setFilter] = useState<"all" | "failed" | "dev" | "holdout">("all");
  const [open, setOpen] = useState<EvalCaseResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.post("/api/evals/run");
      await runs.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const m = latest?.metrics;
  const results = (detail.data?.results ?? []).filter((r) =>
    filter === "all" ? true : filter === "failed" ? !r.passed : r.split === filter,
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>评测报告</h1>
          <p>
            每个问题都跑完整链路（同一个规划器、安全校验、口径校验、行级权限和执行器），再和人工编写的标准 SQL 的结果集比对。CI 中运行
            <span className="mono"> python -m app.evals.cli --gate 0.9 --gate-dev 1.0</span>，安全用例一票否决。
          </p>
        </div>
        {isAdmin(user) && (
          <button className="btn btn-primary" onClick={runNow} disabled={running}>
            <Play size={14} /> {running ? "运行中…" : "重新运行评测"}
          </button>
        )}
      </div>
      <div className="notice" style={{ marginBottom: 16 }}>
        <AlertTriangle size={14} />
        <span>
          这些数字来自<b>离线确定性模型（规则解析 + 模板 SQL）</b>和 <b>SYNTHETIC 数据</b>，只能说明“流程按设计工作”：口径对、权限没漏、拒答该拒的。
          它们<b>不代表大模型的效果</b>；接入混元 / 豆包 / DeepSeek 后需要重新运行。
        </span>
      </div>
      <ErrorBanner error={error ?? runs.error} />
      {!latest && !runs.loading && <Empty>还没有评测记录</Empty>}
      {latest && m && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-6">
            <Kpi label="总通过率" value={pct(m.pass_rate)} sub={`${latest.passed}/${latest.total} 个问题`} />
            <Kpi label="执行准确率（EX）" value={pct(m.execution_accuracy)} sub={`结果集比对 · ${m.counts.execution} 题`} />
            <Kpi label="口径正确率" value={pct(m.caliber_accuracy)} sub={`指标与澄清 · ${m.counts.caliber} 题`} />
            <Kpi label="拒答正确率" value={pct(m.refusal_accuracy)} sub={`越权 / 超范围等 · ${m.counts.refusal} 题`} />
            <Kpi label="安全用例" value={pct(m.security_pass_rate)} sub={`注入与越权 · ${m.counts.security} 题`} />
            <Kpi label="误拒率" value={pct(m.false_refusal_rate)} sub={`应回答却拒答 · ${m.counts.answer} 题`} />
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>评测集</th>
                  <th className="num">通过</th>
                  <th className="num">通过率</th>
                  <th className="num">EX</th>
                  <th className="num">口径</th>
                  <th className="num">拒答</th>
                  <th className="num">误拒</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(m.by_split ?? {}).map(([name, sm]) => (
                  <SplitRow key={name} name={name} m={sm} />
                ))}
              </tbody>
            </table>
            <div className="faint" style={{ padding: "8px 12px", borderTop: "1px solid var(--border-2)" }}>
              运行 #{latest.id} · {fullTime(latest.created_at)} · {latest.model} · 数据集 {latest.dataset_fingerprint.slice(0, 12)} · p50 {ms(m.latency_p50_ms)} · p95{" "}
              {ms(m.latency_p95_ms)} · 自我纠错 {m.self_corrections} 次 · 用时 {ms(latest.duration_ms)}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <b>用例</b>
              <div className="segmented">
                {(
                  [
                    ["all", "全部"],
                    ["failed", `未通过（${(detail.data?.results ?? []).filter((r) => !r.passed).length}）`],
                    ["dev", "开发集"],
                    ["holdout", "留出集"],
                  ] as const
                ).map(([key, text]) => (
                  <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>结果</th>
                    <th>问题</th>
                    <th style={{ width: 70 }}>提问人</th>
                    <th style={{ width: 60 }}>类别</th>
                    <th style={{ width: 70 }}>集合</th>
                    <th>检查项</th>
                    <th className="num" style={{ width: 80 }}>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.case_id} className="clickable" onClick={() => setOpen(r)}>
                      <td>
                        <span className={`badge ${r.passed ? "badge-success" : "badge-danger"}`}>{r.passed ? "通过" : "未通过"}</span>
                      </td>
                      <td>
                        <div>{r.question}</div>
                        <div className="mono faint">{r.case_id}</div>
                      </td>
                      <td>{r.user}</td>
                      <td>{CATEGORY[r.category]}</td>
                      <td className="faint">{r.split}</td>
                      <td>
                        <div className="row row-wrap" style={{ gap: 4 }}>
                          {Object.entries(r.checks).map(([k, ok]) => (
                            <span key={k} className={`badge ${ok ? "" : "badge-danger"}`}>
                              {ok ? <Check size={11} /> : <X size={11} />}
                              {CHECK[k] ?? k}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="num">{ms(r.latency_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {open && <CaseDrawer result={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
