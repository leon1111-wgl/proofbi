import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { LogOut } from "lucide-react";
import { DEMO } from "../api";
import { useAuth } from "../auth";
import { Logo, ThemeButton } from "./ui";

/** Console sections, drawn as nodes on one lineage line (rail on desktop, strip on phones). */
export const SECTIONS = [
  { to: "/ask", label: "问数工作台", short: "问数", hint: "提问，点开数字看血缘" },
  { to: "/semantic", label: "语义层", short: "语义层", hint: "指标口径与数据权限" },
  { to: "/traces", label: "链路追踪", short: "链路", hint: "每一步的输入、输出和耗时" },
  { to: "/evals", label: "评测报告", short: "评测", hint: "离线评测与留出集" },
];

const SECTION_OF: Record<string, string> = { ask: "/ask", semantic: "/semantic", traces: "/traces", evals: "/evals", q: "/traces" };

export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <span className="demo-tag mono">STATIC DEMO</span>
      <span>
        静态演示 · 回放离线规则模型在 SYNTHETIC 数据上的保存结果 · 完整服务请按{" "}
        <a href="https://github.com/leon1111-wgl/proofbi#快速开始" target="_blank" rel="noreferrer">
          README
        </a>{" "}
        本地运行
      </span>
    </div>
  );
}

export default function Layout() {
  const { user, meta, logout } = useAuth();
  const location = useLocation();
  const current = SECTION_OF[location.pathname.split("/")[1]] ?? "/ask";
  const section = SECTIONS.find((s) => s.to === current)!;
  const model = meta ? (meta.planner === "rules" ? "离线规则模型" : meta.model) : "—";

  return (
    <div className="shell">
      <aside className="rail" aria-label="控制台导航">
        <Link to="/" className="rail-brand" title="ProofBI 介绍页">
          <Logo />
          <span>
            <b>ProofBI</b>
            <span className="mono">可核对的 ChatBI</span>
          </span>
        </Link>
        <div className="rail-tenant">
          <span className="mono">TENANT</span>
          <b>Leon优选 · 零售经营</b>
          <span className="faint">数据截至 {meta?.calendar.data_end ?? "—"}</span>
        </div>
        <nav className="rail-nav">
          {SECTIONS.map((s) => (
            <NavLink key={s.to} to={s.to} className={() => `rail-link${s.to === current ? " active" : ""}`} aria-current={s.to === current ? "page" : undefined}>
              <span className="rail-node" aria-hidden="true" />
              <span className="rail-text">
                <b>{s.label}</b>
                <span className="rail-hint">{s.hint}</span>
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="avatar">{user?.name.slice(0, 1)}</span>
          <div className="rail-user">
            <b className="ellipsis">
              {user?.name} · {user?.title}
            </b>
            <span className="faint ellipsis">数据范围：{user?.scope.label}</span>
          </div>
          <button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={logout}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link to="/" className="topbar-brand" aria-label="ProofBI 介绍页">
            <Logo size={22} />
          </Link>
          <div className="crumbs">
            <b>{location.pathname.startsWith("/q/") ? "数字溯源" : section.label}</b>
          </div>
          <span className="spacer" />
          <span className="tag tag-synthetic" title={meta?.dataset.fingerprint}>
            SYNTHETIC · {meta?.dataset.fingerprint.slice(0, 8) ?? "—"}
          </span>
          <span className="tag topbar-model" title="当前使用的模型">
            {model}
          </span>
          {DEMO && <span className="tag tag-replay">回放</span>}
          <ThemeButton />
          <button className="icon-btn topbar-logout" title="退出登录" aria-label="退出登录" onClick={logout}>
            <LogOut size={15} />
          </button>
        </header>
        <nav className="strip" aria-label="控制台分区">
          {SECTIONS.map((s) => (
            <NavLink key={s.to} to={s.to} className={() => `strip-link${s.to === current ? " active" : ""}`} aria-current={s.to === current ? "page" : undefined}>
              <span className="strip-node" aria-hidden="true" />
              <span>{s.short}</span>
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </div>
    </div>
  );
}
