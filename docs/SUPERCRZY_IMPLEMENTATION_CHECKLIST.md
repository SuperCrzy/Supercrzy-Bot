# SUPERCRZY BOT 落地实施清单（基于 WorkBuddy 逆向研究）

> 来源：docs/WORKBUDDY_REVERSE_ANALYSIS.md（WorkBuddy 5.3.14 拆包研究）
> 原则：按"改动小、感知大"排序；每项标注涉及文件与验收标准
> 状态：待确认后逐项开工

---

## P0 — 快赢（改动小、感知提升最大）

### P0-1 工具输出流式化（命令边跑边输出）
- **WorkBuddy 做法**：`streamOutput` —— shell 命令执行时输出逐行实时推送，不等跑完
- **现状**：SUPERCRZY 工具结果一次性返回（跑完才显示 tool_result）
- **改动**：
  - 后端 `services/agent.ts`：shell_exec / file 类工具执行时，分片 emit SSE `tool_output` 事件
  - 前端 `views/ChatView.vue` + `components/chat/ToolCallBlock.vue`：监听 tool_output，卡片内流式追加输出
- **验收**：执行 `npm install` 等长命令，卡片内实时滚动输出，无需等完成
- **工作量**：中（SSE 事件 + 前端渲染）

### P0-2 HTTP keep-alive 连接复用（模型 API）
- **WorkBuddy 做法**：`keepAlive: true, keepAliveMsecs: 2000`
- **现状**：`agent.ts` 每次 fetch 到 DeepSeek 新建连接（每轮多 100~300ms TLS 握手）
- **改动**：`services/agent.ts` fetch 统一改用共享 agent（Node http.Agent keepAlive，空闲 2s）
- **验收**：连续多轮对话，模型首 token 延迟下降（网络抓包无重复握手）
- **工作量**：小（十几行）

---

## P1 — 核心补齐（对齐 WorkBuddy 主要机制）

### P1-1 上下文滑动窗口（解决"越聊越慢"）
- **WorkBuddy 做法**：`contextWindow` 按模型配置 + token cap 检查 + evict 驱逐 + summarizer 压缩
- **现状**：前端 `ChatView.vue:2196 apiMessages = messages.value` 全量发送
- **改动**：
  - 前端：发送前按窗口截取（如最近 40 条，超长时提示）
  - 后端 `agent.ts`：超限时 `compressContext`（已有函数）自动压缩 + token cap 保护
- **验收**：长会话（80+ 消息）响应速度稳定，不再线性变慢
- **工作量**：中

### P1-2 深度思考五档（思考级别设置）
- **WorkBuddy 做法**：UI 五档（Briefest/Light/Balanced/Deep/Very deep）→ `thinkingLevelMap` 按厂家映射 → `thinkingFormat` 适配思考流
- **现状**：无思考档位；reasoning 流式有基础
- **改动**：
  - 设置页：思考档位选择（五档）
  - 后端：档位 → 模型参数映射（DeepSeek 用 `reasoning_effort` 或 thinking 参数）
  - 前端：思考区按档位折叠/展开
- **验收**：切档位后模型思考深度/时长明显变化
- **工作量**：中

### P1-3 并行工具调用
- **WorkBuddy 做法**：`parallelToolCalls`（模型设置控制，独立工具同时执行）
- **现状**：`agent.ts` 工具串行执行（executeList 顺序）
- **改动**：`agent.ts` 对无依赖的工具批量执行（Promise.all），依赖工具保持串行
- **验收**：一条消息触发多个独立工具时并行执行，总耗时下降
- **工作量**：中（需维护依赖关系）

### P1-4 写代码行数统计（diff 驱动）
- **WorkBuddy 做法**：文件写入 → diff 算 `addedLines/deletedLines/characterCount` → 事件带 toolCallId 上报 → UI 显示"新增 N 行"
- **现状**：无统计
- **改动**：
  - 后端 `agent.ts`：file_write 前读旧内容，写后 diff 行数 → tool_result 附带 lineCount
  - 前端 `ToolCallBlock.vue`：卡片显示"新增 N 行 · 删除 M 行"
- **验收**：AI 写文件后卡片显示行数统计
- **工作量**：小-中

---

## P2 — 进阶（对齐长尾机制）

### P2-1 模型 fallback（主模型失败自动降级）
- **WorkBuddy**：`fallbackModelFrom/To + fallbackModelActivated + primaryRetryAttempted`
- **改动**：`agent.ts` 主模型请求失败 → 自动切备用模型重试一次
- **工作量**：小

### P2-2 工具部分成功回传
- **WorkBuddy**：`isPartialSuccessResponse / isPartialAborted`
- **改动**：工具中途失败也回流部分结果（不整体丢弃）
- **工作量**：中

### P2-3 写文件自动格式化
- **WorkBuddy**：`formatters[type]` 按文件类型格式化 + lint
- **改动**：file_write 后对 js/ts/css/json 等做轻量格式化（prettier 可选）
- **工作量**：中

### P2-4 权限"跳过全部提示"（对齐 auto）
- **WorkBuddy**：`Skips all permission prompts`
- **现状**：SUPERCRZY 已有 `toolApprovalMode=auto`（始终允许）——**已对齐，无需改动**

---

## 执行建议

1. 先做 **P0-1（工具流式）**——感知最大，也是 WorkBuddy 体验的灵魂
2. 再做 **P0-2（keep-alive）**——十几行代码，每轮省 100~300ms
3. 然后 **P1-1（上下文窗口）**——解决您反馈的"越聊越慢"
4. P1-2/P1-3/P1-4 按排期插入

每项完成后：TSC 通过 + 浏览器实测 + 记入项目日志。
