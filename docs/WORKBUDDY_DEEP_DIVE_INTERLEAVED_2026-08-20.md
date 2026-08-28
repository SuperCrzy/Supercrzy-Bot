# WorkBuddy 交替式对话架构深度拆解（源码级实证）

> 拆包对象：/Applications/WorkBuddy.app（658M 解包于 /tmp/wb-asar2）
> 核心源码：renderer/assets/src-CocHqt_k.js（10MB 主 bundle，含 conversation-render 包）+ message-linked-list / message-transforms / chat-types chunk + i18n-DhX2O5PJ.js
> 日期：2026-08-20

---

## 一、交替式逻辑：数据模型（怎么存）

### 1.1 MessageLinkedList——横向链表 + 纵向挂载

文件：`message-linked-list-CNSwLDt3.js`（源码注释原文保留）

```
head ──▶ UserNode ──▶ SystemNode ──▶ UserNode ──▶ ...
              │                            │
              ▼                            ▼
          assistant                      assistant
        (一条消息, content=blocks[])
```

- **横向节点**：user / system 两类
- **UserNode 纵向挂 `assistant` 指针**：一条 user + 其回复 = 一个 turn
- `lastUserNode` + `turnState`：全局只跟踪最后一个 turn 的状态
- 插入规则：`insertSystemByTime` 按时间插到第一个 `time > sysTime` 的 UserNode 前（compact divider 按真实时刻归位）

### 1.2 turnState——turn 生命周期状态机（8 字段）

```ts
turnState = {
  completedBeforeEndTurn: false,  // endTurn 前收到过 completed/failed
  failedBeforeEndTurn: false,
  endTurnReceived: false,          // 最权威的 turn 边界
  onTurnCompletedFired: false,
  hasAssistantContent: false,
  interruptedByUser: false,
  fromCliResume: false,            // CLI --resume 回放（proxy 不补 endTurn）
}
isTurnTerminated = completedBeforeEndTurn || endTurnReceived || fromCliResume
```

### 1.3 assistant content = blocks[]——交替式的真正载体

```ts
content: [
  { type: "reasoning",  ... },   // 深度思考
  { type: "text",       text },
  { type: "tool-call",  tool: { id, name, args, status, metaData, createTime } },
  { type: "text",       text },
  { type: "tool-call",  ... },
  ...
]
```

- **交替式 = assistant 消息 content 里的 block 数组**，text / tool-call / reasoning 按真实顺序排列
- **tool block 自带 `status` 字段**——状态机直接存在数据里，UI 只是它的投影
- **tool block 自带 `createTime`**——工具真实执行时刻（见 1.5 时间订正）

### 1.4 sub-message 持久化——一条 assistant = N 条子消息

文件：`message-transforms-BVkezQc4.js`

- 子消息 id 格式 **`{baseId}-{index}`**（如 `abc-0`=reasoning、`abc-1`=tool-call）
- `reorderSubMessages`：同一 baseId 的子消息聚合到首次出现位置，按 index 排序（服务端可能把同一轮的子消息打散到不同位置）
- `mergeAssistantMessagesByRequestId`：同一 requestId 的多条 assistant 记录按 `_offset` 排序后**拼接 content**（分享数据分段存储）
- `sortByCreateTime`：排序键 `_offset`（服务端存储偏移量 = 真实顺序 source of truth）> `createTime` > 原索引；**仅当所有消息都有 `_offset` 才用它**，否则退回 createTime
- `enhanceMessages`：标记 `isEnd`（assistant 后一条是 user 或最后一条 = turn 结束）

### 1.5 时间订正——"已完成 XX"不虚标

`correctAssistantCreateTimeFromTools`：**用 content 内 tool-call 的最大 createTime 覆盖 assistant 外层 createTime**（仅当更早时）。因为历史重放时外层 createTime 可能退化成"重放当下"，而 tool 的 createTime 是真实执行时刻。纯文本回复（无 tool-call）保持原值。

> 注：这正是我们 F4 的对应物——我们用了 id 内嵌时间戳，WorkBuddy 用 tool-call createTime，思路一致。

---

## 二、ToolState：工具状态机（10 态）

文件：`chat-types-DpommZbR.js`

