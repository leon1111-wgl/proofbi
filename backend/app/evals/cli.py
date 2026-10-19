"""Run the evaluation set from the command line (the CI gate).

    python -m app.evals.cli --gate 0.9 --gate-dev 1.0 --report eval-report.json
    python -m app.evals.cli --split holdout

Exit code 1 when the overall pass rate is below ``--gate``, when the dev split (the
regression set) is below ``--gate-dev``, or when any security case fails: security
cases are a veto, not something an average can hide.
By default results go to a throwaway database; ``--persist`` writes into the app database.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from sqlalchemy import select


def _pct(v) -> str:
    return "—" if v is None else f"{v:.1%}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ProofBI offline evaluation")
    parser.add_argument("--gate", type=float, default=0.0, help="fail (exit 1) when the pass rate is below this")
    parser.add_argument("--gate-dev", type=float, default=None, help="minimum pass rate of the dev split")
    parser.add_argument("--split", choices=["dev", "holdout"], help="only run one split")
    parser.add_argument("--cases", help="YAML file with cases (default: PROOFBI_EVAL_CASES_PATH)")
    parser.add_argument("--report", help="write metrics and per-case results as JSON")
    parser.add_argument("--persist", action="store_true", help="store the run in PROOFBI_DATABASE_URL")
    args = parser.parse_args(argv)

    from ..config import get_settings
    from ..db import create_all, init_engine, new_session
    from ..models import EvalResult
    from ..services import Services, set_services
    from .runner import load_cases, run_suite

    settings = get_settings()
    if not args.persist:
        settings.database_url = f"sqlite:///{Path(tempfile.mkdtemp()) / 'eval.db'}"
    init_engine(settings.database_url)
    create_all()
    services = Services(settings)
    set_services(services)
    cases = load_cases(args.cases or settings.eval_cases_path)
    if args.split:
        cases = [c for c in cases if c.split == args.split]

    with new_session() as db:
        run = run_suite(services, db, cases, triggered_by="cli")
        results = db.execute(select(EvalResult).where(EvalResult.eval_run_id == run.id)
                             .order_by(EvalResult.id)).scalars().all()
        m = run.metrics
        print(f"\nProofBI eval · {settings.model_label} · dataset {run.dataset_fingerprint[:12]} "
              f"(SYNTHETIC) · {len(results)} cases")
        print("-" * 96)
        for r in results:
            failed = [k for k, ok in r.checks.items() if not ok]
            mark = "PASS" if r.passed else "FAIL"
            detail = "" if r.passed else "failed: " + ", ".join(failed)
            if not r.passed and r.actual.get("execution_detail"):
                detail += f" ({r.actual['execution_detail']})"
            print(f"{mark}  {r.split:<7} {r.category:<8} {r.case_id:<34} {r.latency_ms:>7.1f}ms  {detail}")
        print("-" * 96)
        print(f"pass rate {_pct(m['pass_rate'])} ({run.passed}/{run.total})  "
              f"EX {_pct(m['execution_accuracy'])}  口径 {_pct(m['caliber_accuracy'])}  "
              f"拒答 {_pct(m['refusal_accuracy'])}  误拒 {_pct(m['false_refusal_rate'])}  "
              f"安全 {_pct(m['security_pass_rate'])}  数字核对 {_pct(m['number_verified_rate'])}")
        for split, sm in m["by_split"].items():
            print(f"  {split:<8} pass {_pct(sm['pass_rate'])} ({sm['passed']}/{sm['total']})  "
                  f"EX {_pct(sm['execution_accuracy'])}  口径 {_pct(sm['caliber_accuracy'])}  "
                  f"拒答 {_pct(sm['refusal_accuracy'])}")
        print(f"latency p50 {m['latency_p50_ms']}ms  p95 {m['latency_p95_ms']}ms  "
              f"self-corrections {m['self_corrections']}")
        print("Note: offline rules model + synthetic data. These numbers show the pipeline works as designed;"
              " they are not a measure of LLM quality.")
        if args.report:
            Path(args.report).write_text(json.dumps({
                "model": run.model, "dataset_fingerprint": run.dataset_fingerprint, "metrics": m,
                "cases": [{"id": r.case_id, "split": r.split, "category": r.category, "question": r.question,
                           "user": r.username, "passed": r.passed, "checks": r.checks, "actual": r.actual}
                          for r in results],
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        reasons = []
        if m["security_pass_rate"] is not None and m["security_pass_rate"] < 1.0:
            reasons.append("a security case failed")
        if m["pass_rate"] < args.gate:
            reasons.append(f"pass rate {m['pass_rate']:.1%} < {args.gate:.0%}")
        dev = m["by_split"].get("dev")
        if args.gate_dev is not None and dev and dev["pass_rate"] < args.gate_dev:
            reasons.append(f"dev pass rate {dev['pass_rate']:.1%} < {args.gate_dev:.0%}")
        if reasons:
            print(f"\nGATE FAILED: {'; '.join(reasons)}")
            return 1
        print(f"\nGATE PASSED (pass rate >= {args.gate:.0%}"
              + (f", dev >= {args.gate_dev:.0%}" if args.gate_dev is not None else "") + ", security 100%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
