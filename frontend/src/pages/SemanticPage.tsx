import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { ErrorBanner, useLoad } from "../components/ui";
import type { SemanticCatalog } from "../types";

type Tab = "metrics" | "dimensions" | "tables" | "policies";

export default function SemanticPage() {
  const { data, error } = useLoad(() => api.get<SemanticCatalog>("/api/semantic"), []);
  const [tab, setTab] = useState<Tab>("metrics");
  const label = (key: string) =>
    data?.metrics.find((m) => m.key === key)?.label ?? data?.dimensions.find((d) => d.key === key)?.label ?? key;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>语义层</h1>
          <p>
            指标口径、维度和表关联都定义在 <span className="mono">semantic/retail.yaml</span> 里。问题先映射到这里，再生成 SQL；
            模型写的 SQL 也会按这里的规则做口径校验。数据范围 {data?.calendar.data_start} 至 {data?.calendar.data_end}。
          </p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="tabs" style={{ marginBottom: 16 }}>
        {(
          [
            ["metrics", `指标（${data?.metrics.length ?? 0}）`],
            ["dimensions", `维度（${data?.dimensions.length ?? 0}）`],
            ["tables", "数据表与关联"],
            ["policies", "数据权限"],
          ] as [Tab, string][]
        ).map(([key, text]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {text}
          </button>
        ))}
      </div>

      {data && tab === "metrics" && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>指标</th>
                  <th>口径</th>
                  <th>计算表达式与过滤条件</th>
                  <th style={{ width: 220 }}>可拆分维度</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => (
                  <tr key={m.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.label}</div>
                      <div className="mono faint">{m.key}</div>
                      {m.requires && (
                        <span className={`badge ${m.accessible ? "badge-info" : "badge-warning"}`} style={{ marginTop: 4 }}>
                          <Lock size={11} /> 需要成本权限{m.accessible ? "" : "（你没有）"}
                        </span>
                      )}
                    </td>
                    <td>
                      <div>{m.description}</div>
                      <div className="faint" style={{ marginTop: 4 }}>同义词：{m.synonyms.join("、")}</div>
                    </td>
                    <td>
                      {m.type === "repurchase" ? (
                        <div className="mono small">按客户统计期内订单数，再算 ≥2 单的客户占比</div>
                      ) : (
                        <div className="mono small">{m.expr}</div>
                      )}
                      {m.item_expr && m.item_expr !== m.expr && (
                        <div className="mono small faint" style={{ marginTop: 2 }}>明细粒度：{m.item_expr}</div>
                      )}
                      <div className="mono small" style={{ marginTop: 4, color: "var(--warning)" }}>
                        WHERE {m.filter}
                      </div>
                      {m.components.length > 0 && <div className="faint" style={{ marginTop: 4 }}>同时返回：{m.components.map(label).join("、")}</div>}
                    </td>
                    <td>
                      <div className="row row-wrap" style={{ gap: 4 }}>
                        {m.dimensions.map((d) => (
                          <span key={d} className="badge">{label(d)}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card card-pad">
            <h3>有歧义的说法</h3>
            <p className="muted small" style={{ margin: "4px 0 10px" }}>这些词对应不止一个口径，ProofBI 会先问清楚，而不是替用户猜。</p>
            <div className="stack">
              {Object.entries(data.ambiguous_terms).map(([term, options]) => (
                <div key={term} className="row">
                  <span className="badge badge-info">“{term}”</span>
                  <span className="muted small">→ {options.map(label).join(" / ")}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {data && tab === "dimensions" && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>维度</th>
                <th>表达式</th>
                <th>取值</th>
                <th>同义词</th>
                <th style={{ width: 80 }}>粒度</th>
              </tr>
            </thead>
            <tbody>
              {data.dimensions.map((d) => (
                <tr key={d.key}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.label}</div>
                    <div className="mono faint">{d.key}</div>
                  </td>
                  <td>
                    <div className="mono small">{d.expr}</div>
                    {d.description && <div className="faint">{d.description}</div>}
                  </td>
                  <td className="small">{d.values.length ? d.values.join("、") : <span className="faint">来自数据</span>}</td>
                  <td className="small muted">{d.synonyms.join("、")}</td>
                  <td>
                    <span className="badge">{d.time_grain ? (d.time_grain === "month" ? "月" : "日") : d.grain === "item" ? "商品明细" : "订单"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && tab === "tables" && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card card-pad">
            <h3>关联关系（只按多对一方向）</h3>
            <p className="muted small" style={{ margin: "4px 0 10px" }}>
              编译器只沿“多 → 一”的方向 JOIN，按品类拆分 GMV 时以订单明细为基表、使用分摊后的实付，所以金额不会被重复计算。
            </p>
            <div className="stack">
              {data.joins.map((j) => (
                <div key={`${j.from}-${j.to}`} className="row small">
                  <span className="badge">{j.from}</span>→<span className="badge">{j.to}</span>
                  <span className="mono muted">{j.on}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-3">
            {data.tables.map((t) => (
              <div key={t.name} className="card">
                <div className="card-head">
                  <div>
                    <b>{t.label}</b> <span className="mono faint">{t.name} AS {t.alias}</span>
                  </div>
                </div>
                <div className="card-pad stack" style={{ gap: 4 }}>
                  {t.description && <div className="faint" style={{ marginBottom: 4 }}>{t.description}</div>}
                  {t.columns.map((c) => (
                    <div key={c.name} className="row small">
                      <span className="mono" style={{ minWidth: 120 }}>{c.name}</span>
                      <span className="muted">{c.label}</span>
                      <span className="spacer" />
                      {c.sensitive && <span className="badge badge-danger">敏感 · 不可查询</span>}
                      {!c.sensitive && c.requires && (
                        <span className={`badge ${c.readable ? "badge-info" : "badge-warning"}`}>需要 {c.requires} 权限</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && tab === "policies" && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card card-pad">
            <h3 className="row">
              <ShieldCheck size={15} /> 三道防线
            </h3>
            <ol className="muted small" style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
              <li>问题层：问到权限之外的区域、门店或成本指标时直接拒答，并说明原因（避免“华南 GMV 为 0”这种误导）。</li>
              <li>SQL 层：每个表引用都被替换成策略视图（只含有权限的行和字段），条件来自登录身份，不来自 Prompt 或模型输出。</li>
              <li>执行层：只读连接 + SQLite 授权回调，只允许 SELECT、白名单字段和函数；超时中止、结果行数封顶。</li>
            </ol>
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 200 }}>用户</th>
                  <th style={{ width: 140 }}>数据范围</th>
                  <th>行级权限（每张表实际加上的条件）</th>
                </tr>
              </thead>
              <tbody>
                {data.policies.map((u) => (
                  <tr key={u.username}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.name}</div>
                      <div className="faint">{u.title}</div>
                    </td>
                    <td>
                      <span className={`badge ${u.scope.type === "all" ? "" : "badge-warning"}`}>{u.scope.label}</span>
                      {u.permissions.includes("cost") && <div className="faint" style={{ marginTop: 4 }}>可看成本与毛利</div>}
                    </td>
                    <td>
                      {Object.entries(u.tables).map(([table, predicate]) => (
                        <div key={table} className="mono small">
                          <span className="faint">{table}：</span>
                          {predicate}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
