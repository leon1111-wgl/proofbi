import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CircleHelp, Code2, ShieldAlert } from "lucide-react";
import type { NumberCheck, RunPayload } from "../types";
import { ChartBlock, type CellHandler } from "./Charts";
import { Lineage } from "./Lineage";
import { ms, VerdictBadge } from "./ui";

export interface OpenEvidence {
  (queryId: string, focus: { row: number; column: string } | null, number?: NumberCheck | null): void;
}

/** The answer text with every number turned into a handle on its lineage.
 * Mouse: hover lights the number's path, click opens the evidence. Touch: the first tap lights the
 * path, a second tap opens the evidence. Keyboard: focus lights it, Enter opens it. */
export function Narrative({
  text,
  numbers,
  active,
  onActivate,
  onOpen,
}: {
  text: string;
  numbers: NumberCheck[];
  active?: NumberCheck | null;
  onActivate?: (n: NumberCheck) => void;
  onOpen?: (n: NumberCheck) => void;
}) {
  // A tap focuses the number (which lights it) before the click arrives, so remember at
  // pointerdown whether it was already lit and which kind of pointer it was.
  const gesture = useRef({ touch: false, wasActive: false });
  const parts: ReactNode[] = [];
  let cursor = 0;
  [...numbers]
    .sort((a, b) => a.start - b.start)
    .forEach((n, i) => {
      if (n.start < cursor) return;
      parts.push(text.slice(cursor, n.start));
      const title =
        n.status === "verified"
          ? `与 ${n.ref?.query_id} 第 ${n.ref?.row} 行「${n.ref?.label}」一致`
          : n.status === "derived"
            ? `由结果推算：${n.formula}`
            : "在查询结果中找不到这个数字";
      const isActive = active === n;
      const click = () => {
        const { touch, wasActive } = gesture.current;
        gesture.current = { touch: false, wasActive: false };
        if (n.status !== "unverified" && onOpen && (!touch || wasActive)) onOpen(n);
        else onActivate?.(n);
      };
      // an inline span (not a <button>, which is inline-block) so CJK punctuation after the
      // number is never pushed to the start of the next line
      parts.push(
        <span
          key={i}
          role="button"
          tabIndex={0}
          className={`numchip numchip-${n.status}${isActive ? " is-active" : ""}`}
          title={title}
          onPointerDown={(e) => (gesture.current = { touch: e.pointerType !== "mouse", wasActive: isActive })}
          onPointerEnter={(e) => e.pointerType === "mouse" && onActivate?.(n)}
          onFocus={() => onActivate?.(n)}
          onClick={(e) => {
            e.stopPropagation();
            click();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (n.status !== "unverified" && onOpen) onOpen(n);
            }
          }}
          aria-label={`${n.text}：${title}`}
        >
          {text.slice(n.start, n.end)}
        </span>,
      );
      cursor = n.end;
    });
  parts.push(text.slice(cursor));
  return <p className="narrative">{parts}</p>;
}

