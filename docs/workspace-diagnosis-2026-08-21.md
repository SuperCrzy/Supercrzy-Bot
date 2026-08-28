# SUPERCRZY 对话工作区深度诊断报告

> 对比对象：WorkBuddy 5.3.14（`/Applications/WorkBuddy.app` 拆包分析）
> 诊断对象：SUPERCRZY BOT 当前最新代码
> 日期：2026-08-21
> 方法：外部拆包对比诊断 + 逐项代码核实

## 一、总体判断

**SUPERCRZY 已具备"能流式、能调工具、能交替显示"的基础能力，距离 WorkBuddy 成熟对话区主要差四件事：统一消息块模型、按 ID 精确事件归属、细粒度分段折叠、断线恢复与长对话性能。**

不是推倒重做，而是升级"流事件模型 + 聊天渲染模型"两层。报告中"已实现能力"清单（SSE 流式、thinking、工具交替、权限确认、沙箱、diff、Mermaid/SVG、checkpoint、多模型对比等）经核实属实，不必重复投入。

---

## 二、报告关键声明逐项核实

| # | 报告声明 | 核实结论 | 依据（代码） |
|---|---|---|---|
| 1 | ChatFlowNode 缺统一 nodeId | ✅ **属实** | `types/index.ts:236` — 4 种节点（thinking/tool/text/diagram）均无 `nodeId` |
| 2 | 工具结果按名称匹配，有挂错卡片风险 | ✅ **属实，且比报告更严重** | 后端 `tool_result` **已带 `tool_call_id`**（`agent.ts:1014/1112`），但前端 `ChatView.vue:2577` 忽略它，只用 `data.name` 匹配；`tool_duration` 后端只发 `{name, duration}` **根本没发 id**（`agent.ts:1118`）。且字段名混用：`tool_output` 发 camelCase `toolCallId`，`tool_result` 发 snake_case `tool_call_id` |
| 3 | 后端并行执行工具 | ✅ **属实** | `tools.ts:1439` — `Promise.all(toolCalls.map(...))`，结果按原顺序收集 |
| 4 | SSE 缺事件 id/seq | ✅ **属实** | `agent.ts:271` `emitSSE` 只写 `event: + data:`，无 SSE 标准 `id:` 行，无 seq |
| 5 | 断线重连缺失 | ✅ **属实** | `ChatView.vue:2471` 原始 `fetch + getReader()` 手动解析，无重连/续传/事件去重 |
| 6 | v-for 全量渲染无虚拟列表 | ✅ **属实** | `ChatView.vue:294` — 所有消息+工具卡片+Markdown+SVG 全进 DOM |
| 7 | done→finish→持久化竞态 | ⚠️ **方向属实，程度比报告轻** | `ChatView.vue:2795` done 只标记+`stream?.finish()`；当前发送尾部无立即持久化，注释明确"播完前刷新靠加载端 content 兜底补全"（`stores/chat.ts`）——团队已知此竞态并有缓解，但"等打字机播完才持久化"确实是结构性问题 |
| 8 | 折叠粒度太粗（message 级） | ✅ **属实** | `ChatView.vue:2803` done 时 `msg.processCollapsed = true` 整条消息折叠，无 WorkBuddy 式分段 MetaFold |

**报告整体准确，核心结论（消息块模型、ID 归属、分段折叠、虚拟列表）全部成立。** 唯一需要修正的细节：工具归属问题比报告描述的更具体——前端不是"没有 ID 可用"，而是"后端发了 ID 但前端没用（且字段名不一致）"，`tool_duration` 则需要前后端一起补。

---

## 三、完整问题清单（按优先级）

### 🔴 P0 — 真实 bug 风险，应最先修

#### 1. 并行同名工具结果挂错卡片（前后端各改一处）
- **风险**：后端并行执行两个 `file_read` 时，`tool_result`/`tool_duration` 按 `name` 匹配会把结果/耗时写进错误的卡片
- **后端**：`agent.ts:1118` `tool_duration` 补发 `tool_call_id: result.tool_call_id`
- **前端**：`ChatView.vue:2577` `tool_result` case 优先用 `data.tool_call_id` 匹配（`tool_output` 已用 `toolCallId`，统一即可）；`tool_duration` case 同步改为按 id 匹配，找不到再 fallback name
- **顺手统一**：`tool_output` 用 `toolCallId`（camel）、`tool_result` 用 `tool_call_id`（snake）——协议字段命名统一成一种

#### 2. 流结束/打字机/持久化竞态
- **现状**：done 到达 → `finish()` 继续快速播完残留 → UI 播放期间数据未持久化，刷新丢尾段（靠 content 兜底缓解，不彻底）
- **建议**：给消息增加状态机 `receiving → received → revealing → revealed → persisted`；done 时标记 received 并持久化 flow 快照，打字机播完再补一次 revealed 态写入（幂等 upsert）

#### 3. 输入框 onKeydown 警告（遗留）
- 上一轮已删 2 处空 `shift.enter` 处理器，此处仅为完整性列出——若新出现需排查是否有其他空处理器

### 🟡 P1 — 直接影响体验

