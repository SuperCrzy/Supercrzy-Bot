# SUPERCRZY BOT vs WorkBuddy 全方位深度体检（2026-08-27）

> 目的：逐维度、逐功能、逐代码层面对比我们与 WorkBuddy 的实际差距，不遗漏细节。
> 方法：WorkBuddy 能力提取自解包 app.asar 引擎/main/UI（带代码证据）；我们能力盘点自 packages/client+server+desktop 源码。
> 定位：老板已定"轻量不是招牌，招牌=用户喜爱、能解决问题、体验更稳"。本篇为追赶路线提供客观依据。

---

## 一、总览：整体差距（一句话）

| 维度 | 判断 |
|---|---|
| 核心 Agent 对话能力 | **已接近**（流式/思考/折叠/来源卡/工具链/记忆全套有了） |
| 高级体验与生态 | **有差距（已大幅收窄）**（剩余：记忆主动引导/多模态输入/AI同事协作；effort 多档与折叠技巧已核清补齐） |
| 架构稳健性 | **单进程弱于 sidecar**（并发/隔离；近期 expose 过 SSE 卡假象，真问题待查 tools import 阻塞） |

---

## 二、对话区 UI（逐项对比）

| 功能 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 流式输出 | stream/isStreaming/usage | chat-stream.ts 流式 | ✅ 相当 |
| 思考展示 | thinkingSummary/effort多档/可开关 | ThinkingBlock/ThinkingGroup | 🟡 我们有，缺"effort 多档选择/可开关" |
| **过程折叠** | **回看式计算折叠**(computeFoldResult/shouldFold/segments/分批展开) | fold-state 状态机+hasEnd-折叠 | 🟡 我们已成型，差"回看式/分批展开/语义摘要"技巧 |
| 来源卡片 | citation/sources/sourceUrl | SourceCards.vue(web_search 引用) | ✅ 已追平 |
| markdown/rich text | react-markdown/KaTeX/Prism/编辑器728KB | renderers+ToolCallBlock | ✅ 相当 |
| token 用量 | modelCredit/credit/token/usage | **ContextUsageRing + 分类 popover** | ✅ 已对齐 usage-by-category |
| **图片生成** | **ImageGen 工具** | **generate_image 工具（6 provider: Pollinations/豆包/Gemini/Stability/Replicate/OpenAI-gpt-image-1）** | ✅ **已补齐（2026-08-27）** |
| **多模态输入** | attachment/图片粘贴/imageBlobService | computer-use.ts(弱)+附件上传 | 🟡 弱 |
| 附件上传 | 图/文件 | InputBanner+upload 路由 | ✅ |
| **复制/分享** | share_copy_link(分享链接) | **复制对话 MD / 下载对话 MD / 生成分享图**（ChatView share 菜单） | 🟢 **我们有且更强**（MD 导出+分享图；WorkBuddy 只是链接） |

---

## 三、上下文管理

| 项 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 自动压缩 | autoCompactEnabled/compactThreshold | context-compressor(shouldCompress/compressContext/pruneOldToolResults) | ✅ 相当 |
| 阈值体系 | tokenUsageThresholds 多档(.8/.92)/可 env 覆盖/压缩回看 | 单阈值 THRESHOLD_RATIO | 🟡 我们更简单，无多档/无回看 |
| 按模型窗口 | 依模型 | getContextWindowForModel/custom_models+330 | ✅ |
| 滑动窗口 | 驱逐式的（靠阈值压缩） | 靠压缩+prune(keepLastN=5) | 🟡 都有"压缩式"，无显式滑动 |

---

## 四、工具/Agent 能力（逐项）

