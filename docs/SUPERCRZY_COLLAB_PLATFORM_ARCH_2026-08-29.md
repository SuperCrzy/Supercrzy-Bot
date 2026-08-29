# SUPERCRZY 超级协作平台 — 架构设计文档

版本：v0.1（设计定稿）
日期：2026-08-29
状态：设计完成，待执行

---

## 0. 文档目的

把"超级协作平台"从概念落地为可执行的技术方案。本文档是**施工图**，后续所有开发以本文为准，含：
- 产品定位与用户流程
- 两种模式（半自动 / 全自动议院）
- 多 AI 协作编排（actor / 群聊 / 议院 / 容错）
- 分层质检（L1/L2/L3）
- 内置浏览器（Playwright + 画面小窗）
- 授权卡壳解决方案
- 收敛防发散机制
- 数据模型与 API 草案
- 分阶段推进计划

---

## 1. 产品定位

**一句话**：用户只给"想法 + 最终验收"，中间由"执行 AI → 质检 AI → 议院"分层把关，交付"最完美结果"。

**形态**：侧边栏独立入口 →「超级协作平台」工作台（区别于普通对话区）。

**三种模式**（用户发任务时选择，提供智能默认）：

| 模式 | 阵容 | 用于 | 默认 |
|---|---|---|---|
| 半自动 | 执行 AI + 质检 AI（1-2 个） | 常规任务 | ✅ 默认 |
| 自动 | 执行 AI + 多个把关 AI | 重要任务 | 可升 |
| 议院（全自动） | 执行 AI + 2-6 个不同模型族 AI 审查 | 关键/研究 | 手动选 |

**议院数量档位**（不设无限，防成本失控与发散）：
- 标准：3 个
- 深度：最多 6 个
- 上限锁 6，无"无限"选项
- 质量决定性因素 = 模型族多样性 + 证据，而非数量

---

## 2. 用户核心流程

```
用户发任务
  → 选模式（默认半自动）
  → 配置授权策略（见 §6）
  → 一次授权（+ 超时自动兜底）
  → 执行 AI 交付 v1（复用 runAgentLoop）
  → 分层质检（L1→L2→L3，见 §5）
  → 执行 AI ↔ 质检/议院 商议（带证据，可反驳）
  → 多轮收敛
  → 全绿 → 交付用户验收
人只在两端：给想法 + 签字。
```

---

## 3. 界面编排（三分栏对齐）

| 栏 | 内容 |
|---|---|
| 左侧边栏 | 会话列表 + **优质流水线看板**（执行/质检/商议/待验收 阶段状态） |
| 中间对话区 | **多 AI 对话流**：执行 AI / 质检 AI / 议院 各自身份、头像、气泡色 |
| 右侧边栏 | **AI 浏览器实时画面**（常驻小窗）+ 现有产物/文件 tab（详情面板顶部） |

关键决策：AI 浏览器用**常驻吸顶小窗**（用户 AI 干活时始终可见），下面保留现有 tab。

---

## 4. 多 AI 对话（actor 机制）

### 4.1 消息模型扩展
```ts
interface ChatMessage {
  role: 'user' | 'assistant'
  actor: '你' | '执行AI' | '质检AI' | '议院' | 'Kimi' | 'GPT' | ...
  content: string
  evidence?: { file?: string; line?: number; repro?: string }[]  // 审查证据
  createdAt: number
}
```
- `role` 保留 user/assistant 向后兼容
- 新增 `actor` 标识发言人，前端据此渲染头像/名字/气泡色
- 支持 `@执行AI / @质检AI / @议院` 指定发言人

### 4.2 对话编排器（`services/council-engine.ts`）
- 维护单条对话流的消息数组
- 每轮决定"由哪个 actor 发言"（执行/质检/议院/你）
- 所有 actor 共享同一份上下文（质检 AI 能看到执行 AI 的产出和文件）

### 4.3 前端渲染（ChatView 扩展）
- 按 `actor` 渲染不同头像 / 名字 / 气泡色
- 右栏顶部 AI 浏览器常驻小窗

---

## 5. 分层质检

### L1 机器客观检查（确定性，零 AI 发散、低成本）
用现有 `shell_exec` 跑固定命令，产出结构化报告：
```
npm run lint         → tsc 报错清单
npm test             → 测试 pass/fail
curl <api>           → 接口状态码 / 返回体
截图(各尺寸)          → 界面渲染图（需 P2 浏览器）
```
**关键**：L1 不是 AI 拍脑袋，是可复现、确定性的命令。

