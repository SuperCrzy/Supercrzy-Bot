# WorkBuddy 反编译拆解：工具调用 / 底层逻辑 / 底层设置（2026-08-29）

> 直接拆包 `WorkBuddy.app`（Electron 应用）读取真实实现，非文档推测。
> 来源：
> - `app.asar` → `main/initialize.js`（6.4MB 桌面主进程，会话/压缩/工具编排）
> - `app.asar.unpacked/cli/dist/codebuddy.js`（22MB CLI Agent 运行时）
> - `cli/product.json`（产品配置：工具注册表 / agents / 限制）
> - `cli/sandbox-config.json`（mac 沙盒）
>
> 说明：这些都是打包压缩产物，以下为可读化还原；方法名经解码，语义确保准确。

---

## 一、工具调用机制

### 1.1 工具注册表（product.json `tools` 数组 — 48 个内置工具）

每个工具只有 `name` + `description`，可选 `deferLoading`。**核心机制是"两级加载"**：

```jsonc
{ "name": "Bash",    "description": "..." },              // 常驻 system prompt
{ "name": "Write",   "description": "..." },
{ "name": "NotebookEdit", "description": "...", "deferLoading": true },  // 按需
{ "name": "ToolSearch",   "description": "..." },          // 发现工具的"目录"
{ "name": "DeferExecuteTool", "description": "..." }       // 执行已发现工具的"门"
```

**带 `deferLoading: true` 的工具（不进初始 prompt，靠 ToolSearch 发现）**：
`NotebookEdit`、`ListMcpResources`、`ReadMcpResource`、`EnterPlanMode`、`ExitPlanMode`、
`TaskStop`、`SkillManage`、`LSP`、`ImageGen`、`ImageEdit`、`VideoGen`、`ComputerUse`、
`EnterWorktree`、`LeaveWorktree`、`CronCreate/CronDelete/CronList`、`Workflow`

**结论（对我们最直接的启示）**：工具数量多时，**不要全塞进 system prompt**。
WorkBuddy 只暴露"名称+一句话描述"的目录，模型先 `ToolSearch` 找到需要的工具 → 加载它的完整
输入 schema → 才允许 `DeferExecuteTool` 真正执行。这直接压缩了每轮请求的 prompt 体积
（回答了我们"deep_research 卡死"时的上下文膨胀问题）。

### 1.2 两段式调用链（ToolSearch → DeferExecuteTool）

```
模型需要某工具（系统只有名字）
  → 调用 ToolSearch(name)         # 加载该工具完整 inputSchema 到会话缓存
  → 校验已加载                          # 未加载的 defer 工具，DeferExecuteTool 会拒绝
  → DeferExecuteTool({toolName, args}) # 真正执行
```

从 bundle 里能看到 `ToolSearchService.describe()` 负责返回工具定义，且有 `deferred_tool_direct_call`
回退路径（模型直接用完整名字调用时也放行，但会记日志）。这就是 ACP/工具懒加载的标准实现。

### 1.3 工具执行分发（executeToolCalls 等价物）

`executeToolCalls(toolCalls, ctx)` 有个关键设计——**互斥屏障调度**：
- **写类工具串行**（防并发写冲突）
- **读类工具并行**（提速）
- 结果按原顺序收集

每个工具被封装成 `ToolCall → ToolResultWithMeta`，`tool_call_id` 严格配对（OpenAI/Anthropic 协议）。

---

## 二、工具权限（底层设置的核心）

### 2.1 六种 Permission Mode（证据：`availableModes` 数组）

| mode | 名称 | 行为 |
|---|---|---|
| `default` | Always Ask | **首次使用每个工具时询问**（默认） |
| `acceptEdits` | Accept Edits | 自动批准本会话的文件编辑权限 |
| `plan` | Plan | 只分析不改文件、不执行命令 |
| `auto` | Auto | **AI 分类器**判定：安全动作自动放行、危险动作拒绝；分类器不可用时回退为询问（或不可弹窗时拒绝） |
| `dontAsk` | Don't Ask | 永不弹权限窗；预批准 + 安全动作放行，需批准的一律拒绝 |
| `bypassPermissions` | Bypass Permissions | 跳过所有权限提示（全放开） |

> 我们 BOT 的 `toolApprovalMode: auto/prompt/deny/accept-edits/full` 与之对应。
> WorkBuddy 的 `auto` 是**用分类器自动决策**，比"询问"更顺滑——这是我们可以学的。

### 2.2 shell 命令安全分级（证据：`checkWorkBuddyWhitelistOrDefault` 完整函数）

对用户要执行的字符串，WorkBuddy 有三级判定，返回 `{isSafe, requiresApproval, riskLevel}`：

