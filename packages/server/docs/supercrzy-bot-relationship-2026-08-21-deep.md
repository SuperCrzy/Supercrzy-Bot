# supercrzy.com × SUPERCRZY BOT 关联深度研究（2026-08-21 深挖版）

> 方法：实时抓取网站 8+ 页面（重点深挖 CRAZE 页锚点结构/Rank/Lab/Agent）+ 本地 BOT 代码核查（deeplink.ts / GhostWorkbench / git log）+ 与 8-20、8-21 早前研究对比
> 结论一句话：**网站侧已经把"认知→执行"的接口全部设计好了（协议/预设问题/工作台原型），BOT 侧 deeplink 协议也已就绪——两边都只差"把按钮接上线"。**

---

## 一、本次深挖的新发现（比 8-20/8-21 早前研究更进一步）

### 发现 1：CRAZE 页存在完整的"接口三件套"（锚点级证据）

深挖 CRAZE 页 HTML，发现 3 个关键锚点区块，说明网站产品设计已经把"认知→执行"的接缝设计好了：

| 锚点 | 区块 | 内容 | 意义 |
|---|---|---|---|
| `id="agent-bridge"` | CRAZE / AGENT BOUNDARY | "CRAZE handles understanding. Agent handles deeper action." + 三步协议：01 Read context → 02 Clarify intent → 03 **Escalate**（"Route into Agent, with SuperCrzy Agent as the recommended deeper entry"） | 网站明确定义了 Agent 升级协议，并点名推荐 SuperCrzy Agent |
| `id="prompt-starters"` | PRODUCT BEHAVIORS | 五板块各配一条标准提问：News→"What matters most here?"、Rank→"Which model should I use?"、Topics→"Where is this trend going?"、Lab→"Does this hold up?"、Agent→"Which agent should I care about?" | **这就是 deep link `?q=` 预填问题的天然接口**——每条 prompt 就是现成的深链按钮文案 |
| `id="crazeWorkbenchTitle"` | CRAZE Workbench 原型 | "CRAZE should explain the page, not become another chat product." + Core actions（Summary/Angle/Route/Context）+ 01 Context / 02 Judgment / 03 Route | 网站侧已搭出 CRAZE 工作台原型 UI |

### 发现 2：网站侧已有 3 处"文字承诺出口"，全部缺按钮

| 位置 | 承诺 | 现状 |
|---|---|---|
| CRAZE 页 agent-bridge | Escalate → Route into Agent | 纯文字，无按钮无链接 |
| Lab 页 | "AFTER THE VERDICT"：When a review becomes an action question, Agent should take over | 纯文字，无按钮 |
| Rank 页 | AGENT HANDOFF："Rank should end with a better decision... Open SuperCrzy Agent" | 按钮存在，但 href 指向网站内部 `/agent` 目录，到不了真 BOT |

全站 HTML 检索 `supercrzy://` 仍为 **0 命中**。

### 发现 3：BOT 侧已有 GhostWorkbench（幽灵工作台）框架可复用

`packages/client/src/views/GhostWorkbenchView.vue` 已实现：场景库（scene cards）+ 自定义任务输入 + 实时看板（WebSocket）。
- 现有场景为 health / refactor 等通用执行场景
- **与网站 CRAZE Workbench（Summary/Angle/Route）不同构**——M2 植入时不需要从零做工作台，往 GhostWorkbench 里加 CRAZE 场景即可

---

## 二、关联矩阵（M0-M3 最新状态）

| 阶段 | 状态 | 本次证据 | 缺口 |
|---|---|---|---|
| M0 品牌统一 | ✅ 完成 | git 23f54cc（8-13 官方 logo） | 无 |
| M1 打通（网站→Bot） | ⚠️ 半成品 | Bot 侧 deeplink.ts ✅ 就绪（?q/?session/?workspace + postMessage）；**网站侧 0 出口** | 网站侧加 3 个按钮（CRAZE Escalate / Lab AFTER THE VERDICT / Rank HANDOFF） |
| M2 植入（Bot 内建 CRAZE） | ⚠️ 半成品 | Bot 无 CRAZE 技能，但 GhostWorkbench 框架已在 | 往 GhostWorkbench 加 CRAZE 场景（Summary/Angle/Route） |
| M3 闭环（数据回流） | ❌ 未做 | 无回流机制 | 需设计任务卡回传协议 |

---

## 三、深度关联结论

1. **同名同源、天然一体**：supercrzy.com 是认知层（阅读/判断/决策），SUPERCRZY BOT 是执行层（动手做事）。CRAZE 的定位文案自己写明了边界："CRAZE should explain the page, not become another chat product"——理解归网站，行动归 BOT。
2. **接口已双向设计好，只差接线**：
   - 网站侧：agent-bridge 三步协议（Read context / Clarify intent / Escalate）+ PRODUCT BEHAVIORS 五条 prompt starter + CRAZE Workbench 原型
   - Bot 侧：deeplink.ts（?q= 预填提问 / ?session= / ?workspace= / postMessage）
   - 一一对应：prompt starter → `?q=` 预填；Read context → `?workspace=` 定位；Escalate → `supercrzy://` 唤起
3. **最小改动即可打通 M1**：在 CRAZE 的 Escalate 处、Lab 的 AFTER THE VERDICT 处、Rank 的 HANDOFF 按钮，各放一个 deep link 链接（如 `https://<bot-host>/?q=Which model should I use?`），零后端改动。
4. **BOT 侧缺 CRAZE 技能（M2）**：把网站 PRODUCT BEHAVIORS 五条 prompt 搬进 BOT 作为预设场景（可复用 GhostWorkbench），实现"网站给方向、BOT 给动作"的闭环体验。

---

## 四、优先级建议

- **P0（半天~1天）**：网站侧 3 处出口接 deep link（CRAZE Escalate / Lab AFTER THE VERDICT / Rank HANDOFF）→ M1 打通
- **P0**：Agent 板块收录自家 SUPERCRZY BOT dossier（6 tracked/10 列表的不一致正好借机重构）
- **P1**：GhostWorkbench 加 CRAZE 场景（五板块 prompt starter 内置）→ M2
- **P2**：任务卡协议 + 使用数据回流选题 → M3

---

## 五、证据索引

- CRAZE 页锚点：`id="agent-bridge"` / `id="prompt-starters"` / `id="crazeWorkbenchTitle"`（实时抓取确认）
- Lab 页："AFTER THE VERDICT" 衔接文案（实时抓取确认）
- Rank 页：AGENT HANDOFF 区块 + `href="/agent"`（实时抓取确认）
- Bot deeplink：`packages/client/src/utils/deeplink.ts`
- Bot 工作台：`packages/client/src/views/GhostWorkbenchView.vue`
- 早前研究：supercrzy-relationship-deep-dive.md（8-20）、supercrzy-research-2026-08-21.md、supercrzy-bot-union-plan-2026-08-21.md