### L2 一个质检 AI（消费 L1 证据做判断）
- system prompt：质检员人设，拿 L1 报告 + 需求清单
- 逐条核对：需求实现度 / L1 报错是否真 bug / L1 未覆盖的逻辑缺陷
- 输出**带证据**的问题清单（文件:行号 / 复现方法）

### L3 议院/多 AI（仅主观争议才启用）
- L2 判断"纯主观审美/策略争议"时才丢进议院民主评议
- 大多数可客观判定任务在 L2 结束，不浪费

### 质检维度（可配角色阵容）
| 角色 | 维度 | 技术动作 |
|---|---|---|
| 产品经理 | 功能完整性 | 对照需求清单逐条 |
| 视觉主管 | 设计美学 | 各尺寸截图审查 |
| 质检中心 | 工程质量 | 接口探测/lint/test |
| 架构安全 | 健壮性 | 代码审查/安全 |

> 权衡：默认用"分层"（L1机器+L2单AI），展示时再"角色化"（给剧本）。避免硬分 4 角色带来的高成本 + 发散 + 表演。

---

## 6. 授权与卡壳解决方案

### 6.1 现状（已实现，直接复用）
`agent.ts:73-82` `waitForToolConfirmation`：
- `readSetting('toolAutoApproveSeconds')` > 0 → 超时自动 `allow`
- 前端设置页有 radio（0 关闭 / 5s / 10s），当前默认 5s
- `ToolCallBlock.vue` 有倒计时 "正在自动执行" UI

### 6.2 平台层升级
- 发任务时**显式配置授权策略**（半自动默认 5s，议院默认 10s，可改 0=手动）
- 自动授权**不覆盖危险操作**（删除/清库/外发/花钱 → 仍强确认）
- 原则一：**超时自动放行解决"卡壳"，危险操作保留确认解决"失控"**

---

## 7. 容错降级（防某 AI 欠费/卡壳卡死流水线）

**总原则**：每个 AI 都是"可替换的"，没有一个"不可或缺的单点"。任何单 AI 失败，流水线跳过/降级/保半成品，**绝不让任务永久卡死**。

| 失败场景 | 处理 |
|---|---|
| 某 AI 欠费(402) | 跳过，其他继续；议院少员照常投票；提示用户 |
| 某 AI 超时(>60s) | 带超时，超时跳过不等 |
| 某 AI 连续失败(3次) | 熔断，本轮降级，不重复拖累 |
| 议院半数挂 | 自动降为单 AI 审查 + 提示 |
| 执行 AI 卡壳 | **保交付半成品** + 给用户接手选项（换模型/手动/重试） |
| 授权弹窗无人点 | 超时自动放行（§6） |

**编排器必须具备**：
- 每个模型调用 `AbortController` 超时(60s) + 失败计数
- 流水线级降级规则（议院→单AI）
- 复用已有 `classifyApiError`（能正确识别 401/402/429，我们踩欠费坑的教训）

**议院投票容错**：过半数即定论（非全票），少数挂不影响出结果。

---

## 8. 收敛防发散机制（4 件套）

| 机制 | 规则 |
|---|---|
| 证据门禁 | 质检意见必须带证据，无凭证不采纳（堵"空话发散"） |
| 最大轮数 | 执行↔质检碰撞 ≤3 轮，超限强制收敛取当前最优 |
| 分歧升级 | 僵持交仲裁（关键问题上议院 / 或问人类） |
| 达标线 | 全维度 ≥85 且无 P0 即交付，不死磕 100 |

---

## 9. 内置浏览器（Playwright + 画面小窗）

### 9.1 方案选型
- **周期截图 + WebSocket 推帧**（首选：实现快、延迟~1s 够用、低成本）
- CDP/WebRTC 像素流 → 阶段3再议

### 9.2 后端模块 `services/ai-browser.ts`
```ts
- 启动 Playwright Chromium (headless)
- open(url) / screenshot() / click(x,y) / type() / scroll()
- setInterval → 截图 → emit /ws/ai-browser (base64)
- AI 工具: ai_browser_navigate / ai_browser_screenshot / ai_browser_click
- 质检工具: screenshot({widths:[375,768,1280]}) 各尺寸审查
```

### 9.3 前端 `AI-Browser` 组件
- 右栏常驻小窗，订阅 WebSocket 收帧
- AI 操作时显示当前 URL + 操作命令日志
- 用户旁观（不接管，简单安全）—— 接管留中期

### 9.4 依赖
- `playwright` + Chromium 下载（~150MB，需确认 Electron/服务器可装）
- 复用已有 `/ws/ghost` 的 ws 通道技术

---

## 10. 数据模型草案

