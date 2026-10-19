"""Number verifier: numbers in the answer must come from result cells."""

from app.agent.numbers import extract_numbers, format_value
from app.agent.verifier import ResultTable, verify_answer

KPI = ResultTable("q_kpi", ["repeat_buyers", "buyer_count", "repurchase_rate", "gmv"], [[63, 352, 0.179, 133620.97]],
                  {"repurchase_rate": "复购率", "gmv": "GMV"})
TREND = ResultTable("q_trend", ["period", "gmv"], [["2026-08", 468603.3], ["2026-09", 467834.99]], {"gmv": "GMV"})
REGIONS = ResultTable("q_reg", ["region", "gmv"], [["华东", 300.0], ["华南", 100.0], ["华北", 100.0]], {"gmv": "GMV"})


def statuses(text, *tables):
    report = verify_answer(text, list(tables))
    return report.verdict, [(n.text, n.status) for n in report.numbers]


def test_formatting_rules():
    assert format_value(133620.97, "currency") == "13.36 万元"
    assert format_value(1234.5, "currency") == "1,234.50 元"
    assert format_value(0.179, "percent") == "17.9%"
    assert format_value(12345, "integer", "单") == "12,345 单"


def test_numbers_that_match_cells_are_verified():
    verdict, nums = statuses("上个月华东区的复购率为 17.9%（复购用户 63 人，下单用户 352 人），GMV 为 13.36 万元。", KPI)
    assert verdict == "pass"
    assert nums == [("17.9%", "verified"), ("63", "verified"), ("352", "verified"), ("13.36 万元", "verified")]


def test_reference_points_at_the_cell():
    report = verify_answer("复购率为17.9%", [KPI])
    assert report.numbers[0].ref == {"query_id": "q_kpi", "row": 0, "column": "repurchase_rate",
                                     "label": "复购率", "value": 0.179}


def test_wrong_number_is_flagged():
    verdict, nums = statuses("GMV 为 14.43 万元，复购率 17.9%。", KPI)
    assert verdict == "fail"
    assert nums[0] == ("14.43 万元", "unverified")


def test_rounding_tolerance_follows_displayed_precision():
    assert statuses("复购率约 18%", KPI)[1][0][1] == "verified"  # 0.179 rounds to 18%
    assert statuses("复购率 17.8%", KPI)[1][0][1] == "unverified"  # 17.9% is the only correct 1-decimal form
    assert statuses("GMV 133,620.97 元", KPI)[1][0][1] == "verified"
    assert statuses("GMV 133,621.97 元", KPI)[1][0][1] == "unverified"


def test_derived_change_rate_and_percentage_points():
    verdict, nums = statuses("2026-09 为 46.78 万元，2026-08 为 46.86 万元，环比下降 0.2%。", TREND)
    assert verdict == "pass" and nums[-1] == ("0.2%", "derived")
    report = verify_answer("环比下降 0.2%", [TREND])
    assert "变化率" in report.numbers[0].formula and len(report.numbers[0].refs) == 2
    rates = ResultTable("q", ["period", "rate"], [["2025-09", 0.046], ["2026-09", 0.050]])
    assert statuses("同比上升 0.4 个百分点", rates)[1] == [("0.4 个百分点", "derived")]


def test_derived_share_and_total():
    assert statuses("华东占 60.0%", REGIONS)[1] == [("60.0%", "derived")]
    assert statuses("三个区域合计 500.00 元", REGIONS)[1] == [("500.00 元", "derived")]


def test_dates_rankings_and_labels_are_not_checked():
    table = ResultTable("q", ["age_band", "gmv"], [["25-34岁", 100.0]])
    verdict, nums = statuses("2026年9月（2026-09-01 至 2026-09-30），近 30 天排名前 5，25-34岁用户 GMV 100.00 元。", table)
    assert nums == [("100.00 元", "verified")] and verdict == "pass"


def test_no_numbers_means_no_verdict():
    assert verify_answer("结果见下方表格。", [KPI]).verdict == "none"


def test_cjk_before_number_is_still_extracted():
    assert [n.text for n in extract_numbers("复购率为17.9%，订单数为426单")] == ["17.9%", "426"]
