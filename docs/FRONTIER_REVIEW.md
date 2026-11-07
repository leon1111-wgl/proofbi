# 前沿综述：Text-to-SQL 与语义层（2026-11-07）

目的：判断哪些当前做法值得进 ProofBI 这一轮迭代。入选标准只有两条：访客看得到，或者评审能复核；每个采用的项目都要有一个“去掉它就会失败”的测试或测量。所有来源都在 2026-11-07 读过原文，产品文档的日期以页面标注为准。

| # | 候选 | 日期 | 决定 | 怎么复核 |
|---|---|---|---|---|
| 1 | SQLite 官方 WebAssembly 构建 | npm 3.54.1-build1 | **采用** | `frontend/tests/guard.test.ts`；`scripts/walkthrough.mjs` 输出的 `measure.json` |
| 2 | TrustSQL：不答和答错分开计分 | 2024-07（v6，审稿中） | **采用** | `frontend/tests/scoring.test.ts`；盲测报告的 RS(c) |
| 3 | BIRD-INTERACT：澄清和追问算进评测 | 2025-10，ICLR 2026 Oral | **采用其思路** | 盲测 `followup`、`clarify` 两类；`coverage.test.ts` 的 conversation 组 |
| 4 | P2SQL：提示注入到 SQL 注入 | ICSE 2025 | **采用其威胁模型** | `guard.test.ts` 的 47 条攻击和引擎层用例；页面上可以粘贴 SQL |
| 5 | Open Semantic Interchange（OSI） | 2026-01-27 | 跳过 | 不适用 |
| 6 | dbt MetricFlow 开源 | 2025-10-14 | 跳过 | 不适用 |
| 7 | 已验证查询（Snowflake VQR / Databricks Trusted Assets） | 文档更新至 2026-11 | 跳过 | 不适用 |
| 8 | 浏览器里跑小模型（Qwen3-0.6B） | LoopDesk 2026-11 的实测 | 不做 | 不适用 |

## 采用

### 1. SQLite 官方 WebAssembly

静态演示要在没有服务器的情况下跑真实 SQL。三个候选的实际下载体积（本仓库在 2026-11-07 从 npm 安装后测得，gzip -6 或 -9）：

| 引擎 | 版本 | 原始大小 | gzip 后 |
|---|---|---|---|
| SQLite（`@sqlite.org/sqlite-wasm`） | 3.54.1-build1 | 0.88 MB | **0.41 MB** |
| PGlite（wasm + data） | 0.5.15 | 15.3 MB | 5.1 MB |
| DuckDB-Wasm（`duckdb-eh.wasm`） | 1.33.1-dev57 | 35.9 MB | 8.1 MB |

