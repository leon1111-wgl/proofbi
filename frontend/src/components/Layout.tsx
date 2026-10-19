import { type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, BookOpenCheck, FlaskConical, LogOut, MessageSquareText, Monitor, Moon, Sun } from "lucide-react";
import { useAuth } from "../auth";
import { Logo, useTheme } from "./ui";

const TITLES: Record<string, string> = {
  ask: "问数工作台",
  semantic: "语义层",
  evals: "评测报告",
  traces: "链路追踪",
  q: "数字溯源",
};

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

export default function Layout() {
  const { user, meta, logout } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useTheme();
  const section = location.pathname.split("/")[1] || "ask";
  const groups: [string, NavItem[]][] = [
    ["分析", [{ to: "/ask", label: "问数工作台", icon: <MessageSquareText size={16} /> }]],
    [
      "治理与质量",
      [
        { to: "/semantic", label: "语义层", icon: <BookOpenCheck size={16} /> },
        { to: "/evals", label: "评测报告", icon: <FlaskConical size={16} /> },
        { to: "/traces", label: "链路追踪", icon: <Activity size={16} /> },
      ],
    ],
  ];
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const themeLabel = { system: "跟随系统", light: "浅色", dark: "深色" }[theme];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span className="brand-name">ProofBI</span>
        </div>
        <div className="tenant-card">
          <div className="name">Leon优选 · 零售经营</div>
          <div className="meta">数据截至 {meta?.calendar.data_end ?? "—"}</div>
        </div>
        <nav className="nav">
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="nav-group">{group}</div>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">{user?.name.slice(0, 1)}</span>
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div className="ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>
              {user?.name} · {user?.title}
            </div>
            <div className="faint ellipsis">数据范围：{user?.scope.label}</div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={logout}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span className="ellipsis">Leon优选</span>
            <span>/</span>
            <b>{TITLES[section] ?? "ProofBI"}</b>
          </div>
          <div className="row">
            <span className="badge" title={meta?.dataset.fingerprint}>
              SYNTHETIC 演示数据 · 指纹 {meta?.dataset.fingerprint.slice(0, 8) ?? "—"}
            </span>
            <span className="badge" title="当前使用的模型">
              {meta ? (meta.planner === "rules" ? "离线确定性模型" : meta.model) : "—"}
            </span>
            <button className="icon-btn" title={`主题：${themeLabel}（点击切换）`} aria-label="切换主题" onClick={() => setTheme(nextTheme)}>
              {theme === "light" ? <Sun size={16} /> : theme === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
            </button>
          </div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