| 类 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 文件 | Read/Write/Edit | file_read/write/multi_edit/exists/delete/lint_file | ✅ 相当（我们多了 multi_edit/lint）|
| 搜索代码 | Glob/Grep | Grep/Glob 类似（file 内） | ✅ |
| Bash/shell | Bash(shell 沙箱) | shell_exec（L1黑名单/L2软沙箱/L3 sandbox-exec） | ✅ 我们沙箱分层更细 |
| Web | WebSearch/WebFetch | web_search(时效性SearXNG)/web_fetch/deep_research | ✅ 我们多了 deep_research |
| 图像 | **ImageGen** | ✗ | 🔴 缺 |
| 任务 | TodoWrite | task_create/update/list + create_plan/tasks 表 | 🟡 我们有计划+任务 |
| 调度 | CronCreate/Delete/List | **automations+scheduler(Cron 等价)** | ✅ |
| 记忆 | memory(689) | memory_store/recall/list | ✅ |
| 技能/专家 | **Skill 工具/专家/Playbook** | skill/player/search/install + role-router + skill-loader/playbook | ✅ 有技能/角色，弱"Playbook 系统" |
| **权限/审批** | **PermissionMode 多档(Default/AcceptEdits/BypassPermissions/autoApprove/Fulll)** + hooks 拦截 | toolApprovalMode(auto/deny/prompt)+SENSITIVE_TOOLS+sessionApprovals | 🟡 我们简化，缺 AcceptEdits/自动审批续跑档 |
| MCP | connector 生态 | mcp-manager/连接器 | 🟡 有基础 |

---

## 五、文件/工作区

| 项 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 多文件 Tab | FileTabs(review/openFile) | 无多文件 tab | 🟡 缺，用 DetailPanel tab 替代 |
| **diff 行数** | **file.diff.addedLines/removedLines(逐行)** | FileDiffViewer(LCS+字符级高亮+MAX_RENDER_LINES) | 🟡 有 diff，**缺 addedLines±行数徽标** |
| 文件监控/感知 | chokidar/watchPaths | ghost-watch fs.watch/ghost-ws | ✅ |
| 产物展示 | tool result 产物 | 产物卡 deliverabors tab/FileOpRenderer | ✅ |

---

## 六、记忆系统（WorkBuddy 明显强项）

| 项 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 持久化 | MemoryManager/MemoryLoader/MemoryParser/MemoryCache | agent_memory 表+memory-search | ✅ |
| 注入 | buildMemoryPrompt/buildMemoryLines(`# How to save memories`两步) | `## Stored Memories` 注入 | 🟡 我们有注入，缺"保存法教学" |
| 语义类型 | user/feedback/project/reference + MemoryScope | key/category/importance | 🟡 简化 |
| **自动提取** | **MemoryExtractionService(后台异步改消息→子agent提取记忆，自动)** | syncTurnMemories(每轮)+runReflection(反思) | 🟡 我们有自动，但缺独立后台自动提取服务 |
| **主动检索** | buildSearchingPastTask/ContextSection(Grep记忆目录) | rankMemories+相关记忆查询 | 🟡 我们被动注入为主，**主动 recall 意识弱** |

**记忆是 WorkBuddy 最完整处：save 教学+语义类型+独立自动提取服务+主动检索。我们中等偏上，弱在"主动回忆引导 + 自动提取服务独立程度"。**

---

## 七、桌面/集成

| 项 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| 桌面 | 原生+sidecar | Electron titleBarStyle hiddenInset 沉浸式 | ✅ |
| 内嵌后端 | sidecar-entry(ring-buffer/daemon) | main.cjs spawn 后端(3000) | 🟡 有，更简单 |
| ACP 协议 | **acp.js 6857行(同事协作/外部接入)** | ✗ | 🔴 缺 ACP 协议 |
| 深链 | deepLink/second-instance/open-url | supercrzy:// | ✅ |
| PWA | Web 端 | PWA index.html 可安装 | ✅ |

---

## 八、其它独特能力