```
idle → parsing → pending → stream_executing / full_executing → executed
                ↘                                 ↙
                   skipped / failed / cancelled / destroyed
```

| 状态 | 含义 | 我们有无 |
|---|---|---|
| `idle` | 初始 | 无 |
| `parsing` | 参数解析中 | **无** |
| `pending` | 等待用户确认 | ✅ |
| `stream_executing` | 流式执行中 | ✅ |
| `full_executing` | 全量执行中 | 合并进 running |
| `executed` | 完成 | ✅ done |
| `skipped` | 跳过 | ✅ |
| `failed` | 失败 | ✅ error |
| `cancelled` | 取消 | **无** |
| `destroyed` | 销毁 | **无** |

**运行中集合（5 态）**：`[idle, pending, parsing, stream_executing, full_executing]`
**结束集合（4 态）**：`[executed, failed, cancelled, skipped]`
→ 所有 renderer 都用这两个集合判断"进行中 / 已结束"。

---

## 三、状态词体系：tool.<工具>.<状态> i18n 命名空间（196 条）

文件：`i18n-DhX2O5PJ.js`。**每个工具一个命名空间，每种状态一个 key**——这是状态词联动的骨架。

### 3.1 状态词核心清单（中文）

```
tool.readFile.reading    = 读取中
tool.readFile.read       = 已读取
tool.readFile.failed     = 读取
tool.readFile.end        = 末尾
tool.readFile.unknownFile= 未知文件
tool.readFile.unknownPath= 未知路径

tool.listFile.reading    = 读取中
tool.listFile.read       = 已读取
tool.listFile.listing    = 列出中
tool.listFile.listed     = 已列出
tool.listFile.searching  = 搜索中
tool.listFile.searched   = 已搜索
tool.listFile.searchedFiles = 已搜索文件
tool.listFile.searchFailed  = 搜索失败
tool.listFile.readFailed    = 读取失败
tool.listFile.moreResults   = {count} 个更多文件
tool.listFile.noResults     = 未找到文件
tool.listFile.rootDirectory = 根目录

tool.executeCommand.pending   = 等待中
tool.executeCommand.executing = 执行中
tool.executeCommand.executed  = 已执行
tool.executeCommand.running   = 运行中
tool.executeCommand.runSuccessfully = 运行成功
tool.executeCommand.failed    = 执行失败
tool.executeCommand.exitCode  = 退出码
tool.executeCommand.riskHigh  = 高风险命令，可能影响系统稳定性
tool.executeCommand.riskMedium= 中风险命令，请谨慎执行
tool.executeCommand.allow/alwaysAllow/askEachTime/autoRun/run/cancel/copy/reject/skip = 允许/始终允许/每次询问/自动运行/运行/取消/复制/拒绝/跳过

tool.webSearch.searching = 搜索网页中...
tool.webSearch.searched  = 已搜索网页
tool.webSearch.noResults = 未找到相关内容

tool.webFetch.summarizing = 生成摘要   ← 关键：网页抓取进行时 = "生成摘要"
tool.webFetch.title       = 网页获取

tool.imageGen.generating  = 生成中
tool.imageGen.generatingWithPrompt = 生成中: {prompt}
tool.imageGen.failed      = 图片生成失败

tool.deleteFile.deleting  = 删除中
tool.deleteFile.deleted   = 已删除
tool.deleteFile.deletedTag= (已删除)
tool.deleteFile.failed    = 删除失败

tool.completion.executing = 完成中...
tool.completion.success   = 已完成
tool.completion.failed    = 完成失败
tool.completion.defaultMessage = 任务完成

tool.connectCloudService.connecting/connected/failed = 连接中/已连接/连接失败
tool.fetchMcpResource.fetchedSuccessfully/fetchFailed = 获取成功/获取失败
tool.mcpMatch.getting/got = 获取中/已获取
tool.memory.created/updated/deleted = 已创建记忆/已更新记忆/已删除记忆
tool.searchReference.searching/found/noResults = 搜索中.../引用 {count} 篇文档作为参考/未检索到信息
tool.contentTruncated = ⋯ 省略了 {count} 行，点击文件名查看全文
```

### 3.2 友好名称表 name.<toolName>