选 SQLite 不只因为体积。后端本来就是 SQLite，所以同一条 SQL 在两边是同一个方言、同一个结果，可以逐行比对。官方构建还暴露了授权回调：[SQLite 文档](https://www.sqlite.org/c3ref/set_authorizer.html)写明回调只在 prepare 阶段调用，[动作码页面](https://www.sqlite.org/c3ref/c_alter_table.html)写明第 5 个参数是库名、第 6 个是发起访问的最内层视图或触发器。靠这两个参数，浏览器能在引擎层判断“这次读取是不是经由策略视图”，这一点比后端的改写更严，见 [SECURITY.md](SECURITY.md)。

局限：npm 包的页面写明它由社区志愿者维护，并且“只支持浏览器端 JS”（[来源](https://sqlite.org/wasm/doc/trunk/npm.md)）。本仓库的单元测试在 Node 里跑它，能跑但不在官方支持范围内，所以每次发布前还要用真实 Chrome 走一遍流程。OPFS 持久化只能在 Worker 里用（[来源](https://sqlite.org/wasm/doc/trunk/persistence.md)），这里用不到：数据库是只读的内存副本。

### 2. TrustSQL：答错比不答更糟

[TrustSQL](https://arxiv.org/abs/2403.15879)（Lee 等，arXiv v6，2024-07-02，页面标注 under review，没有确定的会议）把可靠性定义成：答对 +1，不答 0，答错 −c，对“本来就不该答”的问题不答也算 +1；c 取 0、10 和样本总数 N。它要回答的问题正是问数系统上线后最要紧的：错数字比没数字代价高。

采用的是计分方式和它背后的判断，不是它的数据集。盲测报告里每一题分成答对、不答、答错，并给出 RS(0)、RS(10)、RS(N)。同样的判断落到产品上，就是这一轮最重要的改动：**闭合阅读**。一句话里只要有语义层解释不了的词，就拒答并点名这个词，而不是忽略它去答另一个问题。“新客的 GMV”不会变成总 GMV。

### 3. BIRD-INTERACT：澄清和追问是评测的一部分

[BIRD-INTERACT](https://arxiv.org/abs/2510.05318)（2025-10-06 提交，v3 2026-03-24，ICLR 2026 Oral）给每个任务配了用户模拟器，任务里包含需要先问清楚的歧义和后续追问。它的数据和模拟器面向大模型，这里用不上，采用的是它的评测观念：一轮对话的结果按对话结束时的状态判定。

具体落地：盲测有 15 组多轮对话和 10 道澄清题；用户用文字回答澄清（“按净销售额”“第二个”）时要回到原问题，而不是把这句话当新问题。后端的规则规划器没有这个能力，所以这一层只在浏览器引擎里。

### 4. P2SQL：模型写的 SQL 是不可信输入

[Pedro 等人的研究](https://arxiv.org/abs/2308.01990)（发表于 [ICSE 2025](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/31/Prompt-to-SQL-Injections-in-LLM-Integrated-Web-Applications-Risks-and-Defenses)）说明提示注入可以变成 SQL 注入，防线不能放在提示词里。ProofBI 的设计本来如此，但静态演示此前只能回放，访客碰不到防线。

这一轮让防线在页面上可以被攻击：在输入框粘贴 SQL，它会跳过规划器，按不可信 SQL 走安全校验、行级权限和执行层。后端的 47 条攻击用例原样跑过浏览器的校验器，要求结论和安全级别都与后端一致。

## 跳过

### 5. Open Semantic Interchange

Snowflake 在 [2026-01-27](https://www.snowflake.com/en/blog/open-semantic-interchanges-specs-finalized/) 宣布 OSI 规范第一版发布（Apache 2 许可），目标是让语义层能在不同工具之间交换。导出一份 OSI 文件在技术上不难，但这个演示里只有一个消费者，访客看不到任何差别，也没有另一端可以验证导出是否正确。等真的要对接第二个工具时再做。

### 6. dbt MetricFlow

dbt Labs 在 [2025-10-14](https://www.getdbt.com/blog/open-source-metricflow-governed-metrics) 把 MetricFlow 以 Apache 2.0 开源。它是成熟的指标编译器，但依赖 Python 和 dbt 工程，进不了浏览器；换掉现有 YAML 和编译器也不会让任何一个答案变得不同。如果语义层增长到需要多跳指标和时间粒度对齐，应该优先考虑它而不是继续扩展自研编译器。

### 7. 已验证查询

[Snowflake 的已验证查询库](https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-repository)和 [Databricks 的 Trusted Assets](https://docs.databricks.com/aws/en/genie-agents/tune-quality) 都是把人工确认过的 SQL 交给模型复用，命中时标记为已验证。这解决的是“模型自由写 SQL 不可信”。浏览器引擎里所有 SQL 都由语义层编译，每个答案都会带这个标记，一个永远亮着的标记不传递任何信息。接入真实模型写 SQL 之后，这是优先要做的第一项。

### 8. 浏览器里跑小模型

不做。LoopDesk 已经实测过同一条路（Qwen3-0.6B，约 350 MB，约 1.4 GB 显存）：SwiftShader 上约 11 分钟后报 `Grammar matcher rejected the newly sampled token`，而且最多只能在 150 道盲测题里多答对 1 道。这里没有理由认为结果会不同：手机基本跑不动，规划器的错误又要靠闭合阅读兜底。首轮盲测里 18 道“该答没答”都是口语说法，确实是模型能改善的方向，但这件事应该留给真实模型的离线评测（`docs/EVALUATION.md` 末尾），而不是 350 MB 的下载。
