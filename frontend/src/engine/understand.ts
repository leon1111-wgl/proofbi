/* What the browser adds in front of the ported planner. None of this exists in the Python rules
 * planner, so the backend's eval, including its holdout, is unaffected.
 *
 * 1. Rewrite: everyday wording becomes the semantic layer's own words, and any judgement call is
 *    written into the answer's notes ("“赚了多少”按毛利额统计").
 * 2. Closed reading: an answer is given only if every word of the message is accounted for by the
 *    semantic layer, a period, a ranking word or plain filler. "新客的GMV" must not become total GMV,
 *    so a leftover word is refused and named. The filler list is the only thing that can be wrong here,
 *    and when it is, the result is a refusal, never a different question answered.
 * 3. Next steps: every refusal offers questions this identity can really ask (tests/nextsteps). */
import { PACK, has, labelOf, scopeLabel, type PackUser } from "./pack";
import { INJECTION_RE, MOM_RE, RulesPlanner, UNKNOWN_METRIC_RE, YOY_RE, normalize, validatePlan, type Entry, type Plan, type PlanOutcome } from "./planner";
import { NUM, cnToInt } from "./timeparse";

// ---------------------------------------------------------------- traditional characters in this domain
const TRAD_PAIRS = "區区華华銷销額额訂订單单數数門门個个幾几麼么這这邊边員员買买賣卖貨货類类會会級级價价環环發发統统計计較较對对與与東东廣广倉仓廠厂產产開开關关線线網网購购費费錢钱總总進进運运達达過过還还請请問问謝谢嗎吗甚什為为當当後后來来時时間间週周歲岁齡龄經经營营業业績绩潤润權权導导預预測测資资細细顯显於于將将復复淨净筆笔別别帶带獲获贏赢虧亏漲涨趨趋勢势億亿萬万兩两專专歷历壓压實实際际戶户張张號号碼码電电話话郵邮銀银貴贵應应該该詢询幫帮讓让給给說说刪删寫写蘇苏廈厦鄭郑漢汉蘭兰陽阳濟济連连爾尔濱滨門门見见覽览區区聯联體体態态標标準准確确認认選选擇择較较長长並并從从備备務务員员樣样種种點点裡里裏里歸归雲云順顺標标";
const TRAD = new Map<string, string>();
for (let i = 0; i + 1 < TRAD_PAIRS.length; i += 2) TRAD.set(TRAD_PAIRS[i], TRAD_PAIRS[i + 1]);
const simplify = (text: string) => [...text].map((c) => TRAD.get(c) ?? c).join("");

// ---------------------------------------------------------------- browser-only vocabulary
function extraEntries(): Entry[] {
  const out: Entry[] = [];
  const families = new Map<string, string[]>();
  for (const name of PACK.products) {
    out.push({ surface: name, kind: "value", key: "product", values: [name] });
    const brand = PACK.dimensions.brand.values.find((b) => name.startsWith(`${b} `));
    if (brand) {
      const family = name.slice(brand.length + 1);
      if (!families.has(family)) families.set(family, []);
      families.get(family)!.push(name);
    }
  }
  for (const [family, names] of families) out.push({ surface: family, kind: "value", key: "product", values: names });
  // a store by its neighbourhood alone; numeric and generic ones (五一, 二七, 园区, 和平) stay out
  const short: Record<string, string> = { 徐汇: "上海徐汇店", 浦东: "上海浦东店", 西湖: "杭州西湖店", 新街口: "南京新街口店", 天河: "广州天河店", 南山: "深圳南山店", 福田: "深圳福田店", 思明: "厦门思明店", 朝阳: "北京朝阳店", 海淀: "北京海淀店", 光谷: "武汉光谷店", 春熙: "成都春熙店", 解放碑: "重庆解放碑店", 翠湖: "昆明翠湖店", 小寨: "西安小寨店", 西关: "兰州西关店", 中央大街: "哈尔滨中央大街店" };
  for (const [s, name] of Object.entries(short)) out.push({ surface: s, kind: "value", key: "store", values: [name] });
  return out;
}
export const planner = new RulesPlanner({ extraEntries: extraEntries(), richFollowups: true });