```
name.read_file   = Read File        name.write_to_file  = Write File
name.replace_in_file = Replace in File  name.list_files = List Files
name.search_files = Search Files    name.grep = Search Content
name.web_fetch  = Fetch Web Page    name.web_search = Web Search
name.execute_command = Execute Command  name.run_terminal_cmd = Run Terminal Command
name.plan_task  = Plan Task         name.use_skill = Use Skill
name.use_mcp_tool = MCP Tool        name.present_files = Present Files
name.unknown    = Unknown Tool
```

---

## 四、icon 体系：toolIconEntries 注册表（17 组）

文件：`src-CocHqt_k.js`（`tool-icon-registry` 模块，源码结构原文）

```js
toolIconEntries = [
  { icon: EyeIcon,      toolNames: ["Read","read_file","NotebookRead","read_lints",
                                    "preview_url","PreviewUrl","OpenResultView",
                                    "present_files","PresentFiles",
                                    "ReadMcpResource","FetchMcpResource",
                                    "ListMcpResources","ConversationSearch"] },
  { icon: PencilIcon,   toolNames: ["Write","Edit","MultiEdit","write_to_file",
                                    "replace_in_file","append_to_file","edit_file",
                                    "NotebookEdit","NotebookWrite",
                                    "IDEWriteFile","IDEReplaceFile","ReplaceFile",
                                    "SaveMemory","UpdateMemory"] },
  { icon: TerminalIcon, toolNames: ["Bash","PowerShell","execute_command","run_command",
                                    "run_terminal_cmd","BashOutput","KillShell",
                                    "TerminalExecutor","CloudStudioExecuteCommand",
                                    "InstallBinary"] },
  { icon: SearchIcon,   toolNames: ["Glob","Grep","search_files","search_file",
                                    "search_content","codebase_search","CodebaseSearch",
                                    "RAG_search","ToolSearch","tool_search",
                                    "list_code_definition_names","SearchIntegration",
                                    "RgSearchContent","LSP"] },
  { icon: FolderIcon,   toolNames: ["list_files","list_dir","FileUpload",
                                    "EnterWorktree","LeaveWorktree"] },
  { icon: GlobeIcon,    toolNames: ["WebFetch","WebSearch","web_fetch","web_search"] },
  { icon: TrashIcon,    toolNames: ["DeleteFiles","delete_files","delete_file",
                                    "CronDelete","TeamDelete"] },
  { icon: SparkleIcon,  toolNames: ["Skill","SkillManage","UseSkill","use_skill",
                                    "SlashCommand"] },
  { icon: CheckIcon,    toolNames: ["completion","finish_task","plan_attempt_completion",
                                    "DeliverAttachments","weixinpay"] },
  { icon: ClipboardIcon,toolNames: ["plan_task","PlanCreate","plan_create","PlanUpdate",
                                    "plan_update","TaskCreate","create_tasks","TaskGet",
                                    "TaskUpdate","update_task","TaskList","list_tasks",
                                    "TaskStop","TaskOutput","append_task",
                                    "EnterPlanMode","ExitPlanMode","TodoWrite",
                                    "todo_write","task","Task",
                                    "CronCreate","CronList","PdcCreate","pdc_create",
                                    "PdcUpdate","pdc_update","AutomationUpdate"] },
  { icon: SendIcon,     toolNames: ["Agent","TeamCreate","team_create","SendMessage",
                                    "send_message","AskUserQuestion","ask_user_question",
                                    "ask_followup_question","dispatch_specialist",
                                    "send_to_specialist","list_experts",
                                    "list_specialists","session",
                                    "list_specialist_sessions","create_specialist_session"] },
  { icon: ImageIcon,    toolNames: ["ImageGen","image_gen","ImageEdit","image_edit"] },
  { icon: GridIcon,     toolNames: ["ShowWidget","ReadMe"] },
  { icon: DatabaseIcon, toolNames: ["SupabaseExecuteSql","SupabaseGetLogs",
                                    "SupabaseApplyMigration","SupabaseListMigration",
                                    "SupabaseListTables"], prefixes: ["Supabase"] },
  { icon: CloudIcon,    toolNames: ["CloudStudioDeploy","CloudStudioFetchLog",
                                    "connect_cloud_service","ConnectCloudService"],
                                    prefixes: ["CloudStudio"] },
  { icon: DebugIcon,    toolNames: ["DebugIssueReproduction","DebugIssueConfirm"],
                                    prefixes: ["Debug"] },
  { icon: WrenchIcon,   toolNames: ["mcp_call_tool","mcp_get_tool_description",
                                    "call_integration","call_tcb_integration",
                                    "call_eop_integration","call_anydev_integration",
                                    "call_lighthouse_integration","search_integration_tool",
                                    "defer_execute_tool"], prefixes: ["mcp__"] },
];
FALLBACK_ICON = WrenchIcon;  // 兜底 = 扳手
```

