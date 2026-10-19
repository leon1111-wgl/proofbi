"""WeCom (企业微信) group-robot daily report.

The report is built from ordinary pipeline runs, so each number in it went through the
same guard, RLS and verifier, and each line links back to the provenance page of the
query behind it. Without ``PROOFBI_WECOM_WEBHOOK_KEY`` the report is only previewed.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from ..agent.pipeline import AskInput, RunRecord, collect
from ..semantic.access import User

WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send"
DAILY_QUESTIONS = ["昨天的 GMV 和订单数", "昨天各区域 GMV", "近 7 天退款率"]


@dataclass
class DailyReport:
    markdown: str
    records: list[RunRecord]


def build_daily_report(services, user: User) -> DailyReport:
    records = [collect(services.pipeline.run(AskInput(q, user)))[0] for q in DAILY_QUESTIONS]
    cal = services.layer.calendar
    base = services.settings.public_url
    lines = [f"**Leon优选 经营日报 · {cal.data_end.isoformat()}**",
             f"<font color=\"comment\">演示数据（SYNTHETIC）· 数据范围：{records[0].scope.get('label', '')}</font>"]
    for q, rec in zip(DAILY_QUESTIONS, records):
        if rec.status != "answered" or not rec.answer:
            lines.append(f"> {q}：暂无结果（{(rec.refusal or {}).get('message') or rec.error or rec.status}）")
            continue
        verdict = rec.answer["verification"]["verdict"]
        mark = "" if verdict != "fail" else "（有数字未通过核对）"
        links = " ".join(f"[核对 {a.key}]({base}/q/{a.id})" for a in rec.attempts if a.id in rec.final_attempts)
        lines.append(f"> {rec.answer['text']}{mark} {links}")
    lines.append("每个数字都能点开看到对应的 SQL、执行信息和结果行。")
    return DailyReport("\n".join(lines), records)


def send_markdown(webhook_key: str, markdown: str, transport: httpx.BaseTransport | None = None) -> dict:
    with httpx.Client(timeout=10.0, transport=transport) as client:
        response = client.post(WEBHOOK_URL, params={"key": webhook_key},
                               json={"msgtype": "markdown", "markdown": {"content": markdown}})
    response.raise_for_status()
    data = response.json()
    if data.get("errcode") != 0:
        raise RuntimeError(f"企业微信返回错误：{data}")
    return data