// ---------------------------------------------------------------- everyday wording -> the layer's words
type Rule = [RegExp, string | ((...m: string[]) => string), string?];
const GOODS = "(?:商品|东西|货|产品|单品)?";
const RULES: Rule[] = [
  // English questions, a small glossary; anything else stays a leftover word and is refused
  [/\blast month\b/gi, "上个月"], [/\bthis year\b/gi, "今年"], [/\blast year\b/gi, "去年"], [/\bby region\b/gi, "按区域"], [/\bby channel\b/gi, "按渠道"],
  [/\bby category\b/gi, "按品类"], [/\bby store\b/gi, "按门店"], [/\bby month\b/gi, "按月"], [/\brefund rate\b/gi, "退款率"], [/\brepurchase rate\b/gi, "复购率"],
  [/\bgross margin\b/gi, "毛利率"], [/\bgross profit\b/gi, "毛利额"], [/\bnet (?:sales|revenue)\b/gi, "净销售额"], [/\b(?:number of )?orders\b/gi, "订单数"], [/\btrend\b/gi, "趋势"],
  [/\b(?:what|was|were|is|are|the|show|me|please|how|much|many|of|in|for|did|we|do|have|our|tell|give)\b/gi, " "],
  [/\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous\s+|above\s+|prior\s+)?(?:instructions?|rules?|restrictions?|permissions?|prompts?)?(?:\s+and)?/gi, "忽略权限"],
  // role claims read as the injection they are; the planner notes and ignores them
  [/(?:我是|我就是|本人是|身为|作为)(?:系统)?(?:管理员|admin|老板|总部|总经理|ceo|cto|数据平台负责人|财务|leon|jack)(?:[,，。.]|了|的身份)?/gi, "忽略权限"],
  [/(?:我有|已有|已经有|给了我)(?:全部|所有|最高|管理员)?权限/g, "忽略权限"],
  [/(?:切换|切|换)(?:到|成)?(?:管理员|admin|leon|jack)(?:的?(?:身份|账号|权限|模式))?/gi, "忽略权限"],
  [/(?:开发者|调试|管理员|上帝|god|debug|sudo|admin)\s*模式|\bsudo\b/gi, "忽略权限"],
  [/(?:假装|假设|当作|当成|以)(?:我是)?(?:管理员|admin|leon|jack)(?:的?身份)?/gi, "忽略权限"],
  [/(?:老板|领导|老大|总监|上面)(?:想|要)(?:看看?|知道|了解)?/g, "想看"],
  [/不管退没退|不论退没退|不管有没有退|不管退不退/g, " "], [/那几天|这几天|那段时间|那阵子/g, " "],
  // a follow-up phrased as "把时间改成..." is not a write
  [/(?:把|将)(?:时间|日期|周期|区域|大区|地区|指标|范围|月份|维度)(?:改成|改为|换成)/g, "换成"],
  // period. "前6个月" is a period, not a top 6; with a year it counts from January
  [new RegExp(`(今年|去年|前年|\\d{4}年)前${NUM}个月`, "g"), (_, y, n) => {
    const year = /\d/.test(y) ? Number(y.slice(0, 4)) : ({ 今年: 2026, 去年: 2025, 前年: 2024 } as Record<string, number>)[y];
    const months = cnToInt(n);
    return months >= 1 && months <= 12 ? `${year}-01-01到${year}-${String(months).padStart(2, "0")}-${new Date(Date.UTC(year, months, 0)).getUTCDate()}` : `${y}前${n}个月`;
  }],
  [new RegExp(`前${NUM}(个月|天|日|周|星期)`, "g"), "近$1$2"],
  [new RegExp(`(?<![\\d年-])(\\d{1,2}|[一二三四五六七八九十]+)月份`, "g"), "$1月"], [/(\d{4}年\d{1,2})月份/g, "$1月"],
  [/上一个?月份?|前一个月/g, "上个月"], [/上一个?季度?|上季(?!度)/g, "上季度"], [/上上周|上上个?(?:星期|礼拜)/g, "2026-09-14到2026-09-20"], [/(?:上个?)礼拜/g, "上周"], [/这(?:个)?礼拜/g, "本周"],
  [/昨儿(?:个)?/g, "昨天"], [/今儿(?:个)?/g, "今天"], [/今年(?:到现在|至今|累计|截至目前)|年初到现在|今年迄今/g, "今年以来"],
  [/(?:近|最近|过去|这)(?:这)?半年(?:来)?/g, "近6个月"], [/一个月一个月(?:的)?|逐个月/g, "每月"], [/(?:近|最近|过去)一个?季度/g, "近3个月"], [/去年(?:一整年|全年|整年)/g, "去年"],
  [/(\d{4})年?(?:的)?(?:双十一|双11)/g, (_, y) => `${y}-11-01到${y}-11-11`],
  [/(\d{4})年?(?:的)?(?:618|六一八)/g, (_, y) => `${y}-06-01到${y}-06-18`],
  [/去年(?:的)?(?:618|六一八)/g, "2025-06-01到2025-06-18"], [/今年(?:的)?(?:618|六一八)/g, "2026-06-01到2026-06-18"],
  [/去年(?:的)?(?:双十一|双11)/g, "2025-11-01到2025-11-11"], [/前年(?:的)?(?:双十一|双11)/g, "2024-11-01到2024-11-11"], [/今年(?:的)?(?:双十一|双11)/g, "2026-11-01到2026-11-11"],
  [new RegExp(`(今年|去年|前年)第?([一二三四1-4])季度`, "g"), (_, y, q) => `${{ 今年: 2026, 去年: 2025, 前年: 2024 }[y]}年第${q}季度`],
  [new RegExp(`(?<![\\d年Qq第])(?:第)?([一二三四1-4])季度`, "g"), (_, q) => `${quarterYear(q)}年第${q}季度`],
  [/(今年|去年|前年)[Qq]([1-4])(?!\d)/g, (_, y, q) => `${{ 今年: 2026, 去年: 2025, 前年: 2024 }[y]}年第${q}季度`],
  [/(?<![\d年A-Za-z])[Qq]([1-4])(?!\d)/g, (_, q) => `${quarterYear(q)}年第${q}季度`],
  [new RegExp(`(今年|去年|前年)?(\\d{1,2}|[一二三四五六七八九十]+)月(\\d{1,2})(?:日|号)?(?:到|至|~|-|—)(?:(\\d{1,2})月)?(\\d{1,2})(?:日|号)`, "g"), (_, y, m1, d1, m2, d2) => {
    const year = yearOfMonth(y, m1);
    return `${year}-${monthNum(m1)}-${d1}到${year}-${monthNum(m2 || m1)}-${d2}`;
  }],
  [new RegExp(`(今年|去年|前年)?(\\d{1,2}|[一二三四五六七八九十]+)月(\\d{1,2})(?:日|号)`, "g"), (_, y, m, d) => `${yearOfMonth(y, m)}-${monthNum(m)}-${d}`],
  // metrics by the unit the semantic layer gives them: 件, 单, 人
  [/退了?(?:多少|几)(?:单|笔)|退掉(?:多少|几)(?:单|笔)|退单量|退货单数|退货量|退货数/g, "退单数"],
  [new RegExp(`(?:买|卖|售|销售)?(?:出去|出|掉)?了?(?:多少|几)件${GOODS}`, "g"), "销量"], [/销售数量|销售量|出货量|卖了多少货|卖出去多少/g, "销量"],
  [/(?:一共|总共)?(?:有)?(?:多少|几)(?:个|位|名)?(?:人|顾客|客户|买家|消费者|用户)(?:买过?|下单|下过单|消费过?|购买过?|来买|来过)?(?:东西|商品)?/g, "下单用户数"],
  [/(?:下单|买过?东西|购买|消费|付款|买单)的?(?:人|人数|用户|顾客|客户)(?:数|数量)?(?:有)?/g, "下单用户数"], [/人数/g, "下单用户数"],
  [/(?:成交了|卖了|下了|出了|有)?(?:多少|几)(?:笔|单)(?:订单)?/g, "订单数"], [/(?:多少|几)个?订单/g, "订单数"], [/订单(?:量|总数)|单子(?:数|量)?|(?<![退款订成])单数/g, "订单数"],
  [/退(?:给|还给?)?(?:了)?(?:客户|顾客|用户|买家)?(?:了)?多少钱|退掉了?多少钱|退(?:了)?多少$/g, "退款金额"],
  [/退(?:单|货|款)(?:的)?(?:比例|比率|占比)(?:有多高|有多少|多高|多少)?/g, "退款率"],
  [/退货(?!率|单|量|数)/g, "退款"], // 率 or 额 is the question the layer asks back
  [/平均(?:每一?|一)(?:单|笔)(?:订单)?(?:多少钱|金额|卖多少|花多少)?|(?:每一?|一)(?:单|笔)(?:平均)?(?:大概)?(?:多少钱|花多少钱?|卖多少钱?|金额)/g, "笔单价"], [/平均订单价|订单均价|笔均/g, "笔单价"],
  [/(?:人均|每人|每个人|平均每人|平均每个人|平均一个人|一个人|每位(?:顾客|客户|用户)?)(?:平均)?(?:大概)?(?:花费|花销|消费|花|买)?了?(?:多少钱?|多少)?/g, "客单价"], [/人均(?:花费|消费金额|客单)|平均客单|客单(?!价)/g, "客单价"],
  [/回头客(?:的)?(?:比例|占比|率|多不多|有多少|多吗)?|二次购买|再次购买|老客复购|复购(?:的)?情况|回头率/g, "复购率"],
  [/(?<!平均)(?:消费|花)了?多少钱?|(?<!平均)消费(?:金)?额|买了多少钱/g, "成交额"], [/成交(?:了)?多少(?:钱|金额)?|交易(?:了)?多少(?:钱|金额)?/g, "成交额"],
  [/最赚钱|赚得?最多|最挣钱/g, "毛利额最高", "“最赚钱”按毛利额统计。语义层没有净利润。"],
  [/(?:赚|挣)了?(?:多少|几个)(?:钱)?|赚(?:了)?钱(?:吗)?(?:多少)?|赚头/g, "毛利额", "“赚了多少”按毛利额统计。语义层没有净利润。"],
  [/实际收到|实际到手|到手|进账/g, "实收金额"],
  [/(?:用户|客户|顾客)?实付(?:总额|金额|合计|总金额)/g, "成交额"],
  [/卖得?(?:怎么样|咋样|如何|好不好|好吗|好么|怎样|行不行)|生意(?:怎么样|咋样|如何|好不好|怎样)?|销售情况|经营情况|卖得多不多/g, "销售额"],
  [/卖了多少(?!钱|件|单|货)|卖出(?:去)?(?:了)?多少钱/g, "卖了多少钱"],
  // dimensions in everyday words
  [/哪一?个?月份?(?![\d])/g, "哪个月份"], [/哪一?天/g, "哪个日期"], [/(年龄段|年龄层|等级|渠道)的(?:人|用户|顾客|客户|会员)/g, "$1"],
  [/(哪家|哪个|哪些|每家|各家|各|每个|所有|不同)店(?!铺)/g, (_, p) => `${p === "每家" ? "每个" : p === "各家" ? "各" : p}门店`], [/(哪|各|每)一?类(?:商品|东西|产品|货)?/g, (_, p) => `${p === "哪" ? "哪个" : p === "每" ? "每个" : "各"}品类`], [/什么(?:品类|类别|类目)/g, "哪个品类"],
  [/(哪|各|每)一?个牌子|(哪|各)个?牌子|牌子/g, "品牌"], [/哪一?款(?:商品|产品)?|哪个(?:东西|货|单品)|什么(?:商品|东西|货)|啥(?:商品|东西|货)/g, "哪个商品"],
  [new RegExp(`(${PACK.dimensions.city.values.join("|")})的?(?:店|门店)(?!铺)(?=.*(?:复购|退款|GMV|成交|客单|笔单|订单|单量|销量|流水|下单))`, "g"), "$1"],
  [/[两三四五六七八九十几]家店/g, "各门店"],
  [/各地(?:区)?|各个?地方|每个地方|每个?片区/g, "各区域"], [/哪个?地方|哪边|哪片|哪块/g, "哪个区域"], [/(?:从哪|通过哪|哪条)(?:个)?(?:渠道)/g, "哪个渠道"], [/实体店|线下店|店里买/g, "线下门店"],
  [/(普通|银卡|金卡|黑金)(?:卡)?(?:会员)?(?:用户|客户|顾客|人群)?(?![等级])/g, "$1会员"], [/(?:各|每个|不同)(?:等级|级别)(?:的)?(?:会员|用户|客户)?|(?:什么|哪个|哪种|哪类)等级(?:的)?(?:会员|用户|客户)?/g, "各会员等级"],
  [/(?:各|每个|不同|按)年龄(?:段|层)?/g, "各年龄段"], [/(\d{2})(?:到|至|~|—)(\d{2})岁/g, "$1-$2岁"], [/(\d{2}-\d{2}岁|55岁以上)(?:的)?(?:用户|人群|会员|客户|顾客|人)/g, "$1"],
  [new RegExp(`哪${NUM}(个|家|款|名)`, "g"), "前$1$2"],
  // comparisons: the change itself comes out of the compare query
  [/(同比|环比)(?:增长率|增幅|涨幅|跌幅|增速|增减|涨跌|(?:涨|跌|增长|下降|下滑|上升|变化|多|少|高|低)了?多少|(?:涨|跌|增长|下降|下滑|上升)了(?:吗|没有?)?(?=$|[？?。！!,，]))/g, "$1"],
  [/(?:跟|和|与|较|相比|比)(?:上上个?月|上个?月|上月)(?:相比|比)?(?:的)?(?:(?:涨|跌|多|少|高|低|增长|下降)了?多少|(?:涨|跌|增长|下降)了(?:吗|没有?)?(?=$|[？?。！!,，]))?/g, "环比"],
  [/(?:跟|和|与|较|相比|比)去年(?:同期|同月|同季度|同一时间)?(?:相比|比)?(?:的)?(?:(?:涨|跌|多|少|高|低|增长|下降)了?多少|(?:涨|跌|增长|下降)了(?:吗|没有?)?(?=$|[？?。！!,，]))?/g, "同比"],
  [/走势图|变化趋势|趋势图|怎么变的|怎么走的/g, "趋势"],
  [/排个序|排一下|排一排|排排序/g, "排序"], [/比重|份额/g, "占比"],
];
function quarterYear(q: string): number { return "四4".includes(q) ? 2025 : 2026; }
const CN_MONTHS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const monthInt = (m: string) => (/^\d+$/.test(m) ? Number(m) : CN_MONTHS[m] ?? 0);
const monthNum = (m: string) => String(monthInt(m)).padStart(2, "0");
function yearOfMonth(y: string | undefined, m: string): number {
  if (y) return { 今年: 2026, 去年: 2025, 前年: 2024 }[y] ?? 2026;
  return monthInt(m) < 10 ? 2026 : 2025; // the latest such month before today (2026-10-01)
}