### 匹配机制（三级）

```js
exactMatchMap = new Map();  // 精确匹配：normalizeName(工具名) → icon
prefixEntries = [];          // 前缀匹配：{prefix, icon}[]
for (entry of toolIconEntries) {
  for (name of entry.toolNames) exactMatchMap.set(normalizeName(name), entry.icon);
  if (entry.prefixes) for (prefix of entry.prefixes) prefixEntries.push({prefix, icon});
}
prefixEntries.sort((a, b) => b.prefix.length - a.prefix.length);  // 长前缀优先
// 命中顺序：exactMatchMap 优先 → prefixEntries 按长度降序 → FALLBACK_ICON
```

**规律**：
1. **camelCase + snake_case 双注册**（WebFetch / web_fetch 都登记）
2. **一族工具一个 icon**：读=眼睛、写=铅笔、命令=终端、搜索=放大镜、网页=地球、任务/计划=剪贴板、Agent/提问=纸飞机
3. **icon 与 Renderer 解耦**：icon 由注册表解析，renderer 内部 `config.renderIcon?.(tool.name) ?? <默认icon>` 可覆盖

---

## 五、Renderer 框架：conversation-render 包

### 5.1 defineTool + matchPriority——渲染器注册与匹配

```js
ToolMatchPriority = { NONE: 0, DEFAULT: 1, EXACT: 10 };

function matchPriority(match, tool) {
  if (typeof match === "string")  return tool.name === match ? EXACT : NONE;
  if (Array.isArray(match))        return match.includes(tool.name) ? EXACT : NONE;
  const r = match(tool.name, tool);   // 函数匹配可返回自定义优先级
  if (typeof r === "number") return r;
  return r ? EXACT : NONE;
}
```

- `defineTool(entry)`：声明式注册渲染器（编译期强类型 data）
- 每个工具可匹配：string（精确）/ array（集合）/ function（自定义）
- 多个渲染器竞争时按优先级取最高

### 5.2 RenderRuntimeProvider——宿主注入运行时

```js
<RenderRuntimeProvider value={host}>
  <MessageTimeline .../>
</RenderRuntimeProvider>
```

- 宿主（桌面端）注入：`onFileClick`（打开文件/定位行号）、`getToolIconByName`、渲染开关等
- **卡片不是独立 UI，是 IDE 的入口**——联动靠宿主回调

---

## 六、SingleLineToolHeader：统一单行 header（所有文件类卡片共用）

```jsx
<div class="single-line-tool-header [collapsible|expanded]">
  <div class="tool-icon">{icon}</div>
  <div class="status-text [loading-text]">{statusText}</div>
  <Tooltip content={primaryTitle}>           {/* hover 显示完整路径 */}
    <span class="primary-content cursor-pointer [text-link|text-tertiary] [clickable]"
          onClick={e => { e.stopPropagation(); onPrimaryClick(); }}>
      {primaryContent}                        {/* 文件名 */}
    </span>
  </Tooltip>
  <div class="secondary-info">{secondaryInfo}</div>  {/* 行号范围 L12-30 */}
  <span class="tool-arrow">…</span>           {/* collapsible 时显示 */}
</div>
```

- 执行中：`status-text` 加 `loading-text` 类
- `onPrimaryClick` 有 `stopPropagation`（点击文件名不触发折叠）

---

## 七、状态机联动：每个 renderer 自带 getStatusText()

**不是全局统一函数，而是每个 renderer 内部 switch(status) 映射到 i18n key。**

