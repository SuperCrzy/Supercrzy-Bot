# SUPERCRZY 生态关联深度研究（2026-08-20 实时版）

> 调研对象：supercrzy.com（认知层/媒体端） × SUPERCRZY BOT（执行层/Agent 平台）
> 方法：实时抓取网站 5 个关键页面 + 本地 supercrzy-agent 项目双线核查（git 证据 + 代码检索）
> 结论一句话：**品牌已统一、deep link 协议已就绪，但网站侧零出口——打通只差"一个按钮"。**

---

## 一、网站侧现状（认知层 · supercrzy.com）

实时抓取确认（首页 / CRAZE / Agent / About / Rank 5 页面）：

| 板块 | 定位 | 2026-08-20 实测要点 |
|---|---|---|
| News | 实时追踪 | 首页统计 243 breakouts tracked / 3 major moves today / 97.4K total reads |
| Rank | 模型榜 | Claude Opus 5 居首；DeepSeek V4 / Kimi K3 / GLM-5.3 / Qwen3.8 系列在列 |
| Lab | 实测验证 | 独立实测栏目 |
| Topics | 主题聚合 | 话题聚合页 |
| Agent | Agent 生态追踪 | 追踪 Codex / OpenClaw / Claude Code / Browser Use / Devin / Cursor 等 10+ agent，**无 SUPERCRZY BOT 自家条目** |
| CRAZE | 内嵌阅读层 | 文案承诺"压缩首页、锐化榜单角度、指出下一条有用路径"，**但仅为文字承诺** |

**关键核查**：抓取首页原始 HTML（64.7KB）全文检索 `supercrzy://`、deep link、任务卡、bot 入口按钮 —— **全部为零命中**。
CRAZE 的"escalate 到 SuperCrzy Agent"仍是纸面承诺，无真实通道（无按钮/无 deep link/无任务卡协议）。

## 二、Bot 侧现状（执行层 · SUPERCRZY BOT）

本地项目核查（packages/client + packages/server + git log）：

| 维度 | 状态 | 证据 |
|---|---|---|
| 版本 | V0.3.0 | git log 最新提交 8fbb170（版本更新功能完善） |
| 品牌 | ✅ **已统一** | 23f54cc（2026-08-13）：采用 supercrzy.com 官方 512px 橙黄渐变 logo，覆盖 sidebar/topbar/welcome/favicon/PWA manifest |
| Deep link 协议 | ✅ **已实现** | `packages/client/src/utils/deeplink.ts`：`supercrzy://` 协议，支持 `?q=`（预填提问）/ `?session=` / `?workspace=`，含 URL 参数 + postMessage 双唤起方式 |
| 技能系统 | 29 个已装 | 含 content-pipeline（内容生产管线），**无 CRAZE 决策助手技能** |
| 多渠道 | 已接入 | TG / QQ / 微信 / 钉钉 / 飞书 / Slack / Discord / 企业微信 |
| 能力 | 执行型 | 沙箱执行、文件读写、网页搜索、记忆系统、MCP 管理 |

## 三、关联点矩阵（最重要的发现）

| 路径 | 状态 | 现状说明 |
|---|---|---|
| **M0 品牌统一** | ✅ 已完成 | 8-13 已采用官方 logo，双端视觉一致 |
| **M1 打通**（网站→Bot 出口） | ⚠️ 半成品 | Bot 侧 deep link 协议已就绪；**网站侧没有"交给 BOT"按钮/任务卡** —— 缺的是网站端一行链接 |
| **M2 植入**（Bot 内建 CRAZE） | ❌ 未做 | 无 CRAZE 决策助手技能；content-pipeline 是内容管线，不是 CRAZE 理解层 |
| **M3 闭环**（数据回流） | ❌ 未做 | Bot 使用数据未回流网站选题，无品牌互相导流 |

**与 2026-08-20 早前研究的差异**：当时结论"合并方案仍是纸面状态"，本次双线核查发现 **M0 已完成、M1 的 Bot 侧技术基础（deeplink.ts）已落地**，合并落地比预期更近。

## 四、行动建议（按优先级）

- **P0（1 天）**：CRAZE 页 + Agent 页各加一个"交给 SUPERCRZY BOT"出口，链接直接走已就绪的 deep link：
  `https://<bot-host>/?q={从当前文章/榜单自动提取的下一步问题}` → M1 当场打通
- **P0**：Agent 板块收录自家 dossier（网站追踪 10+ agent 唯独没有自己，白送的曝光）
- **P1**：Bot 内建 CRAZE 技能（"每页一答、只给一条下一步"决策助手模式），与网站 CRAZE 同名同构
- **P1**：定义任务卡协议（任务卡 task card：标题/输入/目标/回传），替代裸链接，支持 Bot 执行结果回传网站展示
- **P2**：Agent 使用数据（高频任务、热门主题）回流网站选题，形成 M3 闭环

## 五、证据索引

- 网站首页 HTML 检索：`/tmp/sc_home.html`（64.7KB，零 bot 出口命中）
- Bot deep link 实现：`packages/client/src/utils/deeplink.ts`
- 品牌提交：`git show 23f54cc`（2026-08-13，official logo adoption）
- 合并方案原稿：`packages/server/docs/supercrzy-merge-plan.md`（2026-06 三阶段版）
- 早前研究：`docs/supercrzy-relationship-2026-08-20.md`
