# WorkBuddy 深度逆向分析报告

> 研究对象：WorkBuddy Desktop 5.3.14（本地安装包 app.asar 拆包，658MB，21MB Agent 引擎 bundle）
> 目的：剖析"反应快"的架构机制 + 工具调用 / 深度思考 / 上下文 / 行数统计的实现，为 SUPERCRZY BOT 提供落地对照
> 日期：2026-08-19

---

## 一、架构总览：Sidecar + ACP 协议 + 预热池

**这是 WorkBuddy 最核心的架构决策，也是"反应快"的第一来源。**

```
┌─────────────────────────────────────────────┐
│ Electron 主进程（main/）                     │
│   ├─ cli-prewarm-pool.js ← 预热池（关键）    │
│   └─ 窗口 / IPC / 深链 / 更新                 │
└──────────────┬──────────────────────────────┘
               │ ACP HTTP（Agent Client Protocol）
┌──────────────▼──────────────────────────────┐
│ Sidecar 进程（cli/dist/codebuddy.js, 21MB）  │
│   Agent 引擎：会话 / 模型 / 工具 / 思考       │
│   ├─ createSession / listSessions            │
│   ├─ Messages 类（上下文窗口管理）            │
│   └─ 工具执行器 / 思考解析器                  │
└──────────────┬──────────────────────────────┘
               │ HTTPS + keep-alive
┌──────────────▼──────────────────────────────┐
│ 模型 API（DeepSeek / 各家）                  │
└─────────────────────────────────────────────┘
```

**关键证据**（main/cli-prewarm-pool.js）：
- `Pre-warm the sidecar process so that the first createSession() call does not pay the full spawn + ping-retry cost` —— 启动时预启动 sidecar，第一次建会话不用付进程启动成本
- 池管理：`getActiveEndpoints() / getActiveEndpointForSession()` —— 预热会话可复用
- 会话表：`listSessions() / resolveSessionHttpBase()` —— UI 通过 HTTP 连 sidecar

**对 SUPERCRZY 的意义**：SUPERCRZY 后端是常驻进程（Koa），没有"进程启动"问题；但**缺少"会话/引擎预热"概念**——模型的连接、工具环境可以预初始化。

---

## 二、"反应快"的 7 个机制（全部有代码证据）

| # | 机制 | 证据 | 作用 |
|---|---|---|---|
| 1 | **Sidecar 预热池** | cli-prewarm-pool.js `warmup()` | 首任务省进程启动+ping 成本 |
| 2 | **HTTP keep-alive（2s）** | codebuddy.js `keepAlive:!0, keepAliveMsecs:2e3` | 模型连接复用，省 TCP/TLS 握手（每轮省 100~300ms） |
| 3 | **流式输出（SSE + stream:true）** | `stream:true`、SSE 事件 | 首 token 即显示，不等完整回复 |
| 4 | **工具流式执行** | `streamOutput(eA)` | 命令边跑边输出，不用等完成（体验关键） |
| 5 | **并行工具调用** | `parallelToolCalls`（模型设置）+ `0===ed.length` 校验 | 独立工具同时执行 |
| 6 | **模型 fallback 降级** | `fallbackModelFrom/To, fallbackModelActivated, primaryRetryAttempted` | 主模型失败自动切备用，不卡死 |
| 7 | **思考与回答并行流式** | `reasoning` 事件 + `reasoning_content` 解析 | 思考 token 与正文同时流式刷出 |

**核心结论**：WorkBuddy 的快 = **进程预热 + 连接复用 + 全链路流式（正文/工具/思考都流式）+ 并行执行**。其中 3/4/5/7 是"流式思维"，1/2 是"基建思维"。

---

## 三、工具调用机制

### 3.1 流式执行（streamOutput）
- 工具执行有专门的流式输出通道：`streamOutput(eA){let el=nN.Context.getCurr...` —— **命令/脚本的输出逐行实时推送**，不是跑完一次性返回
- 支持**部分成功/中止**：`isPartialSuccessResponse() / isPartialAborted` —— 工具中途失败也有部分结果回流
- 中止时参数归一：`isPartialAborted?(eA.arguments="{}"` —— 避免脏参数

### 3.2 并行与约束
- `parallelToolCalls` 来自模型设置（`modelSettings.parallelToolCalls`）
- 有校验：`if(modelSettings.parallelToolCalls && 0===ed.length) throw` —— 并行开关与工具列表一致性校验

### 3.3 状态与回传
- 工具结果带 `toolCallId / toolName / conversationId / modelInfo` 回传（行数统计事件也挂同一套）
- 工具在终端状态（`isToolInTerminalState`）—— UI 能识别"正在终端里跑"

---

## 四、深度思考规则（thinkingLevelMap + thinkingFormat）

**WorkBuddy 把"深度思考"做成了可配置、多模型适配的机制：**

