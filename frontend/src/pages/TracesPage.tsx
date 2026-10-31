import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import { Empty, ErrorBanner, Json, SqlBlock, StatusBadge, VerdictBadge, fullTime, ms, time, useLoad } from "../components/ui";
import type { SpanView, TraceDetail, TraceSummary } from "../types";

const KIND: Record<string, string> = {
  plan: "解析",
  sql: "生成 SQL",
  guard: "安全校验",
  lint: "口径校验",
  rls: "行级权限",
  execute: "执行",
  narrate: "结论",
  verify: "数字核对",
};
const SOURCE: Record<string, string> = { chat: "对话", eval: "评测", report: "日报" };

function TraceList() {
  const navigate = useNavigate();
  const [source, setSource] = useState<string>("");
  const { data, error } = useLoad(() => api.get<TraceSummary[]>(`/api/traces${source ? `?source=${source}` : ""}`), [source]);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>链路追踪</h1>
          <p>每次提问的完整链路：问题解析、SQL 生成、安全校验、口径校验、行级权限改写、执行、结论和数字核对，每一步都有输入、输出和耗时。</p>
        </div>
        <div className="segmented">
          {[
            ["", "全部"],
            ["chat", "对话"],
            ["eval", "评测"],
            ["report", "日报"],
          ].map(([key, text]) => (
            <button key={key} className={source === key ? "active" : ""} onClick={() => setSource(key)}>
              {text}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>时间</th>
              <th style={{ width: 70 }}>用户</th>
              <th>问题</th>
              <th style={{ width: 90 }}>状态</th>
              <th style={{ width: 150 }}>数字核对</th>
              <th className="num" style={{ width: 70 }}>纠错</th>
              <th className="num" style={{ width: 80 }}>耗时</th>
              <th style={{ width: 60 }}>来源</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.run_id} className="clickable" onClick={() => navigate(`/traces/${t.run_id}`)}>
                <td className="faint nowrap">{time(t.created_at)}</td>
                <td>{t.username}</td>
                <td>
                  <div className="ellipsis" style={{ maxWidth: 520 }}>{t.question}</div>
                  <div className="faint">{t.refusal ?? t.metrics.join("、")}</div>
                </td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td>{t.status === "answered" ? <VerdictBadge verdict={t.verdict} /> : <span className="faint">—</span>}</td>
                <td className="num">{t.corrections || ""}</td>
                <td className="num">{ms(t.latency_ms)}</td>
                <td className="faint">{SOURCE[t.source] ?? t.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.length === 0 && <Empty>还没有记录</Empty>}
      </div>
    </div>
  );
}

function TraceView({ runId }: { runId: string }) {
  const { data, error } = useLoad(() => api.get<TraceDetail>(`/api/traces/${runId}`), [runId]);
  const [active, setActive] = useState<SpanView | null>(null);
  if (error) return <div className="page"><ErrorBanner error={error} /></div>;
  if (!data) return <div className="page faint">加载中…</div>;
  const total = Math.max(...data.spans.map((s) => s.start_ms + s.duration_ms), 0.01);
  const span = active ?? data.spans[0];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/traces" className="row small" style={{ gap: 4, marginBottom: 6 }}>
            <ArrowLeft size={13} /> 返回列表
          </Link>
          <h1>{data.summary.question}</h1>
          <p className="row row-wrap">
            <StatusBadge status={data.summary.status} />
            {data.summary.status === "answered" && <VerdictBadge verdict={data.summary.verdict} />}
            <span>{data.summary.username}</span>·<span>{fullTime(data.summary.created_at)}</span>·<span>总耗时 {ms(data.summary.latency_ms)}</span>·
            <span>{data.summary.model}</span>
          </p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="card">
          <div className="card-head">
            <b>步骤（{data.spans.length}）</b>
            <span className="faint">条形位置 = 开始时间，长度 = 耗时</span>
          </div>
          {data.spans.map((s) => (
            <div key={s.seq} className={`span-row ${span?.seq === s.seq ? "active" : ""}`} onClick={() => setActive(s)}>
              <span className="row" style={{ gap: 6 }}>
                <span className={`step-dot ${s.status}`} style={{ width: 9, height: 9, marginTop: 0 }} />
                <span className="small">{KIND[s.kind] ?? s.kind}</span>
              </span>
              <span className="ellipsis small">{s.name}</span>
              <span className="span-track">
                <span
                  className={`span-bar kind-${s.kind}`}
                  style={{ left: `${(s.start_ms / total) * 100}%`, width: `${Math.max(0.6, (s.duration_ms / total) * 100)}%` }}
                />
              </span>
              <span className="num-col small">{ms(s.duration_ms)}</span>
            </div>
          ))}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          {span && (
            <div className="card">
              <div className="card-head">
                <b>{span.name}</b>
                <StatusBadge status={span.status === "refused" ? "security" : span.status} />
              </div>
              <div className="card-pad stack">
                <span className="label">输入</span>
                <Json value={span.input} />
                <span className="label">输出</span>
                <Json value={span.output} />
              </div>
            </div>
          )}
          {data.attempts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <b>SQL 尝试（{data.attempts.length}）</b>
              </div>
              <div className="card-pad stack" style={{ gap: 12 }}>
                {data.attempts.map((a) => (
                  <div key={a.id} className="stack" style={{ gap: 6 }}>
                    <div className="row small">
                      <span className="mono">
                        {a.key} · 第 {a.attempt} 次
                      </span>
                      <StatusBadge status={a.status} />
                      <span className="spacer" />
                      {a.status === "ok" && <Link to={`/q/${a.id}`}>溯源</Link>}
                    </div>
                    {(a.error || a.lint.length > 0 || a.violations.length > 0) && (
                      <div className="faint">{[a.error, ...a.lint.map((l) => l.message), ...a.violations.map((v) => v.message)].filter(Boolean).join("；")}</div>
                    )}
                    <SqlBlock sql={a.sql} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TracesPage() {
  const { runId } = useParams();
  return runId ? <TraceView runId={runId} /> : <TraceList />;
}