const SELLS_BEST = /卖得?(?:最好|最多|最火|最快)|最好卖|最能卖|最畅销|卖爆|买得?最多|最受欢迎/g;
const SELLS_WORST = /卖得?(?:最差|最少|最慢|最不好)|最不好卖|卖不动|最难卖|买得?最少|最不受欢迎/g;

// ---------------------------------------------------------------- words beyond the Python planner's screens
const WRITE_EXTRA = /(?:帮我|给我|麻烦|请)把?.{0,12}(?:改掉|改成|改为|改一下|调整|调高|调低|新增|录入|添加|作废|撤销|回滚|恢复|重置|修正|纠正|抹掉|销毁|删)|(?:调高|调低|改一下|改掉|录入|作废|回滚|抹掉|销毁)|(?:新增|增加|加|插入?)一(?:条|笔|个|行)|退掉这|取消(?:这笔|这个|这单|订单)|给.{0,12}(?:退款|打折|加积分|发券)|把.{0,16}(?:删|改|调|加|减|设为|设成)/;
const SENSITIVE_EXTRA = /手机(?!壳|膜|支架|配件)|号码|微信号|QQ号|姓名|真实名字|名字和|地址|身份信息|个人信息|隐私|账号密码|卡号/i;
const EXPORT_EXTRA = /导一份|拉一份|拉个?清单|(?:客户|会员|顾客|用户|订单)(?:名单|清单|列表|明细|信息|资料)|一条一条|逐行|原始数据|原始记录|全部记录|所有记录|所有(?:客户|会员|顾客|用户)|全部(?:客户|会员|顾客|用户)|每(?:个|位)(?:客户|会员|顾客|用户)|(?:列出|导出|给我看|看看)每一(?:单|条)|明细/;
const FORECAST_EXTRA = /接下来|以后|今后|下一?个?季度|下一?个?月|下(?:一)?年|后年|预判|估计.{0,6}(?:多少|能)|还能涨|会涨|会跌|趋势会/;
const WHOLE = /全公司|整个公司|我们公司|咱们公司|咱公司|公司整体|公司总|全集团|集团整体|全国(?:所有|范围)?|全部区域|所有区域|所有大区|全部大区|其他(?:区域|大区|地区|片区|城市|门店|店)|其它(?:区域|大区|地区|片区|城市|门店|店)|别的(?:区域|大区|地区|片区|城市|门店|店)|隔壁(?:区域|大区|门店|店|片区|城市)?|全部门店|所有门店|所有店|全部城市|所有城市|兄弟门店|总部/;
const WHOLE_ALL = /全公司|整个公司|我们公司|咱们公司|咱公司|公司整体|全集团|集团整体|全国(?:所有|范围)?|总部|咱家|咱们家|我们家/g;
const COST_WORD = /成本|进货价|进价|采购价/;
const GREETING_OR_HELP = /^(?:你好|您好|hi|hello|hey|嗨|在吗|在不在|早上好|下午好|晚上好)[!！,，.。~～]*$|你(?:能|可以|会)(?:查|做|干|回答|问|帮我)(?:些)?(?:什么|啥)|(?:能|可以)(?:查|问|做)(?:些)?(?:什么|啥)|(?:怎么|如何)用|有(?:什么|啥)(?:功能|指标)|都能查/i;
const CAUSAL = /为什么|为啥|为何|什么原因|原因是|怎么回事|怎么办|如何提升|怎么提高|怎么提升|如何提高|有什么建议|给点建议/;
const OFF_TOPIC = /天气|笑话|写诗|写首|讲个|新闻|股票|吃什么|电影|翻译|写代码|你是谁|几点/;
const NEGATION = /除了|除去|以外|之外|不含|不包括|不算|排除|去掉|剔除|扣除|非会员/;
const COUNT_OF_DIM = /(?:多少|几)(?:家|个|种|款|座|类)?(门店|店铺|店|城市|区域|大区|地区|商品|产品|品牌|品类|渠道|会员|客户)(?:呢|吗|啊|呀)?[?？。!！]*$/;

