# SUPERCRZY 生态关联深度研究（2026-08-20 实时版）

> 调研对象：supercrzy.com（认知层/媒体端） + SUPERCRZY BOT（执行层/Agent 平台）
> 调研方式：实时抓取 supercrzy.com 首页 / Agent / CRAZE / About / Rank 五个真实页面 + 本地项目核查（README / merge-plan / git log）
> 日期：2026-08-20

---

## 一、supercrzy.com 当前状态（实时抓取确认）

**定位**：AI 决策层媒体 —— "Stay Crazy. Think Clear. About AI."，报道"后果 > 公告"。

| 板块 | 职能 | 实时证据（2026-08-20） |
|---|---|---|
| News | 后果报道 | 头条《OpenAI Found a Way to Watch for AI Misuse...》等，当日 3 major moves |
| Rank | 模型决策榜 | Claude Opus 5 $10 居首；中国模型 Kimi K3 / GLM-5.3 / Qwen3.8 / DeepSeek V4 Pro 0813 / V4 Flash 0731 均在列 |
| Lab | 实测评测 | 摩擦、可靠性、日常可用性 |
| Topics | 主题聚合 | 分层阅读 |
| Agent | 追踪 10 个 Agent | Codex / OpenClaw / Claude Code / Browser Use / Hermes / OpenHands / Devin / Cursor / OpenAI Agents SDK / Computer Use，按 coding/browser/workflow/builder 分类，带 Heat 热度榜 |
| CRAZE | 理解层（Reading Layer） | "每页一答、只给一条下一步"；明确写着 **escalate 到 SuperCrzy Agent**（深层任务升级入口） |

**统计（实时）**：CRAZE 页 198 breakouts tracked / 2 major moves today / 2.9K total reads。

**两个关键原文（网站自己写的）**：
- CRAZE 页：*"...or escalate into SuperCrzy Agent when the task becomes deeper than reading."*
- Agent 页：*"CRAZE should explain. Agent should route action after understanding."*

---

## 二、SUPERCRZY BOT 当前状态（本地核查）

**定位**：可运行 AI Agent 平台 —— 统一大脑 + Agent Loop + 多工具 + 多渠道网关，DeepSeek V4 原生，200+ 模型（OpenAI 兼容）。

| 能力 | 说明 |
|---|---|
| Agent Loop | 多轮推理 + 工具执行（文件/Shell/搜索/抓取/记忆/技能），执行时间线可视化、可分支可续跑 |
| Playbook | 任务后自动复盘，同类任务复用经验 |
| Ghost mode | 监听工作区文件变化，主动建议低侵入代码干预 |
| 技能系统 | 29 个内置技能 + 自动匹配 + GitHub 第三方技能安装 |
| 长期记忆 | 跨会话自动提取固化重要事实（当前 18 条） |
| 多渠道 | Web / Telegram / QQ / 微信 / 钉钉 / 飞书 / Slack / Discord / 企业微信 |
| 安全 | 敏感工具确认制、危险命令黑名单、沙箱三层防御（V0.3.0） |

---

## 三、核心关联点（本次研究的发现）

### 1. 同名品牌，天然一体
网站与 Bot 共用 SUPERCRZY 品牌，口号同源（Stay Crazy. Think Clear.）。这是最强的关联基础——不存在品牌认知割裂问题。

### 2. 网站已为 Bot 预留出口（最重要的发现）
CRAZE 页面**明文写着 escalate 到 SuperCrzy Agent**。也就是说网站侧在架构设计上已经承认"读完文章之后，深层任务应该交给 Agent"——但**目前这个出口是文字承诺，没有真实执行通道**（没有按钮、没有 deep link、没有任务卡协议）。这是合并方案 M1 的直接落点。

### 3. 认知层 × 执行层，分工互补
| 维度 | supercrzy.com | SUPERCRZY BOT |
|---|---|---|
| 角色 | 让人**想明白**（理解/判断/路由） | 让人**做出来**（执行/产出） |
| 输出 | 一篇文章、一条下一步 | 一个可验证的结果 |
| 数据形态 | 结构化内容（News/Rank/Lab/Topics） | 任务执行记录、工具使用数据 |

### 4. Agent 板块缺自家产品（可立即补的关联点）
网站 Agent 板块追踪 10 个 agent，但**没有 SUPERCRZY BOT 自己**。自家执行层产品未上榜、无 product dossier。补充自家档案 = 零成本自宣 + 让"网站管理解、Bot 管行动"的叙事闭环。

### 5. 数据回流空间大
Bot 的模型使用/实测数据（哪些模型真正被跑、哪些工具被常用）可回流网站 Rank/Lab 选题依据——这是 merge-plan M3 的核心，也是网站"Experience bias（真实使用 > 装饰性指标）"方法论的天然数据源。

### 6. 合并方案文档已存在，尚未执行
`packages/server/docs/supercrzy-merge-plan.md`（2026-06 版）已给出三阶段方案：M1 打通（网站加"交给 BOT"按钮 + 任务卡）→ M2 植入（Bot 内建 CRAZE 技能 + 决策助手模式）→ M3 闭环（使用数据回流选题 + 品牌导流）。git log 显示 V0.3.0 之后无合并相关提交，**方案仍是纸面状态**。

---

## 四、关联强度评估

| 关联点 | 证据强度 | 可落地性 | 优先级 |
|---|---|---|---|
| 同名品牌 | ★★★★★ 双方同名同源 | 无需动作 | - |
| CRAZE → SuperCrzy Agent 出口 | ★★★★★ 网站明文承诺 | 高：加按钮 + deep link 即通 | P0 |
| 认知层/执行层互补 | ★★★★★ 双方定位文档明确 | 高：叙事可直接对外讲 | P0 |
| Agent 板块收录自家 BOT | ★★★★☆ 板块存在但缺自家 | 中：需补 product dossier | P1 |
| 数据回流选题 | ★★★☆☆ 方法论吻合 | 中：需先有使用数据采集 | P2 |
| M1 任务卡协议 | ★★★☆☆ 方案文档已设计 | 中：需定 JSON 任务卡规范 | P1 |

---

## 五、建议行动（按优先级）

1. **P0 · 打通 CRAZE 出口**：在 supercrzy.com 的 CRAZE / News / Rank 页加"交给 SUPERCRZY BOT"按钮，deep link 到 Bot Web 入口并携带任务卡（JSON）。
2. **P0 · 对外统一叙事**：把"认知层管想明白、执行层管做出来"写成对外定位文案（About 页 + Bot README 同步）。
3. **P1 · Agent 板块收录自家**：为 SUPERCRZY BOT 建 product dossier，归类 General workflow（与 Hermes 同类），挂 Bot 入口。
4. **P1 · 定义任务卡协议**：JSON 任务卡规范（页面 → 意图 → 下一步动作），网站与 Bot 两端共用。
5. **P2 · 数据回流**：Bot 侧记录模型实测/工具使用数据，按周生成"实测热度榜"供网站 Rank/Lab 选题。

---

## 六、一句话总结

**supercrzy.com 是认知层（让人想明白），SUPERCRZY BOT 是执行层（让人做出来）；网站 CRAZE 已在文案中承诺"深层任务 escalate 到 SuperCrzy Agent"，但出口尚未打通——合并方案早已成文（merge-plan.md），只差动手执行 M1。**
