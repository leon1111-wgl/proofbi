import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBanner, Logo, useLoad } from "../components/ui";
import type { User } from "../types";

const CAPABILITIES = [
  ["语义层统一口径", "GMV、复购率、客单价等 12 个指标在 YAML 中定义一次；“销售额”这类有歧义的词会先确认口径再计算。"],
  ["三道 SQL 防线", "sqlglot AST 静态校验 → 行级权限改写 → 只读连接与 SQLite 授权回调，注入和越权在任何一层都会被拦下。"],
  ["数字级可核对", "答案中的每个数字都链接到产生它的 SQL、执行信息和结果行；对不上的数字直接标红。"],
  ["评测进 CI", "56 个问题（开发集 + 留出集）计算执行准确率、口径正确率和拒答正确率，安全用例一票否决。"],
];

export default function LoginPage() {
  const { login } = useAuth();
  const { data } = useLoad(() => api.get<{ users: User[]; password: string | null }>("/api/auth/demo-users"), []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (u: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      await login(u, p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-intro">
        <div className="row">
          <Logo size={28} />
          <span className="brand-name" style={{ fontSize: 16 }}>ProofBI</span>
        </div>
        <div className="headline">
          <h1>答案里的每个数字，都能点开核对</h1>
          <p className="lead">
            ProofBI 是一个可核对的 ChatBI：业务同学用自然语言问数，系统先把问题映射到语义层统一口径，再生成、校验并在行级权限下执行 SQL；
            回答中的每个数字都能追溯到对应的 SQL、执行信息和原始结果行。
          </p>
          <div className="capabilities">
            {CAPABILITIES.map(([title, desc], i) => (
              <div className="capability" key={title}>
                <span className="no">0{i + 1}</span>
                <b>{title}</b>
                <span className="desc">{desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="foot">Leon优选为虚构的零售品牌，所有门店、会员与订单数据均为脚本生成的演示数据（SYNTHETIC）。</div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div>
            <h2>登录控制台</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              选择一个演示身份。不同身份的数据权限不同，可以直接体验行级权限和拒答。
            </p>
          </div>
          {data && data.users.length > 0 && (
            <div className="account-list">
              {data.users.map((u) => (
                <button key={u.username} className="account" disabled={busy} onClick={() => submit(u.username, data.password ?? "")}>
                  <span className="avatar">{u.name.slice(0, 1)}</span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>
                      {u.name} <span className="muted" style={{ fontWeight: 400 }}>· {u.title}</span>
                    </div>
                    <div className="faint">
                      数据范围：{u.scope.label}
                      {u.permissions.includes("cost") ? " · 可看成本与毛利" : ""}
                    </div>
                  </span>
                  <span className="go">进入</span>
                </button>
              ))}
            </div>
          )}
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(username, password);
            }}
          >
            <span className="label">或使用账号密码</span>
            <input className="input" placeholder="用户名，例如 leon" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            <input className="input" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <button className="btn btn-primary" type="submit" disabled={busy || !username}>
              登录
            </button>
            {data?.password && <span className="faint">演示账号的密码统一为 {data.password}</span>}
          </form>
          <ErrorBanner error={error} />
        </div>
      </section>
    </div>
  );
}