| 能力 | WorkBuddy | SUPERCRZY | 差距 |
|---|---|---|---|
| **AI 同事协作** | colleague-acp/mention/artifact/netdrive/chat(464KB API) | ✗ | 🔴 缺（多 agent 协作） |
| **灵感分享码** | inspirationCode encode/decode 分享码(496KB) | **对话分享（复制/下载 MD + 生成分享图）** | 🟢 不同形态；我们已有实用分享，无需刻意对齐分享码 |
| 专家生态 | skill/expert-selector/PlaybookApp/expertTeamMember | role-router/技能系统(有) | 🟡 有基础缺 Playbook 可视化 |
| **会话分支/恢复** | fork/variant/checkpoint/retry/resume(细粒度) | saveCheckpoint/resumeCheckpoint+中断续跑(刚做好) | 🟡 有，checkpoint 粒度类似 |
| **VCS/Git** | git branch/rev/url/isGitRepository | git_status/diff/commit | 🟡 缺 git branch/rev 提取 |
| 团队会话 | subagents/*.jsonl 子 agent 会话 | 幽灵多 Agent(ghost) | 🟡 方向有 |
| **多平台网关** | 连接器生态 | **gateway 8 平台(微信/QQ/telegram/dingtalk/feishu/discord/slack/wecom)+wechat-ilink + web** | ✅ **我们强项** |
| MCP 连接器 | connector market | mcp-manager/routes | 🟡 |

---

## 九、代码/架构层面差距

| 维度 | WorkBuddy | SUPERCRZY | 差距/启示 |
|---|---|---|---|
| 进程模型 | 3 层(main+sidecar+renderer)+ACP | client/desktop/server 3包 | 🟡 架构层对齐，sidecar 独立度不足 |
| **并发/隔离** | sidecar 独立进程+会话隔离 | 单进程 Koa+better-sqlite3(WAL) | 🔴 并发写锁脆（tools.ts import 疑似阻塞需查） |
| 代码规模 | UI 9.9MB+acp 6857行+多模块 | client~28k行/server~20k行/工具~41个 | 🟡 WorkBuddy 更庞大(重产品) |
| 工具注册 | 命名 tools-*.js | tools.ts+directoryTools | ✅ 均插件式注册 |
| 权限模型 | PermissionMode 多档+hooks | toolApprovalMode+沙箱分层 | 🟡 我们更简，缺 AcceptEdits 等 |

---

## 十、差距总结 + 追赶路线（按老板"为用户"导向）

### 已对齐/相当（无需追）：流式/思考/折叠基础/来源卡/token 用量/Web/文件/沙箱/网关/记忆基础/检查点/automations/MCP/**图片生成(已补齐)**/**对话分享(我们更强)**

### ✅ 原🔴短板已全部补齐（2026-08-27 下午收尾）
1. **diff 行数±徽标**——FileDiffViewer fdv-head 统计徽标（绿+红−）已落地
2. **思考 effort 多档**——核对确认后端 mapReasoningLevel+reasoning_effort / 前端 5 档本就有；折叠"回看式(segCollapsed)+语义摘要(segSummary)+分批展开(batchExtra 增量+expandEarlier)"已全部落地

### 🟡 剩余待补（按用户价值排序，2026-08-27 复评）
3. **架构稳定性**——单进程 Koa+SQLite vs WorkBuddy sidecar 独立进程；多会话并发长任务隔离弱（SSE 卡为假象已澄清，但架构性风险真实存在）
4. 主动记忆引导（prompt 教何时 recall）——WorkBuddy "How to save memories"+主动检索
5. 记忆后台自动提取服务独立化（我们现为每轮同步 memory-sync + reflection）
6. 权限多档（AcceptEdits/自动审批续跑档）
7. 多模态输入偏弱（图片粘贴/多图 attachment 体验 vs WorkBuddy imageBlobService）
8. 图片生成落盘产物卡片增强（pollinations URL 下载可用性、产物卡直达）
9. 多文件 Tab（现用 DetailPanel 单文件替代）
10. effort 对话区快捷切换（5 档已有，缺对话区就地切换入口）

### 🟢 远期/取舍（重投入，看是否差异化核心）
7. ACP 协议 / AI 同事协作 —— 多 agent 大投入
8. 灵感分享码 —— WorkBuddy 独特；我们已有"对话分享(MD导出+分享图)"作不同形态，无需刻意平替
9. sidecar 多进程架构 —— 为并发/隔离，但与我们现状有取舍

### ⚠️ 待排查
- （已核清）**tools.ts import 不阻塞**（0ms）——此前 verify 脚本卡是 bash 后台+tsx 测试假象，非真实问题，无需排查

---

## 附：对比方法说明
- WorkBuddy 数据：/tmp/wb-asar 解包（cli/dist/codebuddy.js、renderer/assets、main/*），关键词提取
- 我们数据：packages/client+server+desktop 源码 + 已实现功能
- 本体检聚焦"能力有无/深浅"，非逐行 diff（那是代码 review 范畴，另做）
