import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Github } from "lucide-react";
import { DEMO } from "../api";
import { useAuth } from "../auth";
import { Narrative } from "../components/AnswerCard";
import { Lineage, type LineageQuery } from "../components/Lineage";
import { Logo, ThemeButton, pct } from "../components/ui";
import type { NumberCheck, PlanView } from "../types";
import recorded from "../specimen.json";

// One real answer from the offline rules model on the SYNTHETIC warehouse, written by
// scripts/record_demo.py together with the offline eval summary below.
const specimen = recorded as unknown as {
  question: string;
  answer: string;
  numbers: NumberCheck[];
  metrics: PlanView["metrics"];
  time: PlanView["time"];
  queries: LineageQuery[];
  model: string;
  dataset_fingerprint: string;
  dataset_rows: number;
  eval: {
    total: number;
    passed: number;
    pass_rate: number;
    execution_accuracy: number | null;
    refusal_accuracy: number | null;
    security_pass_rate: number | null;
    splits: Record<string, { passed: number; total: number }>;
  };
};

const STAGES: [string, string][] = [
  ["问题解析", "把问题映射到语义层的指标、维度、筛选和时间；“销售额”这类有歧义的词先问清楚"],
  ["生成 SQL", "按指标口径编译模板 SQL；接入大模型后也可以由模型来写"],
  ["安全校验", "sqlglot AST 白名单：只允许 SELECT 和白名单表字段，读敏感列直接拒绝"],
  ["口径校验", "核对状态过滤、求和字段和时间范围，不一致就交回去修正"],
  ["行级权限改写", "每个表引用换成策略视图，条件来自登录身份，不来自 Prompt"],
  ["执行查询", "只读连接 + SQLite 授权回调，超时中止，结果行数封顶"],
  ["生成结论", "结论里的数字从结果里取，格式和表格一致"],
  ["数字核对", "每个数字回到结果单元格核对；推算的给公式，对不上的标红"],
];