```js
function checkWorkBuddyWhitelistOrDefault(cmd, args, fileBlock) {
  cmd = cmd.toLowerCase()
  // ① 已知开发工具白名单（eg Set）：nvm/source/mktemp/brew/apt/systemctl/mysql/psql/
  //    redis-cli/sqlite3/docker-compose/vagrant/helm/trash/ln/install/nohup/crontab/robocopy…
  //    → isSafe:true, requiresApproval:true, riskLevel:"low"
  // ② 高危命令关键字：/(rm|del|delete|remove|drop|destroy|purge|wipe|shred|erase|clean|nuke)/
  //    → isSafe:false, riskLevel:"high", requiresApproval（每次确认）
  // ③ 高危参数：/(--delete|--force-delete|--purge|--destroy|--wipe|--erase|--nuke|delete|purge|nuke)/
  //    → isSafe:false, riskLevel:"high", requiresApproval（每次确认）
  // ④ 沙盒拦截记录：fileBlockRecords 含 DELETE 操作（actionMask&4）→ 拒绝

  return { isSafe:true, requiresApproval:false, riskLevel:"low", isUnknown:false }
}
```

`isCriticalCommand`：任一参数是 Command 且 `riskLevel === CRITICAL` → true。
`isDangerousCommand`：`CRITICAL || HIGH` → true。

判定后按权限模式出 `behavior: ask | auto | deny | approve`。绕过逻辑：
```js
if (CommandUtils.checkCommandSafety(cmd).riskLevel !== CRITICAL && !== HIGH)
  return allow   // “exec-policy-allow” → 本地绕过（rule 前缀匹配命中）
```

### 2.3 沙盒（SandboxOrchestrator + mac App Sandbox）

- `SandboxOrchestrator` 有 `exec-policy`：按 shell 命令的**前缀规则**决定是否放行
- `sandbox-config.json` 声明 mac App Sandbox（bundleId/appGroupId/network extension），
  还有 `SandboxHelper` 原生 helper 做真正的沙盒执行
- 有 `stripHeredocBodies` / 命令解析器处理 `heredoc`、管道、环境变量
- 高危：`systemctl/service/launchctl/mysql/psql/redis-cli` 等被归到"需壳/需授权"白名单（`eg` Set）
  —— 这些命令 requiresApproval 但 isSafe（低危），说明 WorkBuddy 区分"危险"与"需授权但安全"

---

## 三、底层逻辑（循环 / 上下文压缩 / 模型）

### 3.1 Agent 循环的停止判定（工具调用 → next / 无工具 → 收尾）

stop_reason 归一化（证据：`stop_reason_for` 等价逻辑）：

```js
switch (providerStopReason) {
  case "refusal":              return "refusal"
  case "length": case "max_tokens": return "max_tokens"
  case "stop": case "end_turn": case "stop_sequence":
  case "tool_calls": case "tool_use": case "function_call":  return "end_turn"
  default:                     return "end_turn"
}
```

模型若返回了 `tool_calls/tool_use/function_call` → 循环继续；否则 → 本轮结束。
（与官方文档一致的"内容驱动"判据，不信 provider 元数据。）

配合硬件上限：`requestMaxStepLimit` 在 product.json 里 = **100**（单请求最大步骤数），
`schema`: `CODEBUDDY_CODE_MAX_TURNS` 默认 500。模型会动态传 `max_turns`。

### 3.2 上下文压缩（`compact` agent — 证据确凿）

`initialize.js` 里看到关键实现：用一个 **providerData.agent = "compact"** 的 assistant 消息，
输出结构化 `<conversation_history_summary>`：

```
<conversation_history_summary>
<summary>
${cbSummary}
</summary>
</conversation_history_summary>
```

- 触发开关：settings `autoCompactEnabled`（可关闭）
- 设定项 `tokenUsageThresholds`（product.json）控制触发阈值
- `compact` 是专门用来总结对话历史的"压缩器 agent"，把历史压成结构化摘要
- ACP 层面有 `handleCompactSession` 等价接口

**核心洞察**：压缩不是"截断",而是**让另一个 agent 把历史总结成语义摘要**,并把摘要作为一条
assistant 消息插回上下文(带 providerData 标记),后续对话接着这个摘要进行。
摘要里明确写了"所有任务已完成,不要重新执行"这类收敛指令(防压缩后重复动作)——开源实现里可见。

### 3.3 思考深度（reasoning effort — 6 档）