// ---------------------------------------------------------------- closed reading
const TIME_MASKS: RegExp[] = [
  /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:(?:到|至|~|－|—|-)(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)?/g,
  new RegExp(`(?:今年|去年|前年)${NUM}月份?`, "g"), /\d{4}(?:年|-|\/)?(?:第)?[1-4一二三四]季度/g, /\d{4}(?:年)?[Qq][1-4]/g, /\d{4}年(?:上|下)半年/g,
  /\d{4}(?:年|-|\/)\d{1,2}(?:月份?)?/g, /\d{4}年(?:全年|整年)?/g, /双十一|双11|618|六一八/g,
  new RegExp(`(?:最近|近|过去|前)\\s*${NUM}\\s*(?:个)?(?:天|日|周|星期|个月|月|年)`, "g"), /(?:最近|近|过去)(?:一|1)年/g,
  /上上个?月份?|上个?月份?|本月份?|这个月|当月/g, /上个?季度|本季度|这个季度|当季/g, /上周|上个星期|上星期|本周|这周|这个星期/g, /前天|昨天|昨日|今天|今日/g,
  /(?:今年|去年|前年)?(?:上|下)半年/g, /今年以来|年初至今|今年|本年|去年|前年/g, new RegExp(`${NUM}月份?`, "g"), /同期|全年|整年/g,
];
const RANK_MASKS: RegExp[] = [
  new RegExp(`(?:前|top|排名前|最高的|最多的|最好的)\\s*${NUM}\\s*(?:个|名|位|家|款|条|大|种|座)?`, "gi"),
  new RegExp(`(?:后|倒数|最低的|最少的|最差的)\\s*${NUM}\\s*(?:个|名|位|家|款|条|大|种|座)?`, "g"),
  /最高|最多|最大|最好|最强|第一|领先|冠军|最低|最少|最小|最差|垫底|最不/g, /哪个|哪家|哪一|哪款|哪位|哪种|哪些|是哪|谁/g, /排名|排行|排序|从高到低|降序|从低到高|升序|由高到低|由低到高/g,
  /更(?:高|低|多|少|好|差|大|小)|(?:高|低|多|少|大|小)一些/g, /谁(?:高|低|多|少|大|小)|哪个(?:高|低|多|少|大|小)/g,
];
const FILLER = [
  "帮我", "帮忙", "麻烦", "请问", "想问", "想看", "想知道", "我想", "我要", "给我", "告诉我", "看看", "看下", "瞅瞅", "瞧瞧", "查查", "查下", "查询", "查一查", "统计", "一下", "有多少", "是多少", "多少", "共有",
  "怎么样", "咋样", "怎样", "如何", "情况", "数据", "数字", "结果", "总共", "一共", "合计", "总计", "总和", "加起来", "累计", "整体", "总体", "大概", "大约", "分别", "能不能", "可不可以", "可以", "是不是", "有没有", "对比", "比较", "比一比", "比一下",
  "多少钱", "高不高", "低不低", "多不多", "大不大", "好不好", "行不行", "卖的", "买的", "卖得", "卖了", "卖出", "有多高", "有多大", "多高", "多大", "列一下", "列出来", "列出", "列下", "显示", "展示", "拉一下", "出一下", "算一下", "算下", "排个序", "排一下", "拆一下", "拆开", "拆分", "分开", "分布", "占比", "维度", "角度", "我们", "咱们", "公司", "这边", "那边", "现在", "目前", "当前", "这段时间", "最近", "近期",
  "什么", "谢谢", "多谢", "你好", "您好", "的话", "时候", "期间", "期内", "里面", "当中", "之间", "以来", "这块", "方面", "相关", "具体", "详细", "那么", "还有", "以及", "另外", "同时", "然后", "只看", "只要", "仅看", "就看", "单看", "再看", "换成", "改成", "改为", "如果是", "如果换成", "还是", "都是", "到底", "究竟", "一共是", "总数", "呢", "吧", "按照", "全部", "所有", "不同", "每个", "各个",
  "的", "了", "吗", "啊", "呀", "哦", "嘛", "么", "是", "在", "有", "和", "与", "跟", "及", "或", "把", "给", "看", "查", "要", "想", "能", "请", "下", "个", "里", "中", "也", "都", "还", "就", "再", "又", "很", "那", "这", "该", "我", "您", "你", "咱", "们", "一", "点", "过", "并", "呗", "哈", "嗯", "噢", "啦", "按", "分", "拆", "排", "比", "各", "每", "到", "至", "区", "市", "几", "呐", "ok", "段", "层",
].sort((a, b) => b.length - a.length);

