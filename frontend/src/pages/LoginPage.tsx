import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { DEMO, api } from "../api";
import { useAuth } from "../auth";
import { ErrorBanner, Logo, ThemeButton, useLoad } from "../components/ui";
import type { User } from "../types";

const TRY: Record<string, string> = {
  leon: "全部区域 · 演示故障注入与自我纠错",
  jack: "全部区域 · 毛利率等成本指标",
  mia: "华东 · 行级权限、越权拒答、提示注入",
  emma: "华南 · 行级权限",
  noah: "上海徐汇店 · 门店级权限",
};

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
      if (location.pathname === "/login") navigate("/ask", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login paper">
      <header className="land-top">
        <Link to="/" className="land-brand">
          <Logo size={26} />
          <b>ProofBI</b>
        </Link>
        <span className="spacer" />
        <ThemeButton />
      </header>
      <main className="login-main">
        <div className="login-card">
          <Link to="/" className="back-link small">
            <ArrowLeft size={13} /> 返回介绍
          </Link>
          <div>
            <span className="eyebrow mono">SIGN IN · 选择身份</span>
            <h1>用谁的权限来问数？</h1>
            <p className="muted">
              五个虚构身份的数据范围不同：同一个问题，换个身份就能看到行级权限和越权拒答。
              {DEMO && " 静态演示里身份切换只在本页生效，不需要密码。"}
            </p>
          </div>
          {data && data.users.length > 0 && (
            <ul className="account-list">
              {data.users.map((u) => (
                <li key={u.username}>
                  <button className="account" disabled={busy} onClick={() => submit(u.username, data.password ?? "")}>
                    <span className="avatar">{u.name.slice(0, 1)}</span>
                    <span className="account-text">
                      <b>
                        {u.name} <span className="muted">· {u.title}</span>
                      </b>
                      <span className="faint">{TRY[u.username] ?? `数据范围：${u.scope.label}`}</span>
                    </span>
                    <span className={`scope-tag scope-${u.scope.type}`}>{u.scope.label}</span>
                    <ArrowRight size={15} className="go" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!DEMO && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(username, password);
              }}
            >
              <span className="label">或使用账号密码</span>
              <input className="input" placeholder="用户名，例如 leon" aria-label="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
              <input className="input" type="password" placeholder="密码" aria-label="密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              <button className="btn btn-primary" type="submit" disabled={busy || !username}>
                登录
              </button>
              {data?.password && <span className="faint">演示账号的密码统一为 {data.password}</span>}
            </form>
          )}
          <ErrorBanner error={error} />
          <p className="faint">Leon优选为虚构的零售品牌，所有门店、会员与订单数据均为脚本生成（SYNTHETIC）。</p>
        </div>
      </main>
    </div>
  );
}
