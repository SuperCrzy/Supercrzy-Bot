# supercrzy.com 实时研究报告（2026-08-21）

> 方法：实时抓取 8 个页面（首页/News/Rank/Lab/Topics/Agent/CRAZE/About）+ 首页原始 HTML（64.7KB）关键词核查 + 本地已有研究对比
> 结论一句话：**网站内容侧持续高速更新（今天还在发文章），但"认知→执行"的出口依然只是文字承诺——deep link 零命中，打通仍差网站侧一个按钮。**

---

## 一、六大板块实时状态（2026-08-21 实测）

| 板块 | 定位 | 实时实测要点 |
|---|---|---|
| News | 信号流 | 今日 8/20 头条：OpenAI 反滥用检测 vs Anthropic；8/19 安全事件《AI 已逃脱一周》；作者 Jeff/Emon，均 Editorial 标签 |
| Rank | 模型榜 | 43+ 模型在榜，**Claude Opus 5 三档霸榜前三**（63分/$10/56tk/s）；OpenAI GPT-5.6 系列 5 席、Gemini 3.7 Flash 4 席；中国模型：Kimi K3 #7、GLM-5.3 #8、Qwen3.8 #11-12、DeepSeek V4 Pro #25 |
| Lab | 实测评测 | 硬件实测打分制：ASUS GX10 7.5/10、Intel Arc Pro B70 8.5/10、Rokid Glasses 8.0/10；**新增 "AFTER THE VERDICT" 衔接文案**："When a review becomes an action question, Agent should take over" |
| Topics | 主题聚合 | **10 个核心主题 / 89 篇文章跟踪，更新于 2026-08-21（今天）**；LLM 33 篇居首 |
| Agent | Agent 生态榜 | **Live watchlist — 6 agents tracked**（列表展示 10 席：Codex/OpenClaw/Claude Code/Browser Use/Hermes/OpenHands/Devin/Cursor/OpenAI Agents SDK/Computer Use）；新增 TRUST BOUNDARY 板块（权限/恢复/适配/信任四问） |
| CRAZE | 理解层 | 新增明确三步协议：**01 Read context → 02 Clarify intent → 03 Escalate（"Route into Agent, with SuperCrzy Agent as the recommended deeper entry"）**——仍是文字承诺 |

## 二、首页统计（与上次对比）

| 指标 | 2026-08-20 | 2026-08-21 | 变化 |
|---|---|---|---|
| breakouts tracked | 243 | 243 | — |
| major moves today | 3 | **0** | 回落 |
| total reads | 97.4K | **97.9K** | +500 |

## 三、关键核查：认知→执行出口（与 8-20 对比）

| 检查项 | 2026-08-20 | 2026-08-21 | 结论 |
|---|---|---|---|
| 首页 HTML 中 `supercrzy://` | 0 命中 | **0 命中** | ❌ 无 deep link 出口 |
| task card / bot 按钮 / deep link 关键词 | 0 命中 | **0 命中** | ❌ 无任务卡协议 |
| CRAZE escalate 承诺 | 文字 | 文字（更明确的三步协议） | ⚠️ 仍是承诺 |
| Lab "Agent should take over" | 无 | **有（新增衔接文案）** | ⚠️ 又多一处文字承诺 |

**核心结论不变**：网站侧认知→执行仍是零出口；但新增了 Lab 页 "AFTER THE VERDICT" 和 CRAZE 三步 escalate 协议，说明**产品意图在向"Agent 接管"靠拢**——落地就差按钮。

## 四、其他发现

1. **"手机版"实为响应式**：`<meta name="viewport" content="width=device-width, initial-scale=1.0">`，无独立 m. 子域，同一套响应式布局。
2. 导航新增 `/privacy`、`/terms` 页面（8-20 未见）。
3. About 更新于 2026-05-01，定位"AI media brand taking shape"、自述 "system-level reading companion"（系统级阅读伴侣）——与 CRAZE 定位一致。
4. Agent 板块文案说 6 agents tracked 但列表 10 席，存在文案与列表不一致。
5. 榜单仍无 SUPERCRZY BOT 自家条目（10 席均为外部 agent）。

## 五、与 BOT 生态关联现状（M0-M3 进度）

| 阶段 | 状态 | 本次证据 |
|---|---|---|
| M0 品牌统一 | ✅ 已完成 | 双端橙黄渐变 logo（git 23f54cc） |
| M1 打通（网站→Bot） | ⚠️ 半成品 | Bot 侧 deeplink.ts 就绪；网站侧 0 出口（本次复验 0 命中） |
| M2 植入（Bot 内建 CRAZE） | ❌ 未做 | Bot 无 CRAZE 技能 |
| M3 闭环（数据回流） | ❌ 未做 | 无回流机制 |

## 六、行动建议（更新版）

- **P0**：网站侧加"交给 SUPERCRZY BOT"出口 —— 现在有 CRAZE 三步 escalate 协议 + Lab "AFTER THE VERDICT" 两处现成落点，各自配一个 deep link 按钮即完成 M1
- **P0**：Agent 板块收录自家 dossier（文案 6/列表 10 的不一致正好借机重构）
- **P1**：Bot 内建 CRAZE 技能（"每页一答、只给一条下一步"）
- **P2**：数据回流选题（Topics 已 89 篇，可引入 Agent 使用数据）

## 七、证据

- 首页 HTML：`/tmp/sc_home_0821.html`（64,711 字节）
- 实时抓取：首页 /news /rank /lab /topics /agent /craze /about 共 8 页
- 本地参考：docs/supercrzy-relationship-deep-dive.md（8-20）、docs/supercrzy-merge-plan.md（2026-06）
