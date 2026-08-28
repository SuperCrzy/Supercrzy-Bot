# 工作区对话架构三方对比：WorkBuddy vs ChatGPT vs SUPERCRZY

> 拆包实证：WorkBuddy 658M（/tmp/wb-asar2）+ ChatGPT 221M（/tmp/gpt-asar，webview 架构）
> 我们：packages/client/src（ChatView.vue 4869 行 + components/chat 26 组件）
> 日期：2026-08-20

---

## 一、三方架构总览

### WorkBuddy（双层包：引擎与实现分离）

```
conversation-render/        ← 渲染引擎（通用无业务）
├── scenarios/task-chat/      MessageLinkedList + message-transforms（数据模型）
├── scenarios/common/tool-call/  tool-view-runtime（宿主注入）+ tool-view-types（defineTool/matchPriority）
└── shared/                   i18n / theme / react-markdown（inline-code 路径检测）

cb-chat-ui/                 ← 渲染器实现（有业务）
└── components/tool-renderer/
    ├── common/               SingleLineToolHeader 等公共卡片
    ├── icons/                工具图标集
    ├── renderers/            ★20 个目录：read-file / write-file / web-fetch / ...
    │   └── 每个 = xxx-renderer.tsx(full) + xxx-compact-renderer.tsx + utils + index
    └── index.ts              toolRendererRegistry（注册表）
```

### ChatGPT（webview 架构）

```
webview/
├── app-initial-*.js          MCP content part 协议（text/image/audio/tool_use/resource）
├── register-*.js             消息渲染（reasoning/text/tool_use/tool_result parts 交替）
└── use-chatgpt-composer-controller  composer 输入层独立
消息模型：assistant.content = parts[]（text / reasoning / tool_use / tool_result 按真实顺序）
```

### SUPERCRZY（单文件巨型组件）

```
views/ChatView.vue        4869 行 ★★★
├── 模板：消息区（MessageFlowRenderer）+ 附件 + 图 + 交付摘要 + routine + 对比 + 语音
├── handleSSE：28 个 case（打字机/工具/图/停止/授权/预览/文件变更/轮次限制...）
├── 13+ 大职责函数（停止/发送/授权/折叠/滚动/上传/语音/时间/代码块增强/图提取...）
└── 状态：pendingText/streamTarget/abortController...

components/chat/（26 个组件）
├── 新渲染：MessageFlowRenderer(540) + ToolCallBlock(1231) + ThinkingBlock/Group + FileDiffViewer
│          + MultiEditDiffViewer + WebFetchCard + VisualizerReadMeCard + ToolErrorBoundary
└── ★9 个死组件：ExecuteCmdCard/ReadFileCard/WriteFileCard/ListFileCard/WebSearchCard/
        ReasoningBox/ProcessFold/PlanCapsule/QuestionCard（无人 import，P0 重写前遗留）
```

---

## 二、对比矩阵

| 维度 | WorkBuddy | ChatGPT | SUPERCRZY | 差距 |
|---|---|---|---|---|
| **消息模型** | MessageLinkedList（user 纵向挂 assistant）；content=blocks[] | content=parts[]（text/reasoning/tool_use/tool_result） | content(ContentBlock[]) **+ 独立 flow[]**（thinking/tool/text/diagram） | 🔴 **双轨**：内容存两份，同步易错 |
| **渲染层** | 引擎/实现双层分包 + 注册表 | 按 part 类型分发组件 | ChatView 巨型组件 + if/else 链 | 🔴 结构差距最大 |
| **工具渲染** | 20 个 renderer 目录（compact/full 双形态） | 每 part 一个组件 | ToolCallBlock 1231 行，24 处 isXxx 分支 | 🔴 全堆一个文件 |
| **状态机** | ToolState 10 态 | part.status | ToolStatus 10 态（刚补齐） | ✅ |
| **状态词** | tool.<name>.<status> i18n 196 条 | 组件内联 | tool-summary.ts 28 条平铺 + 硬编码 | 🟡 缺命名空间 |
| **图标** | toolIconEntries 17 组注册表 | lucide | tool-meta.ts 21 类三级匹配 | ✅ |
| **文件定位** | onFileClick(filePath,start,end) + 正文 path-detector | 代码引用可点 | P0-1/P0-3 刚落地 | ✅ |
| **错误边界** | ToolRendererErrorBoundary | ErrorBoundary | ToolErrorBoundary 刚加 | ✅ |
| **渲染器注册** | defineTool + matchPriority（NONE/DEFAULT/EXACT） | 组件分发 | v-if 链（isCommand/isLint/isReadMe...） | 🔴 缺注册表 |
| **持久化** | sub-message（{baseId}-{index}）+ _offset 排序 | message + parts | flow 序列化进 attachments 单 blob | 🟡 可接受 |
| **公共 header** | SingleLineToolHeader 统一 | 各组件自绘 | ToolCallBlock 各分支自绘 | 🟡 |

