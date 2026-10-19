import { useState } from "react";
import { CheckCircle2, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { api } from "../api";
import type { NumberCheck, ProvenanceQuery, ReplayResult } from "../types";
import { DataTable } from "./Charts";
import { ErrorBanner, SqlBlock, StatusBadge, fullTime, ms, short, useLoad } from "./ui";

/** Predicates such as region_id IN ('east') inside the policy SQL, to highlight them. */
function policyMarks(policies: Record<string, string | null>): string[] {
  const marks = new Set<string>();
  for (const p of Object.values(policies)) {
    if (!p) continue;
    for (const m of p.matchAll(/\b\w+ IN \((?:'[^']*'(?:, )?)+\)/g)) marks.add(m[0]);
  }
  return [...marks];
}

export function ProvenanceView({ queryId, focus, number }: { queryId: string; focus?: { row: number; column: string } | null; number?: NumberCheck | null }) {
  const { data: q, error } = useLoad(() => api.get<ProvenanceQuery>(`/api/queries/${queryId}`), [queryId]);
  const [tab, setTab] = useState<"executed" | "generated" | null>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  if (error) return <div className="drawer-section"><ErrorBanner error={error} /></div>;
  if (!q) return <div className="drawer-section faint">加载中…</div>;
  const focusMeta = focus ? q.column_meta.find((m) => m.key === focus.column) : undefined;
  const failed = q.attempts.filter((a) => a.status !== "ok");
  const restricted = Object.values(q.policies).some(Boolean);
  // with a row policy the executed SQL is the interesting one; without, the checked SQL is easier to read
  const shown = tab ?? (restricted ? "executed" : "generated");

  const doReplay = async () => {
    setReplaying(true);
    setReplayError(null);
    try {
      setReplay(await api.post<ReplayResult>(`/api/queries/${queryId}/replay`));
    } catch (e) {
      setReplayError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplaying(false);
    }
  };

  return (
    <>
      <div className="drawer-section">
        <div className="section-title">这个数字来自</div>
        <dl className="kv">
          <dt>问题</dt>
          <dd>{q.question}</dd>
          <dt>查询</dt>
          <dd>
            <span className="mono">{q.key}</span> · {q.title} <StatusBadge status={q.status} />
          </dd>
          {focus && (
            <>
              <dt>单元格</dt>
              <dd>
                第 {focus.row} 行 · {focusMeta?.label ?? focus.column} <span className="mono faint">({focus.column})</span>
              </dd>
            </>
          )}
          {number && (
            <>
              <dt>回答中的写法</dt>
              <dd>
                <b>{number.text}</b>{" "}
                {number.status === "verified" && <span className="badge badge-success">与结果单元格一致</span>}
                {number.status === "derived" && <span className="badge badge-info">由结果单元格推算</span>}
              </dd>
            </>
          )}
          {number?.formula && (
            <>
              <dt>推算方式</dt>
              <dd>
                {number.formula}
                <div className="faint">
                  {number.refs.map((r) => `${r.label}[第 ${r.row} 行] = ${r.value}`).join("；")}
                </div>
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="drawer-section">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="tabs" style={{ flex: 1 }}>
            <button className={shown === "executed" ? "active" : ""} onClick={() => setTab("executed")}>
              实际执行的 SQL{restricted ? "（已加行级权限）" : ""}
            </button>
            <button className={shown === "generated" ? "active" : ""} onClick={() => setTab("generated")}>
              校验后的 SQL
            </button>
          </div>
        </div>
        {shown === "executed" ? (
          <SqlBlock sql={q.executed_sql ?? "（未执行）"} highlight={policyMarks(q.policies)} />
        ) : (
          <SqlBlock sql={q.sql} />
        )}
        <div className="faint" style={{ marginTop: 6 }}>
          {shown === "executed"
            ? "每个表都被替换成“只含有权限的行和字段”的策略视图，黄色是由系统加入的行级权限条件。"
            : "模型（或模板）生成后，经过安全校验和口径校验、由 AST 重新生成的 SQL。"}
        </div>
      </div>

      <div className="drawer-section">
        <div className="section-title">执行信息</div>
        <dl className="kv">
          <dt>执行时间</dt>
          <dd>{fullTime(q.executed_at)}</dd>
          <dt>耗时</dt>
          <dd>{ms(q.elapsed_ms)}</dd>
          <dt>返回行数</dt>
          <dd>
            {q.row_count} 行{q.truncated ? "（超过上限已截断）" : ""}
          </dd>
          <dt>提问人</dt>
          <dd>{q.username}</dd>
          <dt>行级权限</dt>
          <dd>
            {restricted ? (
              Object.entries(q.policies)
                .filter(([, p]) => p)
                .map(([t, p]) => (
                  <div key={t} className="mono small">
                    {t}: {p}
                  </div>
                ))
            ) : (
              <span className="muted">全部区域（管理员 / 全国权限）</span>
            )}
          </dd>
          <dt>SQL 指纹</dt>
          <dd className="mono small" title={q.sql_hash ?? ""}>sha256:{short(q.sql_hash, 16)}</dd>
          <dt>结果指纹</dt>
          <dd className="mono small" title={q.result_hash ?? ""}>sha256:{short(q.result_hash, 16)}</dd>
          <dt>数据集指纹</dt>
          <dd className="mono small" title={q.dataset_fingerprint ?? ""}>{short(q.dataset_fingerprint, 16)}（SYNTHETIC）</dd>
          <dt>尝试次数</dt>
          <dd>
            {q.attempts.length} 次
            {failed.map((a) => (
              <div key={a.id} className="faint">
                第 {a.attempt} 次 <StatusBadge status={a.status} />{" "}
                {a.error ?? a.lint.map((l) => l.message).join("；") ?? ""}
                {a.violations.map((v) => v.message).join("；")}
              </div>
            ))}
          </dd>
        </dl>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={doReplay} disabled={replaying || q.status !== "ok"}>
            <RotateCcw size={13} /> 重新执行并比对结果指纹
          </button>
          {replay &&
            (replay.match ? (
              <span className="row small" style={{ color: "var(--success)", gap: 4 }}>
                <CheckCircle2 size={14} /> 结果一致（{ms(replay.elapsed_ms)}），这个数字可以复现
              </span>
            ) : (
              <span className="row small" style={{ color: "var(--danger)", gap: 4 }}>
                <XCircle size={14} /> 结果不一致{replay.dataset_changed ? "：数据集已变化" : ""}
              </span>
            ))}
        </div>
        <ErrorBanner error={replayError} />
      </div>

      <div className="drawer-section">
        <div className="section-title">
          <ShieldCheck size={13} /> 结果行（高亮为回答引用的单元格）
        </div>
        <DataTable query={q} highlight={focus ?? null} />
      </div>
    </>
  );
}