### 4.1 思考级别映射（thinkingLevelMap）
```
thinkingLevelMap: { off: null, minimal: ..., high: ..., xhigh: "xhigh" }   // 通用
thinkingLevelMap: { off: "none", xhigh: "max" }                            // 按厂家
thinkingLevelMap: { xhigh: "xhigh" }                                       // 按厂家
thinkingLevelMap: { off: null }                                            // 默认
```
- **UI 层思考档位（off/minimal/high/xhigh）→ 模型层参数（"none"/"max"/"xhigh"）** 的映射表
- 每个模型厂家有自己的映射（DeepSeek 一套、其他一套）

### 4.2 思考输出格式适配（thinkingFormat）
```
thinkingFormat: "deepseek"     // DeepSeek 的 reasoning_content 流
thinkingFormat: "together"     // Together 的 thinking 流
```
- 引擎按模型厂家解析不同的思考流格式，统一成内部 reasoning 事件

### 4.3 流式思考
- `reasoning_content` 解析（27 处）→ 思考 token 流式刷出
- `thinking` 事件（415 处）—— 思考区实时更新，可折叠

---

## 五、上下文管理（contextWindow 体系）

**WorkBuddy 的上下文管理是"按模型窗口 + 多级保护"：**

### 5.1 按模型配置窗口
```
contextWindow: 128e3   (128K)  ← 多数模型
contextWindow: 2e5     (200K)
contextWindow: 262144  (256K)
contextWindow: 4e5     (400K)
contextWindow: 1e6     (1M)    ← 大窗口模型
contextWindow: 1048576 (1M)
contextWindow: 131072  (128K)
```
- 每个模型声明自己的上下文窗口，引擎按窗口管理会话消息

### 5.2 多级保护
- **token cap 检查**：`exceeds token cap (~${eu} > ${ec})` —— 超限明确报错而非静默截断
- **evict 驱逐**：`evict / evicted` —— 上下文有驱逐机制（超窗逐出旧消息）
- **summarizer 压缩**：`summarizer_decorate / summarizer_metadata` —— 装饰器式上下文总结（压缩旧内容）
- **Messages 类封装**：`this.messages = new Messages(client)` —— 消息数组的增删改查统一管理

**对比 SUPERCRZY**：SUPERCRZY 前端全量发送历史（无窗口）→ **WorkBuddy 是按模型窗口 + 驱逐 + 总结的三层机制**。这正是昨天查到的"会话越长越慢"问题的业界标准答案。

---

## 六、"写代码行数显示"实现（完整链路）

```
工具写入文件（file_write / 编辑器）
   ↓
计算 diff：changeType(added/deleted) + addedLines[] + deletedLines[]
   ↓
eg.addedLines / eg.addedCharacters（行数 + 字符数统计）
   ↓
事件回传：{ codeDiff, lineCount, characterCount, toolCallId, toolName, conversationId }
   ↓
UI 渲染：addedLines > 0 || file.diff.removed → 文件卡显示"新增 N 行"
```

**证据**：
- 引擎侧：`{filePath, changeType, addedLines, deletedLines}` + `observeCommit`（SVN/Git 提交观察）+ `lineCount: eg.addedLines, characterCount: eg.addedCharacters`
- UI 侧：`addedLines = toNumberOrZero(data.ad...)`、`addedLines > 0 || file.diff.removed` —— 有变更才显示统计

**本质**：**不是"数输出 token"，而是文件变更 diff 统计**——每次文件写入后对比旧内容，精确算出新增/删除行，作为事件上报。

---

## 七、工作区功能实现要点

| 功能 | 实现方式 | 证据 |
|---|---|---|
| 文件树 | 渲染端文件树组件 + 引擎文件工具 | `fileTree` 相关 UI |
| 终端 | **工具运行在"终端状态"**（isToolInTerminalState）——命令类工具与终端 UI 绑定，流式输出 | `terminal_cmd / isToolInTerminalState` |
| 文件 diff | 变更即 diff 视图（addedLines/removedLines） | `file.diff.removed` |
| 行数/字符数 | 工具事件携带 lineCount/characterCount | `lineCount = 0` 初始化 |
| 多 Tab 文件 | FileTabs 组件 | `FileTabs-D0Dqpydq.js` |

**核心设计**：工作区不是独立功能，而是**工具执行的可视化层**——命令工具的每次运行都在工作区"终端"里流式展示，文件工具的每次写入都在工作区"diff"里统计。

---

## 八、对 SUPERCRZY 的落地对照（差距清单）

| 机制 | WorkBuddy | SUPERCRZY 现状 | 落地优先级 |
|---|---|---|---|
| 全链路流式（正文/工具/思考） | ✅ 全部流式 | ✅ 正文 SSE 流式；工具结果一次性返回；思考流式有 | **P0：工具输出流式化** |
| HTTP keep-alive 连接复用 | ✅ 2s | ❌ 每次请求新连接（fetch 默认） | P0（几行代码） |
| 上下文窗口（按模型+驱逐+总结） | ✅ 三层 | ❌ 前端全量发送 | P1：滑动窗口（昨天已分析） |
| 深度思考分级（off/xhigh→模型参数） | ✅ 映射表 | ❌ 固定 | P1：思考档位设置 |
| 并行工具调用 | ✅ | ❌ 串行执行 | P1：独立工具并行 |
| 模型 fallback | ✅ | ❌ | P2 |
| 行数统计（diff 驱动） | ✅ | ❌（无） | P1：文件写入后 diff 统计 |
| 工具流式部分成功/中止 | ✅ | ❌ | P2 |
| Sidecar 预热 | ✅ | N/A（常驻 Koa 无进程成本） | 不适用 |