export function AnswerCard({
  run,
  selected,
  onSelect,
  onEvidence,
  onClarify,
  onSuggest,
}: {
  run: RunPayload;
  selected: boolean;
  onSelect: () => void;
  onEvidence: OpenEvidence;
  onClarify: (term: string, value: string) => void;
  onSuggest: (text: string) => void;
}) {
  const plan = run.plan_view;
  const onCell: CellHandler = (queryId, row, column) => onEvidence(queryId, { row, column });
  const queriesById = Object.fromEntries(run.queries.map((q) => [q.query_id, q]));
  const verification = run.answer?.verification;
  const [active, setActive] = useState<NumberCheck | null>(null);
  const openNumber = (n: NumberCheck) => n.ref && onEvidence(n.ref.query_id, { row: n.ref.row, column: n.ref.column }, n);

  return (
    <article className={`answer ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="answer-head">
        {run.status === "answered" && <VerdictBadge verdict={verification?.verdict} counts={verification?.counts} />}
        {run.status === "clarify" && <span className="badge badge-info">需要确认口径</span>}
        {run.status === "refused" && <span className="badge badge-warning">已拒答 · {run.refusal?.label}</span>}
        {run.status === "failed" && <span className="badge badge-danger">未能回答</span>}
        {plan?.metrics.map((m) => (
          <span key={m.key} className="badge badge-primary" title={m.description}>
            {m.label}
          </span>
        ))}
        {plan && <span className="badge">{plan.time.start} 至 {plan.time.end}</span>}
        {plan?.compare && <span className="badge">{plan.compare.label}</span>}
        {run.scope.restricted && <span className="badge badge-warning">数据范围：{run.scope.label}</span>}
        {run.corrections > 0 && <span className="badge badge-warning">自我纠错 {run.corrections} 次</span>}
        {run.fault && <span className="badge badge-danger">演示故障：{run.fault}</span>}
      </div>

      <div className="answer-body">
        {run.status === "answered" && run.answer && (
          <>
            <Narrative text={run.answer.text} numbers={run.answer.verification.numbers} active={active} onActivate={setActive} onOpen={openNumber} />
            {verification?.verdict === "fail" && (
              <div className="notice">
                <AlertTriangle size={14} />
                <span>标红的数字在查询结果中找不到，可能是模型编造的。请以下方图表和结果行为准。</span>
              </div>
            )}
            {plan && run.queries.length > 0 && (
              <Lineage question={run.question} time={plan.time} metrics={plan.metrics} queries={run.queries} active={active} onOpen={openNumber} />
            )}
            {run.answer.charts.map((chart) =>
              queriesById[chart.query_id] ? (
                <ChartBlock key={chart.query_id} query={queriesById[chart.query_id]} chart={chart} onCell={onCell} />
              ) : null,
            )}
          </>
        )}

        {run.status === "clarify" && run.clarification && (
          <>
            <div className="refusal">
              <CircleHelp size={16} style={{ color: "var(--info)" }} />
              <div>
                <b>{run.clarification.question}</b>
                <div className="faint">为了避免口径不一致，ProofBI 不会替你猜。选择后会按对应口径重新计算。</div>
              </div>
            </div>
            <div className="clarify-options">
              {run.clarification.options.map((o) => (
                <button
                  key={o.value}
                  className="clarify-option"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClarify(run.clarification!.term, o.value);
                  }}
                >
                  <b>{o.label}</b>
                  <span className="faint">{o.description}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {run.status === "refused" && run.refusal && (
          <div className="refusal">
            <ShieldAlert size={16} />
            <div className="stack" style={{ gap: 6 }}>
              <div>{run.refusal.message}</div>
              {run.refusal.suggestions.length > 0 && (
                <div className="row row-wrap">
                  <span className="faint">可以问：</span>
                  {run.refusal.suggestions.map((s) => (
                    <button
                      key={s}
                      className="chip"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSuggest(`上个月的${s}是多少？`);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {run.status === "failed" && (
          <div className="refusal">
            <AlertTriangle size={16} />
            <div>{run.error}</div>
          </div>
        )}

        {plan && run.status === "answered" && (
          <dl className="defs">
            {plan.metrics.map((m) => (
              <FragmentRow key={m.key} label="口径">
                <b>{m.label}</b>：{m.description} <code>{m.filter}</code>
              </FragmentRow>
            ))}
            {plan.notes.map((n, i) => (
              <FragmentRow key={i} label="说明">
                {n}
              </FragmentRow>
            ))}
          </dl>
        )}
      </div>

      {run.queries.length > 0 && (
        <div className="answer-foot">
          {run.queries.map((q) => (
            <button
              key={q.query_id}
              className="btn btn-text btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                onEvidence(q.query_id, null);
              }}
            >
              <Code2 size={13} /> {q.key} · {q.row_count} 行 · {ms(q.elapsed_ms)}
            </button>
          ))}
          <span className="spacer" />
          <span>{ms(run.latency_ms)}</span>
          <Link to={`/traces/${run.run_id}`} onClick={(e) => e.stopPropagation()}>
            查看链路
          </Link>
        </div>
      )}
    </article>
  );
}

function FragmentRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