#### 4. 分段 MetaFold（替代整条折叠）
- **现状**：`ChatView.vue:2803` 整条消息 `processCollapsed = true`
- **目标（WorkBuddy 式）**：正文保持原位，连续 thinking/tool 段各自折叠成摘要条（"工具 2 次 · 过程消息 4 条"），最终回答永远主视觉
- **落地**：MessageFlowRenderer 增加"连续过程段识别"——遍历 flow，把连续 thinking/tool 节点聚合成 fold segment，text 节点始终不折叠

#### 5. 工具调用默认摘要行 + 单工具独立展开
- **现状**：折叠后整条收拢，展开后所有工具平铺
- **目标**：单个工具卡片默认只显示 `工具名 · 状态 · 耗时` 摘要行，点开才见参数/stdout/stderr/diff
- **落地**：ToolCallBlock 增加 collapsed 默认态（已有展开态，补默认收起）

#### 6. reasoning 默认只显示摘要
- **现状**：thinking 节点随整条消息折叠，但展开后完整思考过程与正文同级展示
- **目标**：thinking 默认渲染为摘要行（"思考过程 N 步"），不把完整 reasoning 当正文

#### 7. 消息级虚拟列表
- **现状**：`ChatView.vue:294` v-for 全量渲染（旧长会话实测 scrollHeight ≈ 107,454px）
- **目标**：只渲染视口附近（参考 WorkBuddy：overscan 200 + top/bottom 800）
- **落地**：引入虚拟列表（vue-virtual-scroller / 手写窗口化），或分页加载（首屏最近 30 条 + "加载更早"）。**注意**：现有"flow 节点 >200 自动分批"只缓解单条消息内，不解决整会话渲染

#### 8. SSE 断线重连 + 事件去重
- **现状**：`ChatView.vue:2471` 原始 fetch，断线即丢
- **落地**：后端 emitSSE 增加 `id:` 行（自增 seq）；前端收到 EOF/错误时带 `Last-Event-ID` 重连；事件处理前按 seq 去重

#### 9. 工具参数增量解析
- **现状**：前端等完整 `tool_call` 事件才渲染，无流式参数
- **落地**：后端 tool-call 参数 JSON 边生成边发 chunk（与 `tool_output` 类似通道），前端增量渲染参数树——此项工作量中等，可放虚拟列表之后

### 🟢 P2 — 后续能力

#### 10. 统一 ChatBlock 数据模型（替代双轨存储）
- **现状**：`content + flow + attachments.flow` 三处并存，恢复靠拼接
- **目标**：单轨 `ChatBlock[]`（text/reasoning/tool/diagram/question，每块带 id/seq/status/toolCallId/parentToolUseId/startedAt/finishedAt）
- 已知单轨化计划已出未执行（本报告不重复展开）

#### 11. 主对话内嵌套 Sub-agent
- **现状**：Ghost 独立存在，未整合进主对话
- **落地**：工具块加 `parentToolUseId`，子 Agent 过程作为父工具块的 children 渲染

#### 12. Checkpoint 时间线 / 分支恢复 / 消息锚点完善
- **现状**：有 checkpoint 和续跑，无分支时间线 UI

#### 13. 富文本复制
- **现状**：主要纯文本复制
- **落地**：复制时带 text/plain + HTML + 自定义 MIME（参考 WorkBuddy）

#### 14. ChatView 巨型组件拆分
- **现状**：约 4930 行，SSE/持久化/工具状态全在组件内
- **落地**：SSE 事件处理抽 composable（`useChatStream`）、持久化抽 `useChatPersistence`、工具状态抽 `useToolFlow`

---

## 四、核实时额外发现（报告未覆盖）

1. **协议字段命名混用**：`tool_output` 用 `toolCallId`（camelCase），`tool_result` 用 `tool_call_id`（snake_case）——前端两个 case 各按一种写法，是归属 bug 的直接诱因
2. **`tool_duration` 事件没有携带任何 id**：即使前端想按 ID 匹配也无从下手，必须后端先补
3. **done 自动折叠会覆盖用户手动展开**：`if (msg.processCollapsed === undefined)` 已有保护（手动展开过则不覆盖）——这条做得对，保留

---

## 五、建议实施顺序

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **第一刀（P0）** | ①工具结果/耗时按 toolCallId 归属（前后端 3 处小改）②done 持久化状态机 | 小 |
| **第二刀（P1 体验）** | ③分段 MetaFold ④工具默认摘要行 ⑤reasoning 摘要 ⑥虚拟列表 | 中（③④⑤可一起做，⑥独立） |
| **第三刀（P1 健壮性）** | ⑦SSE id+重连+去重 ⑧参数增量解析 | 中 |
| **第四刀（P2）** | ⑨ChatBlock 单轨化 ⑩子 Agent 嵌套 ⑪富文本复制 ⑫组件拆分 | 大 |

**建议**：先做第一刀（当天见效、风险最低），再做第二刀（直接解决"工具很多、过程很重"的观感问题）。第三刀依赖第二刀的折叠结构，第四刀是架构升级需单独排期。