```
minimal (Briefest) / low (Light) / medium (Balanced) /
high (Deep) / xhigh (Very deep) / max (Maximum)
```
对应 `reasoningEffort` 设置 + `alwaysThinkingEnabled`。模型语言配置
`languageConfig.reasoning.supportedEfforts` 决定当前模型能用哪几档；`canDisableThinking` 判断能否关思考。

### 3.4 模型优化

- `enableModelOptimization`（默认 enabled），若产品 feature 禁用元宝通道则关(`DisableYuanbaoChannel`)
- `fillToolCallContentModelWhitelist: ['glm','claude']` —— **只有这些模型需要给 tool_calls 补 content**
  （其他模型如 deepseek 不需要）,这解释了为什么我们要单独处理 reasoning_content 而它们不会

---

### 3.5 settings 全量 key（反编译 `AZ` 数组 + settingsManager.get）

直接读出的用户可配置项（**底层设置**）：

```
model           主题(theme)        autoCompactEnabled   alwaysThinkingEnabled
includeCoAuthoredBy  showTokensCounter  language      cleanupPeriodDays
ignoreGitIgnore     autoUpdates     enablePasteImageFromClipboard
enableTerminalProgressBar  fileCheckpointingEnabled  promptSuggestionEnabled
deferToolLoading     imageHistoryRetainRounds  reasoningEffort
hookOutputCollapsed  outputStyle
+ agent / permissions / env / gateway / hooks / memory / trustAll / trustedDirectories
+ enableModelOptimization / apiKeyHelper / channelsEnabled / preferredNotifChannel
```

另从 `settingsManager.get()` 扫出：`agent`、`trustAll`、`trustedDirectories`（信任目录白名单）、
`permissions`（权限配置整块）、`memory`、`hooks`（前后钩子）、`gateway`。

---

## 四、与我们 BOT 的对照差距（可直接抄）

| 机制 | WorkBuddy | 我们 | 差距 |
|---|---|---|---|
| 工具两级加载 | 48 工具分 常驻/`deferLoading`，ToolSearch→DeferExecuteTool | 全部常驻 system prompt | **prompt 体积优化**（最重要的差距） |
| 权限模式 | 6 档，含 `auto`(分类器) / `dontAsk` | `auto/prompt/deny/accept-edits/full` | 已有雏形，缺"分类器自动决策" |
| shell 安全 | 白名单+高危关键字+高危参数三级分类 | `scanDangerousPath` + sandbox | WorkBuddy 更细的交互动线 |
| 上下文压缩 | `compact agent` 生成 `<conversation_history_summary>` | 仅 413 被动压缩 | **最大的架构差距**，且压缩器带"勿重做"指令 |
| 思考档位 | 6 档 reasoningEffort | 5 档(极简/轻/平衡/深/极深) | 接近 |
| 停止判据 | 内容驱动(有无 tool_calls)+硬件上限 | 刚改为 stop 接口 + 预算 | 已补 |
| 步骤上限 | `requestMaxStepLimit=100` + maxTurns 500 | maxTurns 50-200 | WorkBuddy 上限更高但靠压缩防爆 |
| 工具互斥 | 写串行/读并行 | 无显式互斥 | 可抄（避免写并发冲突） |

---

## 五、结论

WorkBuddy 与我们的核心架构思路大体一致（都基于 OpenAI/Anthropic 兼容的 tool_calls 协议），但三处**明显的工程领先**值得抄：

1. **工具两级加载**（deferToolLoading）：控制每轮 prompt 体积，是上下文管理的上游。我们工具多时就该学。
2. **`compact agent` 主动上下文压缩**：把我们"413 才被动压缩"升级为"token 占比超阈值→派压缩agent 出结构化摘要→插回带'勿重做'指令"。这是根治长任务膨胀（如 deep_research 卡死、上下文 285KB）的方向。
3. **`auto` 权限分类器 + `dontAsk`**：让"该放行的自动放行、该拦的拦死"，交互更顺滑。

这三项正好对应我们记忆里标出的"上下文滑动窗口/主动记忆引导/并发稳定"短板，可作为下一阶段 roadmap 的优先级。

---

## 附：证据来源

- `/Applications/WorkBuddy.app/Contents/Resources/app.asar` → `main/initialize.js`
  （compact agent `<conversation_history_summary>`、stop_reason 归一化、AI 权限决策）
- `app.asar.unpacked/cli/dist/codebuddy.js`（22MB）→
  `checkWorkBuddyWhitelistOrDefault`、`matchesDangerousCommand`、`availableModes`、`reasoningEffort`、`settings AZ`
- `cli/product.json` → 48 工具表、agents 定义、`requestMaxStepLimit=100`、`fillToolCallContentModelWhitelist`
- `cli/sandbox-config.json` → mac App Sandbox 声明