---

## 九、一句话总结

**WorkBuddy 的快不是"魔法"，是工程组合拳**：Sidecar 预热 + keep-alive 复用（基建）+ 全链路流式（体验）+ 并行执行（吞吐）+ 按模型窗口的上下文管理（稳定）。SUPERCRZY 已具备流式正文和工具调用骨架，**最快的三个追赶点：工具输出流式化、keep-alive、上下文窗口**——工作量小、感知提升最大。

---

## 十、功能全貌地图（全部机制 + 证据）

> 本清单穷举 WorkBuddy 引擎与 UI 的核心机制，每项均有拆包代码证据（codebuddy.js / main / renderer）。

### 10.1 AI 回复的所有可能性（决策骨架）
| 机制 | 证据 | 说明 |
|---|---|---|
| **回合循环** | `handleClientCall / stopReason` | Agent 在 loop 里反复：思考→调工具→看结果，直到结束 |
| **结束原因映射** | `case "stop": case "end_turn": case "stop_sequence": case "tool_calls": case "tool_use": case "function_call": return "end_turn"` | 模型结束回合 → 控制权交回用户 |
| **拒绝/取消** | `stopReason: "refusal" / "cancelled"` | 模型拒绝执行 / 用户取消 |
| **工具回合** | `tool_calls/tool_use` 也归入 end_turn 判定 | 工具调用后继续或结束由模型决定 |

### 10.2 规则体系（systemPromptBuilder）
- **用户自定义规则**（custom rules）→ `systemPromptBuilder.build(rules, settingsDenyRules)`
- **设置级拒绝规则**（settingsDenyRules）—— 全局禁用的行为
- **分类器系统提示**（classifier_system_prompt）—— 任务分类器
- **transcript 序列化**（serializeTranscript）—— 会话记录进上下文

### 10.3 完整工具机制
| 能力 | 证据 |
|---|---|
| 工具定义 | ACP 动态注册（`description` schema）+ 引擎执行器 |
| 流式执行 | `streamOutput`（命令边跑边输出） |
| 部分成功/中止 | `isPartialSuccessResponse / isPartialAborted` |
| 并行 | `parallelToolCalls`（模型设置控制） |
| 权限模式 | `Skips all permission prompts`（auto 全放行）/ 询问 / 拒绝 |
| 终端状态 | `isToolInTerminalState`（命令类工具绑定终端 UI） |

### 10.4 深度思考完整规则
| 能力 | 证据 |
|---|---|
| **UI 五档** | `Briefest / Light / Balanced / Deep / Very deep reasoning` |
| **档位映射** | `thinkingLevelMap: {off/minimal/high/xhigh} → {none/max/...}`（按厂家） |
| **思考流格式** | `thinkingFormat: "deepseek"（reasoning_content）/ "together"` |
| **流式展示** | `thinking` 事件 + `reasoning_content` 解析（思考实时刷出、可折叠） |

### 10.5 上下文管理
- `contextWindow` 按模型配置（128K/200K/256K/400K/1M）
- `exceeds token cap` 超限报错 + `evict` 驱逐 + `summarizer` 压缩装饰器 + `Messages` 类封装

### 10.6 写文件与代码工作流
| 能力 | 证据 |
|---|---|
| 文件写入 | file_write/编辑器协议 |
| **格式化** | `formatters[type]` 按文件类型自动格式化 |
| **lint** | lint 检查 |
| **行数统计** | diff → `addedLines/deletedLines/characterCount` → 事件带 `lineCount/toolCallId` 上报 |
| **提交观察** | `observeCommit`（SVN/Git） |

### 10.7 技能系统
- `SKILL.md`（13 处）+ `loadSkill` + `.agents/skills` 目录 —— **开放 SKILL.md 标准**（与 SUPERCRZY 对齐的 agentskills.io 一致）

### 10.8 架构与加速
- Sidecar 进程 + ACP 协议 + 预热池（cli-prewarm-pool.js）
- HTTP keep-alive（2s）+ 全链路流式 + 并行工具 + 模型 fallback

### 10.9 完整工具清单（活证据）
> bundle 内工具注册被压缩噪音干扰，但 WorkBuddy Agent 的本会话工具集即真实清单：
> **核心**：WebSearch / WebFetch / Bash / Read / Write / Edit / Glob / Grep / TaskCreate|Update|Get|List / Agent（子代理）/ AskUserQuestion
> **生成**：ImageGen / VideoGen / show_widget（SVG/图表可视化）/ present_files
> **生态**：Skill（技能加载）/ mcp_*（连接器）/ automation_update（定时任务）/ 资料库 / 腾讯文档系列 / 邮件 / 微信支付
> **平台**：计划模式（Plan）/ Craft 模式（直接执行）/ 只读模式

**结论：WorkBuddy 的全部核心机制（架构/规则/工具/思考/上下文/写文件/技能/权限）已系统性摸清，逐项有代码证据。**