/** How many separate periods a message names. The planner reads one, so "8月和9月" must not silently become 8月. */
export function periodsNamed(text: string): number {
  const spans: [number, number][] = [];
  for (const re of TIME_MASKS) {
    if (re.source === "同期|全年|整年") continue;
    for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let count = 0, end = -1;
  for (const [s0, e0] of spans) {
    if (s0 > end) count++;
    end = Math.max(end, e0);
  }
  return count;
}

/** What is left of the message once the layer's words, periods, rankings and filler are gone. */
export function leftovers(text: string): string[] {
  const chars = [...Array(text.length).keys()].map((i) => text[i]);
  const blank = (s: number, e: number, mark = "\0") => { for (let i = s; i < e; i++) if (chars[i] !== "\0") chars[i] = mark; };
  for (const m of planner.vocab.match(text)) blank(m.start, m.end);
  const applyAll = (re: RegExp) => {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(global)) blank(m.index!, m.index! + m[0].length);
  };
  for (const re of [...TIME_MASKS, ...RANK_MASKS, MOM_RE, YOY_RE, /趋势|走势|变化|波动|曲线/, INJECTION_RE, FOLLOWUP_MASK]) applyAll(re);
  for (const word of FILLER) {
    const mark = word.length === 1 ? "\x01" : "\0"; // one character may be part of an unknown word: keep it in the name
    let at = chars.join("").toLowerCase().indexOf(word);
    while (at !== -1) {
      blank(at, at + word.length, mark);
      at = chars.join("").toLowerCase().indexOf(word, at + word.length);
    }
  }
  if (/和|跟|与|比|哪|谁|是不是/.test(text)) {
    const tail = text.match(/(?:高|低|多|少|大|小|好|差|强|弱)(?=[吗呢吧啊呀？?。!！,，]*$)/);
    if (tail) blank(tail.index!, tail.index! + tail[0].length);
  }
  const restored = chars.map((c, i) => (c === "\x01" ? `\x01${text[i]}` : c)).join("");
  const runs = restored.split(/[\0\s,，。.、!！?？;；:：()（）《》"“”'‘’\-—~/]+/)
    .map((run) => run.replace(/^(?:\x01.)+|(?:\x01.)+$/g, "").replace(/\x01/g, ""))
    .filter(Boolean);
  return [...new Set(runs)];
}
const FOLLOWUP_MASK = /^(?:那|那么|换成|改成|再看|再按|按|如果是|如果换成|看看|还有)/;

// ---------------------------------------------------------------- SQL pasted into the question box
const SQL_HEAD = /^\s*(?:select|with\s+\S+\s+as|with\s+recursive|insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s+(?:table|view|index)|create\s+(?:table|view|index|temp)|alter\s+table|attach\s+database|detach\s+database|pragma|vacuum|replace\s+into|truncate|explain|reindex)\b/i;
const SQL_INSIDE = /\bselect\b[\s\S]+?\bfrom\b[\s\S]*$/i;
export function pastedSql(question: string): string | null {
  const text = question.normalize("NFKC").trim();
  if (SQL_HEAD.test(text)) return text;
  const inner = text.match(SQL_INSIDE);
  return inner ? inner[0].trim() : null;
}

// ---------------------------------------------------------------- next steps
function scopeExamples(user: PackUser): string[] {
  if (user.scope_type === "all") return ["上个月各区域的GMV", "近6个月退款率趋势", "上个月销量前5的商品"];
  if (user.scope_type === "region") {
    const name = Object.entries(PACK.lookups.region_codes).find(([, c]) => c === user.regions[0])?.[0] ?? "";
    return [`上个月${name}的GMV`, "上个月各城市的GMV", "近6个月退款率趋势"];
  }
  return ["上个月的GMV", "近30天每天的订单数", "上个月各渠道的GMV"];
}
export function describePlan(plan: Plan): string {
  const time = plan.time.explicit ? plan.time.label.replace(/（.*?）/g, "").replace(/\s+/g, "") : "上个月";
  const filters = Object.entries(plan.filters).map(([, v]) => v.join("和")).join("");
  const dims = plan.dimensions
    .filter((d) => !(d in plan.filters))
    .map((d) => (PACK.dimensions[d].is_time ? (d === "month" ? "每月" : "每天") : `各${labelOf(d)}`))
    .join("");
  const metrics = plan.metrics.map(labelOf).join("和");
  const compare = plan.compare === "yoy" ? "同比" : plan.compare === "mom" ? "环比" : "";
  return `${time}${filters}${dims}的${metrics}${compare}`;
}

// ---------------------------------------------------------------- the whole reading
export interface Pending { question: string; term: string; options: string[]; clarifications: Record<string, string> }
export interface Conversation { lastPlan: Plan | null; pending: Pending | null }
export interface Understood { outcome: PlanOutcome; nextSteps: string[]; asked: string; clarifications: Record<string, string>; rewritten: string }

const metricLabels = () => Object.values(PACK.metrics).map((m) => m.label);
const permissionMetrics = (user: PackUser) => Object.values(PACK.metrics).filter((m) => !m.requires || has(user, m.requires)).map((m) => m.label);

function refused(reason: string, message: string, user: PackUser, nextSteps: string[], suggestions: string[] = []): { outcome: PlanOutcome; nextSteps: string[] } {
  return { outcome: { kind: "refuse", refusal: { reason, message, suggestions }, trace: { planner: "browser" } }, nextSteps: [...new Set(nextSteps.concat(scopeExamples(user)))].slice(0, 3) };
}

export function rewrite(input: string, user: PackUser): { text: string; notes: string[] } {
  let text = simplify(input.normalize("NFKC")).trim();
  const notes: string[] = [];
  for (const [re, to, note] of RULES) {
    const before = text;
    text = typeof to === "string" ? text.replace(re, to) : text.replace(re, to as never);
    if (note && text !== before) notes.push(note);
  }
  const hasMetricNow = () => planner.vocab.match(text).some((m) => m.entry.kind === "metric" || m.entry.kind === "ambiguous");
  const unitDim = () => planner.vocab.match(text).some((m) => m.entry.kind === "dimension" && ["product", "category", "brand"].includes(m.entry.key));
  const bestLabel = () => (unitDim() ? "销量" : "GMV");
  if (SELLS_BEST.test(text)) {
    const metric = hasMetricNow() ? "" : bestLabel();
    if (metric) notes.push(`“卖得最好”按${metric}统计。`);
    text = text.replace(SELLS_BEST, `${metric}最高`);
  }
  SELLS_BEST.lastIndex = 0;
  if (SELLS_WORST.test(text)) {
    const metric = hasMetricNow() ? "" : bestLabel();
    if (metric) notes.push(`“卖得最差”按${metric}统计。`);
    text = text.replace(SELLS_WORST, `${metric}最低`);
  }
  SELLS_WORST.lastIndex = 0;
  if (/卖得?更?(?:多|好|快)/.test(text) && /和|跟|与|比|哪|谁/.test(text)) {
    const metric = hasMetricNow() ? "" : bestLabel();
    if (metric) notes.push(`“卖得多”按${metric}统计。`);
    text = text.replace(/卖得?更?(?:多|好|快)/g, `${metric}更高`);
  }
  // "数码产品的GMV", "华东门店的GMV": the dimension word only describes the value. With a ranking it is a split.
  if (!/(?:前|后|倒数|top)\s*\d|最|排名|排行|排序|哪|分别/i.test(text)) {
    const found = planner.vocab.match(text);
    for (let i = found.length - 2; i >= 0; i--) {
      const a = found[i], b = found[i + 1];
      if (a.entry.kind !== "value" || b.entry.kind !== "dimension" || PACK.dimensions[b.entry.key].is_time) continue;
      if (["", "的"].includes(text.slice(a.end, b.start))) text = text.slice(0, a.end) + text.slice(b.end);
    }
  }
  // "线上上个月" must not read as 上上个月
  text = text.replace(/线上上(个?月|周|季度)/g, "上$1线上");
  // "有哪些" asks for help only when the message names nothing in the layer
  if (text.includes("有哪些") && planner.vocab.match(text).length) text = text.replace(/有哪些/g, "哪些");
  // an identity's own patch said in passing
  const own = user.scope_type === "store" ? /这家店|这个店|这家门店|咱们店|咱店|咱家店|我们店|本店|我店|我的店|我这(?:家|个)?店|我们这家店|我们门店|店里/g : user.scope_type === "region" ? /我们区|本区|我的区|我这个区|我负责的区域?|我们这个?区|我们大区/g : null;
  if (own) text = text.replace(own, " ");
  if (user.scope_type === "all") text = text.replace(WHOLE_ALL, " ");
  return { text: text.trim(), notes };
}

export function understand(question: string, user: PackUser, convo: Conversation, clarifications: Record<string, string> = {}): Understood {
  const asked = question;
  const raw = normalize(simplify(question));
  const context = convo.lastPlan;

  // a clarification answered in words: "按净销售额", "第二个", "就GMV吧"
  if (convo.pending && !Object.keys(clarifications).length) {
    const chosen = chosenOption(raw, convo.pending);
    if (chosen) {
      const merged = { ...convo.pending.clarifications, [convo.pending.term]: chosen };
      return understand(convo.pending.question, user, { ...convo, pending: null }, merged);
    }
  }
  const { text, notes } = rewrite(question, user);
  const done = (r: { outcome: PlanOutcome; nextSteps: string[] }): Understood => ({ ...r, asked, clarifications, rewritten: text });

  if (GREETING_OR_HELP.test(raw)) {
    const metrics = permissionMetrics(user).join("、");
    return done(refused("off_topic", `这里可以问 Leon优选 的经营数字（虚构数据）：${metrics}；可按区域、城市、门店、渠道、品类、品牌、商品、会员等级、年龄段、月份拆分。你的数据范围是“${scopeLabel(user)}”。`, user, []));
  }
  if (CAUSAL.test(raw)) {
    const stripped = raw.replace(CAUSAL, " ");
    const words = text.match(CAUSAL)?.[0] ?? "为什么";
    return done(refused("unknown_term", `“${words}”要的是解释，ProofBI 只回答查得到、能核对的数字，不编原因。可以先看看数字本身。`, user, withoutWords(rewrite(stripped, user).text, [], user)));
  }

  if (user.scope_type !== "all" && WHOLE.test(text)) {
    const m = text.match(WHOLE)![0];
    return done(refused("permission", `你的数据权限是“${scopeLabel(user)}”，无法查询${m}的数据。这里不会只算你的部分再当成${m}回答。`, user, []));
  }
  if (WRITE_EXTRA.test(raw)) return done(refused("write", "ProofBI 是只读的问数工具，不能修改、删除或写入数据。", user, []));
  const withoutProducts = planner.vocab.match(raw).reduce((acc, m) => (m.entry.key === "product" ? acc.replace(raw.slice(m.start, m.end), " ") : acc), raw);
  if (SENSITIVE_EXTRA.test(withoutProducts)) return done(refused("sensitive", "手机号、地址等个人敏感信息不在可查询范围内，ProofBI 只提供聚合指标。", user, []));
  if (EXPORT_EXTRA.test(raw)) return done(refused("export", "ProofBI 只回答聚合指标，不提供订单或客户明细导出。明细需求请走数据团队的审批流程。", user, []));
  if (FORECAST_EXTRA.test(raw)) return done(refused("forecast", `ProofBI 只回答已经发生的数据（截至 ${PACK.calendar.data_end}），不做预测。`, user, []));
  if (COST_WORD.test(raw) && !has(user, "cost")) {
    return done(refused("permission", "成本数据需要“cost”权限，你的账号没有。如需查看请联系财务或数据平台负责人。", user, []));
  }

  const counted = text.match(COUNT_OF_DIM);
  if (counted && !planner.vocab.match(text).some((m) => m.entry.kind === "metric" || m.entry.kind === "ambiguous")) {
    return done(refused("unknown_metric", `语义层里没有“${counted[1]}数量”这个指标。ProofBI 回答订单和销售口径的指标，不数档案有多少条。`, user, []));
  }
  if (/去年同期/.test(text) && !context && periodsNamed(text.replace(/去年同期/g, " ")) === 0) {
    return done(refused("unknown_term", "“去年同期”要和一个时间段一起说，否则不知道要比哪一段。可以问“上个月的GMV同比”。", user, ["上个月的GMV同比"]));
  }
  if (periodsNamed(text) >= 2) {
    return done(refused("unknown_term", "一个问题只能统计一个时间段。想比较两段时间，可以用“环比”“同比”，或者按月看趋势。", user, withoutTimes(text, user)));
  }

  if (OFF_TOPIC.test(text) && !planner.vocab.match(text).some((m) => m.entry.kind === "metric" || m.entry.kind === "ambiguous")) {
    return done(refused("off_topic", "我只回答 Leon优选 经营数据相关的问题，例如“上个月华东区的复购率是多少？”", user, []));
  }

  const outcome = planner.plan(text, user, context, clarifications);
  if (outcome.kind === "refuse") {
    const r = outcome.refusal!;
    const words = leftovers(text);
    const namesTheLayer = planner.vocab.match(text).length > 0 || periodsNamed(text) > 0;
    if (r.reason === "off_topic" && namesTheLayer && !INJECTION_RE.test(text) && !OFF_TOPIC.test(text)) r.reason = "unknown_metric";
    if (r.reason === "unknown_metric") {
      r.message = words.length
        ? `语义层里没有定义“${words.join("”“")}”，为了避免口径不一致，ProofBI 不会临时编一个口径。`
        : "这句话没有说要看哪个指标。可以从下面的指标里选一个再问。";
      r.suggestions = metricLabels();
    }
    r.suggestions = r.suggestions.filter((s) => permissionMetrics(user).includes(s));
    return done({ outcome, nextSteps: nextStepsFor(user, r.reason, text) });
  }
  const words = leftovers(text);
  if (words.length) {
    const quoted = `“${words.join("”“")}”`;
    const reason = words.some((w) => UNKNOWN_METRIC_RE.test(w)) ? "unknown_metric" : "unknown_term";
    const message = NEGATION.test(text)
      ? `语义层不支持排除条件（${quoted}）。答一个不含排除的数字就成了另一个问题，所以 ProofBI 不回答，也不猜。`
      : `语义层里没有${quoted}这个条件。忽略它就成了另一个问题，所以 ProofBI 不回答，也不猜。`;
    return done(refused(reason, message, user, NEGATION.test(text) ? [] : withoutWords(text, words, user)));
  }
  if (outcome.plan) {
    const plan = outcome.plan;
    plan.notes = [...plan.notes, ...notes];
    if (/占比/.test(text)) {
      if (!plan.dimensions.length) {
        return done(refused("unknown_term", "语义层没有“占比”口径，这句话也没有拆分，算不出分母。可以先看各部分的绝对值。", user, withoutWords(text, ["占比"], user)));
      }
      plan.notes.push(plan.limit ? "语义层没有“占比”口径，这里按绝对值排序。" : "语义层没有“占比”口径，这里给出绝对值，占比可以由下方结果行推算。");
    }
    // a brand and a product family together name one product
    if (plan.filters.brand && plan.filters.product) {
      const narrowed = plan.filters.product.filter((p) => plan.filters.brand.some((b) => p.startsWith(`${b} `)));
      if (narrowed.length) {
        plan.filters.product = narrowed;
        delete plan.filters.brand;
      }
    }
    // a trend inside one month has one monthly row: go by day
    const monthAt = plan.dimensions.indexOf("month");
    if (monthAt >= 0 && plan.time.start.slice(0, 7) === plan.time.end.slice(0, 7) && plan.metrics.every((m) => PACK.metrics[m].allowed_dimensions.includes("date"))) {
      plan.dimensions[monthAt] = "date";
      plan.notes.push("时间段不足一个月，按天看。");
    }
    // "线上和线下", "华东和华南": two named values of one dimension mean a comparison
    const mentions: Record<string, number> = {};
    for (const m of planner.vocab.match(text)) if (m.entry.kind === "value") mentions[m.entry.key] = (mentions[m.entry.key] ?? 0) + 1;
    for (const [key, n] of Object.entries(mentions)) {
      if (n >= 2 && !plan.dimensions.includes(key) && plan.metrics.every((m) => PACK.metrics[m].allowed_dimensions.includes(key))) plan.dimensions.push(key);
    }
    // "GMV最高的区域" asks for one row, as "哪个区域GMV最高" does
    if (plan.order && plan.limit === null && plan.dimensions.length === 1 && /(?:最高|最多|最大|最好|最低|最少|最小|最差)的/.test(text) && !/排名|排行|排序|从高到低|从低到高|哪些/.test(text)) plan.limit = 1;
    // "线上" is two channels: say so when they are listed apart
    if (plan.dimensions.includes("channel") && /线上/.test(text)) plan.notes.push("“线上”是小程序和 App 两个渠道，这里分开列出。");
    // the planner's own rule for "前 N" and 环比, now that "最高的" also limits
    const rechecked = validatePlan(plan, user, outcome.trace);
    if (rechecked.kind === "refuse") return done({ outcome: rechecked, nextSteps: nextStepsFor(user, rechecked.refusal!.reason, text) });
  }
  return done({ outcome, nextSteps: [] });
}

function nextStepsFor(user: PackUser, reason: string, text: string): string[] {
  if (reason === "out_of_range") return withoutTimes(text, user);
  if (reason === "unsupported" && (MOM_RE.test(text) || YOY_RE.test(text))) {
    const ranked = text.replace(new RegExp(MOM_RE.source, "g"), " ").replace(new RegExp(YOY_RE.source, "g"), " ").trim();
    const plain = planner.plan(ranked, user, null);
    if (plain.kind === "plan" && plain.plan) {
      const word = MOM_RE.test(text) ? "环比" : "同比";
      const compared = describePlan({ ...plain.plan, limit: null, order: null, compare: word === "同比" ? "yoy" : "mom" });
      return [ranked, compared, ...scopeExamples(user)].slice(0, 3);
    }
  }
  if (reason === "unsupported") {
    const metric = planner.vocab.match(text).find((m) => m.entry.kind === "metric")?.entry.key;
    const allowed = metric ? PACK.metrics[metric].allowed_dimensions.filter((d) => !PACK.dimensions[d].is_time)[0] : null;
    if (metric && allowed) return [`上个月各${labelOf(allowed)}的${labelOf(metric)}`, ...scopeExamples(user)].slice(0, 3);
  }
  return scopeExamples(user);
}

function withoutTimes(text: string, user: PackUser): string[] {
  let stripped = text;
  for (const re of TIME_MASKS) stripped = stripped.replace(re, " ");
  const again = planner.plan(stripped, user, null);
  if (again.kind !== "plan" || !again.plan) return scopeExamples(user);
  const question = describePlan({ ...again.plan, time: { ...again.plan.time, explicit: false } });
  return [question, ...scopeExamples(user)].slice(0, 3);
}

/** The same question without the unknown words, as a question the planner really answers for this identity. */
function withoutWords(text: string, words: string[], user: PackUser): string[] {
  let stripped = text;
  for (const w of words) stripped = stripped.split(w).join(" ");
  // on its own, without the conversation: an inherited filter would suggest a question nobody asked
  const again = planner.plan(stripped, user, null);
  if (again.kind !== "plan" || !again.plan) return [];
  const question = describePlan(again.plan);
  const check = planner.plan(question, user, null);
  return check.kind === "plan" && leftovers(rewrite(question, user).text).length === 0 ? [question] : [];
}

function chosenOption(raw: string, pending: Pending): string | null {
  const [a, b] = pending.options;
  if (/^(?:就|按|选|要|看|用)?(?:第一个|第一种|前者|第1个)(?:吧|口径)?[。!！.]*$/.test(raw)) return a;
  if (/^(?:就|按|选|要|看|用)?(?:第二个|第二种|后者|第2个)(?:吧|口径)?[。!！.]*$/.test(raw)) return b;
  const named = planner.vocab.match(raw).filter((m) => m.entry.kind === "metric" && pending.options.includes(m.entry.key));
  if (named.length !== 1) return null;
  const rest = raw.slice(0, named[0].start) + raw.slice(named[0].end);
  return /^(?:就|按|选|要|看|用|算|是|的|吧|呢|口径|那个|这个|我要|我想看|[,，。.!！\s])*$/.test(rest) ? named[0].entry.key : null;
}