### 7.1 ReadFileRenderer（查看文件）

```js
const isExecuting = tool.status === "executed";
const isFailed    = tool.status === "failed" || tool.status === "cancelled";
const offset      = startLine || 1;
const displayEndLine = endLine || i18n["tool.readFile.end"];  // 无 end → "末尾"
const shouldShowLineNumbers = isCompleted && !isImage;

const handleFileClick = () => {
  if (onFileClick)
    if (isImage) onFileClick(filePath);                    // 图片：只传路径
    else onFileClick(filePath, startLine, endLine);         // 文件：路径 + 行号范围！
};

const getStatusText = () => {
  if (isFailed)    return i18n["tool.readFile.failed"];    // "读取"
  if (isExecuting) return i18n["tool.readFile.reading"];   // "读取中"
  return i18n["tool.readFile.read"];                        // "已读取"
};
```

### 7.2 ListFileRenderer（搜索文件 / 定位代码）

```js
const isToolCallRunning = ["idle","pending","parsing","stream_executing","full_executing"].includes(toolStatus);
const isToolCallEnd     = ["executed","failed","cancelled","skipped"].includes(toolStatus);

// search_file 状态词：
switch (status) {
  case "idle": case "pending": case "parsing":
  case "stream_executing": case "full_executing": return i18n["tool.listFile.searching"];      // 搜索中
  case "executed":                                   return i18n["tool.listFile.searchedFiles"]; // 已搜索
  case "failed": case "cancelled": case "skipped":   return i18n["tool.listFile.searchFailed"];  // 搜索失败
}
```

---

## 八、联动链条全景（一张图）

```
agent 事件流
  │  tool_call (parsing → pending → stream_executing/full_executing → executed/failed/...)
  ▼
MessageLinkedList.updateAssistant()  ← tool block 的 status 就地更新
  ▼
MessageTimeline 重渲染 → content.map() 按序分发
  │   ├─ text block      → Markdown 渲染
  │   └─ tool-call block → 按工具名匹配 renderer（matchPriority 取最高）
  ▼
renderer.getStatusText() = switch(tool.status) → i18n["tool.<name>.<状态>"]   ← 状态词
renderer 的 icon      = toolIconEntries 注册表（exact → prefix → Wrench 兜底）← 图标
renderer 的文件名     = text-link，点击 → onFileClick(filePath, startLine, endLine)  ← 定位代码
  ▼
宿主（IDE）收到回调 → 打开文件 + 光标跳转行号
```

---

## 九、对 SUPERCRZY BOT 的落地差距清单

| # | WorkBuddy 机制 | 我们现状 | 差距 |
|---|---|---|---|
| 1 | tool block 自带 status + createTime（数据即状态） | flow 节点有 status，无 createTime | 补 createTime |
| 2 | ToolState 10 态（parsing / cancelled / destroyed） | 8 态 | 补 parsing、cancelled |
| 3 | tool.<name>.<status> i18n 命名空间（196 条） | tool-summary.ts 28 工具描述符表 | 扩成命名空间结构 |
| 4 | toolIconEntries 注册表（17 组 + exact/prefix/fallback） | tool-meta.ts 21 类（EXACT/PREFIX/FALLBACK 三级） | 基本对齐✅ 可补 prefixes 组 |
| 5 | SingleLineToolHeader 统一 header 规范 | ToolCallBlock 各自 header | 抽统一组件 |
| 6 | 文件名可点击 → onFileClick(filePath, startLine, endLine) 定位代码 | read_file 卡片无文件跳转 | **做**：点击文件名打开文件+定位行 |
| 7 | webFetch 进行时 = "生成摘要" | web_fetch 走通用分支显示原始文本 | 做 WebFetchCard（已出方案 A/B） |
| 8 | getStatusText 每 renderer 内部 switch | 部分写死 | 对齐命名空间 |
| 9 | 时间订正：tool-call createTime 覆盖外层 | id 内嵌时间戳 | 思路一致✅ |
| 10 | contentTruncated "点击文件名查看全文" | truncatedOutput 无点击联动 | 补 |
| 11 | sub-message（{baseId}-{index}）+ _offset 排序 | 无（flow 单条持久化） | 架构差异，可暂不追 |