---

## 三、6 大结构性差距（"总觉得有问题"的根源）

### 🔴 1. 双轨数据模型：content + flow 并存

- **我们**：一条 assistant 消息同时有 `content`（最终正文）和 `flow`（过程节点数组）。正文在 flow 的 text 节点里渲染，content 又在流式时拼装、持久化时合并 SVG——两处状态、两处提取（autoExtractDiagrams 要同时扫 content 和 flow 的 text）、两处路径检测。
- **WorkBuddy/GPT**：单轨。assistant 消息的 content 本身就是 blocks/parts 数组，**thinking/tool/text/image 都是 content 的一部分**，渲染 = 遍历数组，不存在"过程"和"结果"两份状态。
- **代价**：历史消息重放时流程复杂（content 转 ContentBlock[] + attachments 解析 flow），容易出"正文和过程不一致"的隐形 bug（之前正文被劈开、图被推走都是双轨的并发症）。

### 🔴 2. ChatView.vue 4869 行巨型组件

- 一个文件同时承担：SSE 协议解析（28 case）、打字机限速、工具授权流程、附件上传、语音、停止、时间线、多模型对比、交付摘要、routine、SVG 提取、代码块增强。
- **WorkBuddy**：adapter（事件层）→ conversation-render（引擎）→ cb-chat-ui（实现）三层分包；**GPT**：composer controller 独立。
- **代价**：每次改动都要在大文件里找上下文；职责边界模糊（UI 与协议混在一起）。

### 🔴 3. ToolCallBlock 1231 行：所有工具渲染堆一个文件

- 命令/lint/读写文件/多文件编辑/WebFetch/read_me/图标/状态词/diff/行数滚动全在一个组件，24 处 isXxx 分支。
- **WorkBuddy**：20 个 renderer 目录，每工具一个文件（compact + full 双形态），用注册表 + matchPriority 匹配。
- **代价**：加新工具要改巨型组件 + 分支链越来越长；没有 compact/full 双形态（WebFetchCard 是第一个特例）。

### 🟡 4. 9 个死组件 + 两套卡片体系（历史遗留）

- ExecuteCmdCard / ReadFileCard / WriteFileCard / ListFileCard / WebSearchCard / ReasoningBox / ProcessFold / PlanCapsule / QuestionCard —— **全部无人引用**（P0 重写前的旧卡片，重写后 ToolCallBlock 接管，文件没删）。
- **代价**：目录结构误导（WebFetchCard 之前也是死组件没人知道）；代码库体积虚胖；新人分不清新旧两套。

### 🟡 5. 状态词平铺 vs i18n 命名空间

- 我们 28 条平铺表 + 组件内硬编码中文；WorkBuddy `tool.<工具>.<状态>` 196 条 + {count} 插值。
- **代价**：多语言支持差（新卡片要手动补 zh/en）；状态词与状态机未强绑定。

### 🟡 6. 无渲染器注册表

- 我们是 v-if 链；WorkBuddy defineTool + matchPriority + toolRendererRegistry。
- **代价**：工具渲染匹配逻辑散落；无法做渲染器优先级/覆盖/错误隔离的统一管理。

---

## 四、修复建议（按性价比）

| 优先级 | 动作 | 收益 |
|---|---|---|
| 🔴 P0 | **删除 9 个死组件**（确认无人引用后清理） | 目录清爽，消除误导（5 分钟） |
| 🔴 P0 | **渲染器注册表化**：建 tool-renderer-registry.ts（工具名→渲染器组件映射 + matchPriority），ToolCallBlock 的 isXxx 链改为查表 | 新工具 = 注册一行；为后续 compact/full 铺路 |
| 🟡 P1 | **ToolCallBlock 拆文件**：先把 WebFetch/read_me/命令/lint 抽成独立 renderer 组件（目录 renderers/），ToolCallBlock 变分发器 | 对齐 WorkBuddy 结构 |
| 🟡 P1 | **单轨化探索**：flow 升级为"唯一真相"（content 从 flow 推导，或 flow 并入 content） | 根治双轨一致性问题（改动大，需专项） |
| 🟡 P1 | **ChatView 拆职责**：SSE 协议解析抽到 stores/chat-stream.ts（事件→store 更新），ChatView 只留 UI | 4869 行瘦身 |
| 🟢 P2 | i18n 命名空间化（tool.* 结构） | 多语言 + 插值 |

> 注：双轨模型（#1）是架构级问题，短期不推；先做死组件清理 + 注册表化，把"每加一个工具都像打补丁"的体感解决掉，是当前最对症的。