function Specimen() {
  const { numbers } = specimen;
  const [active, setActive] = useState<NumberCheck | null>(numbers[0] ?? null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || numbers.length < 2 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setActive((a) => numbers[(numbers.indexOf(a!) + 1) % numbers.length]), 3200);
    return () => clearInterval(timer);
  }, [touched, numbers]);
  const pick = (n: NumberCheck) => {
    setTouched(true);
    setActive(n);
  };
  return (
    <div className="specimen" onPointerDown={() => setTouched(true)}>
      <div className="specimen-bar mono">
        <span>SPECIMEN</span>
        <span>Leon · 数据平台负责人 · 离线规则模型的录制输出</span>
      </div>
      <div className="specimen-q">{specimen.question}</div>
      <Narrative text={specimen.answer} numbers={numbers} active={active} onActivate={pick} />
      <Lineage question={specimen.question} time={specimen.time} metrics={specimen.metrics} queries={specimen.queries} active={active} />
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const enter = user ? "/ask" : "/login";
  const ev = specimen.eval;
  const dev = ev.splits.dev;
  const holdout = ev.splits.holdout;

  return (
    <div className="landing paper">
      <header className="land-top">
        <Link to="/" className="land-brand">
          <Logo size={26} />
          <b>ProofBI</b>
        </Link>
        <nav className="land-nav" aria-label="介绍页目录">
          <a href="#lineage">数字血缘</a>
          <a href="#pipeline">八道工序</a>
          <a href="#evals">离线评测</a>
        </nav>
        <span className="spacer" />
        <ThemeButton />
        <a className="icon-btn" href="https://github.com/leon1111-wgl/proofbi" target="_blank" rel="noreferrer" title="GitHub 代码" aria-label="GitHub 代码">
          <Github size={16} />
        </a>
        <Link className="btn btn-primary" to={enter}>
          {user ? "回到控制台" : "进入控制台"}
        </Link>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow mono">VERIFIABLE CHATBI · 可核对的问数</span>
            <h1>
              答案里的每个数字，
              <br />
              都能顺着血缘找到源头
            </h1>
            <p className="lead">
              业务同学用自然语言问数。ProofBI 先把问题映射到语义层的统一口径，再生成、校验并在行级权限下执行 SQL；
              回答里的每个数字都连着它的指标、SQL 和结果行，对不上的直接标红。
            </p>
            <div className="hero-cta">
              <Link className="btn btn-primary btn-lg" to={enter}>
                {user ? "回到控制台" : "进入控制台"} <ArrowRight size={16} />
              </Link>
              <a className="btn btn-lg" href="#lineage">
                先看一个数字的血缘
              </a>
            </div>
          </div>
          <ol className="provenance" aria-label="这个页面的数字从哪里来">
            {(
              [
                ["数据", `Leon优选（虚构零售品牌） · SYNTHETIC · ${specimen.dataset_rows.toLocaleString("en-US")} 行 · 固定种子`],
                ["指纹", specimen.dataset_fingerprint.slice(0, 16)],
                ["模型", "离线规则解析 + 模板 SQL"],
                ["本页", DEMO ? "静态演示 · 回放录制结果" : "完整服务"],
                ["作者", "Leon Wang · 个人项目"],
              ] as [string, string][]
            ).map(([k, v]) => (
              <li key={k}>
                <span className="prov-key">{k}</span>
                <span className={k === "指纹" ? "mono" : ""}>{v}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="lineage" className="land-section">
          <div className="section-head">
            <span className="mono">01</span>
            <h2>悬停一个数字，看它从哪里来</h2>
            <p>下面是离线模型的一次真实回答。把鼠标移到带下划线的数字上（手机上点一下），路径会依次点亮：问题 → 语义层指标 → 生成它的 SQL → 结果行里的那个单元格。</p>
          </div>
          <Specimen />
        </section>

        <section id="pipeline" className="land-section">
          <div className="section-head">
            <span className="mono">02</span>
            <h2>从问题到数字，经过八道工序</h2>
            <p>每一道都记录输入、输出和耗时，控制台的“链路追踪”里可以逐步回看。安全违规直接拒绝，不给模型重试的机会。</p>
          </div>
          <ol className="pipeline">
            {STAGES.map(([name, desc], i) => (
              <li key={name}>
                <span className="pipe-node mono">{String(i + 1).padStart(2, "0")}</span>
                <b>{name}</b>
                <span>{desc}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="evals" className="land-section">
          <div className="section-head">
            <span className="mono">03</span>
            <h2>离线评测：请带着前提读</h2>
            <p>
              {ev.total} 个问题跑完整链路，再和人工编写的标准 SQL 的结果集比对。CI 每次提交都跑：开发集必须全过，任何一个安全用例失败都会让门禁失败。
            </p>
          </div>
          <div className="eval-sheet">
            <table className="table">
              <thead>
                <tr>
                  <th>评测集</th>
                  <th className="num">通过</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>开发集 dev</td>
                  <td className="num mono">{dev ? `${dev.passed}/${dev.total}` : "—"}</td>
                  <td className="muted">写规则时使用，作为回归门禁</td>
                </tr>
                <tr>
                  <td>留出集 holdout</td>
                  <td className="num mono">{holdout ? `${holdout.passed}/${holdout.total}` : "—"}</td>
                  <td className="muted">规则冻结后才写，从未用来调规则{holdout && holdout.total > holdout.passed ? `；${holdout.total - holdout.passed} 个失败如实保留` : ""}</td>
                </tr>
                <tr>
                  <td>合计</td>
                  <td className="num mono">
                    {ev.passed}/{ev.total}（{pct(ev.pass_rate)}）
                  </td>
                  <td className="muted">
                    执行准确率 {pct(ev.execution_accuracy)} · 拒答正确率 {pct(ev.refusal_accuracy)} · 安全用例 {pct(ev.security_pass_rate)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="caveat">
              <b>前提</b>：这些数字来自<b>离线确定性模型</b>（规则解析 + 模板 SQL）和 <b>SYNTHETIC 数据</b>，规则和用例出自同一个作者。它们只说明“流程按设计工作”：口径对、权限没漏、该拒的拒了，
              <b>不代表大模型的效果</b>；仓库里还没有真实模型的评测结果。
            </p>
          </div>
        </section>

        <section className="land-end">
          <div>
            <h2>五个演示身份，五种数据范围</h2>
            <p className="muted">数据平台负责人、财务分析师、两位区域运营经理和一位店长。换个身份问同一个问题，就能看到行级权限和越权拒答。</p>
          </div>
          <Link className="btn btn-primary btn-lg" to={enter}>
            {user ? "回到控制台" : "选择身份进入"} <ArrowRight size={16} />
          </Link>
        </section>
      </main>

      <footer className="land-foot">
        <span>Leon优选是虚构的零售品牌；门店、会员与订单全部由脚本生成（SYNTHETIC），不代表任何真实企业。</span>
        <span className="mono">model: {specimen.model}</span>
      </footer>
    </div>
  );
}
