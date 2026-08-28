# SUPERCRZY BOT 模块化可行性拆分方案（v1，2026-08-26）

> 目标：在**不改架构、不推翻分层**的前提下，把体检暴露的"超大单文件"拆到可维护规模。
> 原则：只做**水平切分**（超大单例拆成多个职责单一的文件），不引入新框架/不重写业务。

## 一、现状与拆解依据（实测行数）

| 文件 | 行数 | 问题 | 拆分优先级 |
|---|---|---|---|
| client/src/views/ChatView.vue | **6212** | 视图+SSE+发送+分享+工具 UI 全塞一个文件 | 🔴 P0 |
| server/src/services/tools.ts | **2001** | 所有 Agent 工具塞一个注册表文件 | 🔴 P0 |
| server/src/services/agent.ts | **1686** | Agent 编排（plan/execute/stream）耦合 | 🟡 P1 |
| client/src/i18n/index.ts | **2186** | 多语言 key 集中 | 🟢 P2（非急） |
| client/src/components/chat/ToolCallBlock.vue | **1381** | 工具卡片，可拆子组件 | 🟢 P2 |
| server/src/services/wechat-ilink.ts | **856** | 独立 bot connector | 🟢 P2（可整体外移）|

总量：client 28,888 行 / server 20,347 行。模块化可行性 = **中低难度**（分层正确，仅少数大文件）。

## 二、拆分方案（逐个文件，含依赖面）

### 🔴 P0-1：拆分 `ChatView.vue`(6212) → 抽离 SSE 流式处理层

**切分内容**：把 2531–3810 这段「消息发送 + 流式接收 + SSE 事件分发」（约 **1280 行**）抽到独立的 store / 组合函数。

**目标文件**（新增）：
- `stores/chat-stream.ts`（**扩展既有**，已有打字机引擎 createChatStream）→ 新增强化 `agentStream`：接管 `sendAgentMessage` / `attemptStream` / `syncTextToFlow` / `handleAgentEvent` 的纯数据流转。
- `composables/useChatStream.ts`（新增）→ 承接 UI 副作用（`aiStatus`、`streamTarget`、`markTextStarted/markEnd` 等折叠信号），返回给 ChatView 绑定的响应式句柄。

**依赖处理**：`handleAgentEvent` 依赖 `chatStore`/`planStore`/`appStore` + `applyTool*` + `nextNodeId`。方案：
- 三个 store 已是单例，直接 import（无循环依赖风险，stores 层不依赖视图）。
- `nextNodeId`/`markAllThinkingDone` 是纯工具函数 → 迁到 `utils/agent-flow.ts`（已有）。
- `markTextStarted/markToolSignal/markEnd`（折叠信号）→ 迁到 `utils/fold-state.ts`（已有状态机）。

**改动量预估**：移动约 1280 行 + ChatView 约瘦身 1200 行（6212→~5000）。
**验证**：tsc + 22 测试 + 一次真实/模拟流式回归。

### 🔴 P0-2：拆分 `server/src/services/tools.ts`(2001)

已确认 `tools/` 目录存在registry。问题是所有工具函数塞一个文件。

**切分**（新文件 4 个，registry 保留做 barrel）：
- `tools/web.ts`：web_search / web_fetch / news 相关（内容最多）
- `tools/code.ts`：代码执行 / 文件读写 / shell
- `tools/external.ts`：mem0 / slack / email 等三方
- `tools/registry.ts`（改造为只做注册聚合）

**依赖处理**：工具函数互相引用少，按"执行域"切相对安全；`registry.ts` 统一 export 供 `agent.ts` 消费。
**改动量**：2001 → 每个文件 ~350-600 行。
**验证**：tsc + server 全量测试 60 项。

### 🟡 P1：拆分 `server/src/services/agent.ts`(1686)

- `agent-core.ts`：turn 主循环 / 状态机（可保留命名 agent.ts）
- `agent-plan.ts`：planner / 计划 step 推进（拆出 plan_update 生成）
- `agent-stream.ts`：SSE 事件 emit / 打字机 chunk 组织

### 🟢 P2（可选，非必须）
- `wechat-ilink.ts`(856) 独立 connector → 若不需要可整体移除（顺带修空转轮询）；需要则保留为独立 connector 模块。
- `i18n/index.ts`(2186) 按 namespace 拆（chat/ui/models…）。
- `ToolCallBlock.vue`(1381) 拆 status/stream/diff 子组件。

## 三、拆分遵循的边界规则

1. **只做文件级水平切分，不动跨包边界**：client/server/desktop 三层保持。
2. **不新增运行时框架**：不引入 DI/微件，复用现有 Pinia store + utils。
3. **每个拆分动作独立可回退**：一次只拆一个文件，tsc+测试通过再下一个。
4. **纯数据流向 store，UI 副作用留视图/composable**——这是 ChatView 拆分的判断线。

## 四、风险与工作量

- **风险低**：都是机械式移动 + 接口收口，不重写业务逻辑。主要风险是 import 路径遗漏 → 由 tsc 兜住。
- **工作量**：
  | 项 | 预估 |
  |---|---|
  | P0-1 ChatView 抽流式层 | ~1 次专注改动，1280 行移动 |
  | P0-2 tools.ts 拆 4 文件 | ~0.5 次 |
  | P1 agent.ts 拆 3 文件 | ~0.5 次 |
  | P2 全部 | ~1 次 |

## 五、建议顺序

**P0-1 → P0-2 → 验证 → P1**。先啃最肥且收益最大的 ChatView。

---

> 本方案为**审批稿**。确认后我按 P0-1 开始，一次一拆、逐步 tsc+测试验证。