```sql
-- 协作平台任务
CREATE TABLE collab_tasks (
  id TEXT PRIMARY KEY,
  user_goal TEXT,            -- 用户原始想法
  mode TEXT,                 -- semi | senate
  model_count INTEGER,        -- 议院人数
  auth_seconds INTEGER,       -- 授权秒数
  status TEXT,                -- composing|executing|reviewing|fixing|done|failed
  round INTEGER,              -- 当前收敛轮次
  created_at TEXT, updated_at TEXT
);

-- 多 AI 审查意见
CREATE TABLE review_opinions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  round INTEGER,
  actor TEXT,                -- 执行AI/质检AI/议院/具体模型
  verdict TEXT,              -- pass | reject | abstain
  evidence TEXT,             -- 证据 JSON
  used INTEGER DEFAULT 0,    -- 是否被采纳
  created_at TEXT
);
```

---

## 11. API 草案

```
POST /api/collab/tasks          发任务 {goal, mode, modelCount, authSeconds}
GET  /api/collab/tasks/:id      任务状态
POST /api/collab/tasks/:id/start  开始执行
POST /api/collab/tasks/:id/auth   授权
POST /api/collab/tasks/:id/approve  验收通过
POST /api/collab/tasks/:id/reject  打回
GET  /api/collab/tasks/:id/opinions  审查意见
WS   /ws/collab/:id             实时推送（进度/画面/意见）
WS   /ws/ai-browser             浏览器画面帧
```

---

## 12. 与现有能力衔接（不重复造轮子）

| 需要 | 复用/新建 |
|---|---|
| 执行 AI / 质检 AI | 复用 `runAgentLoop`（不同 system prompt 人设） |
| 议院 / 审议 | 复用"多 AI 群聊共识"引擎设计 |
| 授权 | 复用 `toolAutoApproveSeconds` + `waitForToolConfirmation` |
| 容错 | 复用 `classifyApiError` + 加超时熔断 |
| L1 机器检查 | 复用 `shell_exec` 跑 lint/test/curl |
| 浏览器画面 | 新建 Playwright 模块（唯一大新依赖） |
| 多 AI 对话 | 消息加 actor（P0） |

---

## 13. 分阶段推进

| 阶段 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| P0 对话地基 | 消息 `actor` + 前端多角色渲染 | 对话流有多身份消息 | — |
| P1 平台壳 | 侧边栏入口 + 模式选择 + 授权配置 + 任务看板 | 能发任务、选模式、看授权倒计时 | P0 |
| P2 质检 MVP | L1 机器检查 + L2 质检 Agent + 收敛4件套 | 真实 bug 被抓住→修→复检通过 | P1 |
| P3 内置浏览器 | Playwright + AI-Browser 小窗 + 推帧 + 截图审查 | 用户看到 AI 开的网页；质检截各尺寸审界面 | playwright 可装 + 复用 /ws |
| P4 视觉质检 | 质检用截图审排版/重叠/美观 | 报告"文字重叠/对比度"并触发修复 | P3 |
| P5 议院 + 全自动 | 议院模式 + 容错降级 + 达标自动交付 | 全自动跑通"交付→议院审→修复→交付" | P2 + ≥2 模型 key |

---

## 14. 当前卡点与建议

### 硬卡点
1. **议院真多模型**：目前仅 DeepSeek 有 key（Kimi 待配通）。第一版议院先用 `DeepSeek 扮演多角色视角`，配好第二个 key 再转真多模型族。
2. **Playwright**：需下载 Chromium(~150MB)，需在目标运行环境验证可装。

### 建议执行顺序
1. P0（actor 对话地基）→ 2. P1（平台壳+模式+授权）→ 3. P2（质检MVP）→ 4. P3（浏览器）→ 5. 按 key 进度接议院

---

## 15. 风险清单

| 风险 | 缓解 |
|---|---|
| 多 AI 商议发散 | 收敛4件套（证据/轮数/升级/达标线） |
| 单 AI 欠费卡死 | 容错降级（跳过/熔断/降议院/保半成品） |
| 议院成本爆炸 | 数量档位锁上限6 + 无无限选项 |
| 浏览器依赖装不上 | 下载 Chromium 前先验证，备选 computer-use 截屏 |
| 质检主观判定不稳 | L1 机器客观证据优先，L2 主观判断用多尺寸截图+明确 prompt |
| 授权过松/过紧 | 超时自动放行 + 危险操作保留确认，策略可配 |

---

*附录：本设计整合了 2026-08-29 讨论（AI 群聊共识、质检闭环、内置浏览器、分角色 vs 分层、授权卡壳、容错降级、议院数量）。对应可视初稿：docs/AI_QUALITY_SYSTEM_PLAN.html*
