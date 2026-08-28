# WorkBuddy 消息区完整架构拆解 → SUPERCRZY 复刻+优化计划

> 来源：本地拆包 `/Applications/WorkBuddy.app`（app.asar 270M → 658M），源码路径保留在 `//#region` 注释中，全部为实证。
> 日期：2026-08-19 · 用途：1:1 复刻消息区树状结构（保留 SUPERCRZY 样式），并列出可优化点

---

## 一、架构全景

WorkBuddy 消息区由两个包构成：

```
conversation-render（渲染内核）
├── list-like-render/    列表式渲染（事件总线 / 扩展注册表 / hooks）
│   ├── extensions/registry.ts    三注册表：renderers / converters / frameConverters
│   └── converter/                消息 → 块 转换
└── block-render/        块渲染
    ├── blocks/model/block.ts     isContainer(block)：有 children 即容器
    ├── renderer/registry.ts      块类型 → 组件
    ├── renderer/block-view.tsx   递归渲染（BlockView.memo）
    ├── renderer/containers/      document-renderer / frame-renderer
    └── renderer/fallback-renderer.tsx

cb-chat-ui/message-timeline（UI 层，66 个模块）
├── message-timeline.tsx      主组件（69K 字符）
├── mata-fold/                元折叠（摘要+时长+分批展开）
├── reasoning/                深度思考块
├── loading/                  加载态 + 俏皮提示语
├── user-bubble / avatar / message-time
├── compact-divider / session-separator / model-switch-divider
├── continue-card / checkpoint-actions / user-cancelled-indicator
└── hooks/use-message-groups  轮次分组
```

**核心数据流：**

```
messages
  → use-message-groups（轮次分组 + 状态标记 + 真实时间修复）
  → 帧转换 frame → convertPart（canHandle 优先 → contentType 匹配）→ 块树
  → useFoldHook（computeFoldResult 折叠决策 + 摘要 + 时长 + 成本预算）
  → MetaFold 折叠条（折叠态=摘要文本，点击展开=子块列表）
  → 块渲染（reasoning 深度思考 / tool-call 工具块 / text 文本块）
```

---

## 二、逐模块细节

### 2.1 消息分组（use-message-groups）

| 机制 | 实现 |
|---|---|
| 状态标记 | `computeMessagesWithCancelledState`：取消 / 废弃（checkpoint）/ 系统警告 |
| 接收判断 | `computeIsReceiving`：最后组 + 会话活跃 + 最后 assistant 未 complete |
| 真实时间 | `resolveRealTime`：createTime 与 **id 内嵌 13 位时间戳**取较小值（防 history replay 污染） |
| 会话分隔线 | `repositionSessionSeparators`：按真实时间把 separator 插回正确缝隙（后缀最小值锚点） |
| 压缩分隔线 | `mergeCompactDivider`：连续 divider 合并（用第一条 id 做稳定 key） |

### 2.2 帧 → 块转换（basic-frame-extension）

```js
basicFrameExtension = {
  frameConverters: [{ isDefault: true, convertFrame: convertBasicFrame }],
  renderers: [{ blockType: "basic-frame-body", component: BasicFrameBodyRenderer }]
}
```

- 消息帧 → `convertFrame` → 根块（basic-frame-body，children 存子块 id 数组）
- 每个 part（思考/文本/工具）→ `convertPart`：
  1. 先按 `canHandle`（priority 降序）匹配扩展
  2. 再按 `contentType` 精确匹配
  3. 未命中返回空
- `BasicFrameBodyRenderer` 用 `BlockView`（memo）递归渲染子块

### 2.3 内容分发（AssistantContentRenderer）

```js
contentType = content.type || "text"
1. customRenderer = assistantContentRenderers[contentType] ?? [toolName]   // 自定义渲染器
2. "text"      → <AssistantWidgetContent> + MarkdownRenderer（theme: "loose"）// 支持 widget 宿主
3. "reasoning" → <ReasoningRenderer complete>（theme: "reasoning"）          // 深度思考块
4. "tool-call" → customRenderer → defaultToolRenderer → DefaultToolRenderer   // 三级兜底
5. 搜索高亮跳过工具子树（wrapToolCallSkip，data-chat-search-skip）
```

### 2.4 深度思考块（reasoning.tsx）—— 用户看到的"深度思考"

```jsx
<section class="assistantReasoning [collapse] [complete|streaming]">
  <header class="assistantReasoningHeader [loadingText]" onClick>   ← 点击标题展开/收起
    {i18n["reasoning.title"]}   ← "深度思考"
    {complete && <IconDown 箭头>}                                    ← 完成态才显示箭头
  </header>
  <div class="assistantReasoningContent" ref onScroll>               ← 流式自动吸底
    <MarkdownRenderer complete>推理内容</MarkdownRenderer>
  </div>
</section>
```

- `useState(complete)` 初始折叠状态；`complete` 变 true 自动折叠
- `useReasoningScroll`：流式中（!complete && !collapse）自动吸底
- 点击标题 = 折叠/展开（清空选区防误选）

### 2.5 工具块通用容器（ToolCard）

```jsx
<div class="tool-card-container">
  <div class="tool-card">
    <div class="tool-inner [theme] [tool-status-pending]">   ← theme="border"，pending 高亮
      <div class="card-header [click-header] [expanded]" onClick>
        <div class="card-header-top">
          <div class="left">[icon] [title]</div>
          <div class="right">[control 右侧控件]</div>
        </div>
        [card-buttons 授权按钮区]
      </div>
      <div class="card-content [hidden]">[children]</div>     ← clickableHeader 时点 header 折叠
    </div>
    [card-bottom 底部（授权菜单）]
  </div>
</div>
```

- Renderer 接口：`className / defaultShowResult / clickHeader / theme` + `canHandle` + `render`
- 优先级 `ToolRendererPriority.EXACT`

### 2.6 工具渲染器注册表（每工具专属）

| 渲染器 | 要点 |
|---|---|
| **WriteFileRenderer** | 文件图标 + 文件名 + 操作标签（创建/编辑）+ 变更行数（悬停 View Changes）+ 展开折叠；结果区：`MultiEditDiffViewer`（多处修改）/ `DiffViewer`（改前改后）/ `TruncatedPre`（新文件内容）；执行中流式显示内容，完成切 diff |
| **ExecuteCommandRenderer** | 独立终端（useStandaloneTerminal）+ 授权菜单（confirm/run/skip/reject）+ 取消/跳过操作；状态机 pending→running→stream_executing→success/cancelled/skipped |
| **ask-user-question / delete-files / list-files / skill / task / mcp / image-gen / video-gen / unknown-tool** | 各自专属 UI |
| **tool-name-map** | 工具友好名：`write_to_file → "Write File"`（i18n），fallback 下划线转空格首字母大写 |

**TruncatedPre 截断保护**：超过 `MAX_RENDER_LINES` 后 `frozenRef` 冻结（不再响应流式增长），显示 "⋯ N more lines omitted. Click file name to see the full content."

### 2.7 工具图标注册表（tool-icon-registry）

```js
normalizeName: name.toLowerCase().replace(/[_-]/g, "")   // ToolSearch/tool_search/tool-search → toolsearch
resolveIconComponent: exactMatchMap.get(normalized)      // ①精确
                    ?? prefixEntries.find(normalized.startsWith)  // ②前缀
                    ?? FALLBACK_ICON                      // ③兜底
```

图标集：`EyeIcon`（读）/ `PencilIcon`（写/编辑）/ `TerminalIcon`（命令）/ `SearchIcon`（搜索/LSP）/ `TrashIcon`（删）/ `GlobeIcon`（网页）/ `WrenchIcon`（技能/工具）/ `SparkleIcon`（生成）/ `ImageIcon`（图片）/ `FolderIcon`（目录）/ `CloudIcon` / `DatabaseIcon` / `DebugIcon` / `CheckIcon` / `SendIcon` / `GridIcon` / `ClipboardIcon`

### 2.8 MetaFold 折叠（mata-fold/）—— 用户看到的"运行命令 · 已完成 5m17s"

**useFoldHook（折叠决策核心）：**

```js
extractContents(group.messages)  // 提取 assistant 内容（turnFoldItems + hasEnd）
computeFoldResult → { stats, segments, shouldFold }
  - 条件：enableMetaFold && 内容≥2 && 无不可折叠工具（ask_user 等交互工具不折叠）
  - computeSegments：连续可折叠内容 ≥2 个 → "foldable" 段；否则 "normal" 段
  - 折叠规则：foldable 段**后接正文** 或 **有结束标记** → shouldFold = true
contentCosts = allContents.map(estimateContentRenderCost)  // 渲染成本 → 分批预算
turnFoldActive = enableMetaFold && hasEnd && !isReceiving && lastBodyText && 内容>1 && !hasUnfoldableTool
turnCollapsed 默认 true（完成即折叠）
turnDurationMs = useTurnDurationMs(...)  // 轮次时长
```

**MetaFold UI：**

```jsx
<div class="metaFold [metaFoldOpen]">
  <div class="metaFoldHead" onClick role="button">       ← 键盘 Enter/Space 也支持
    [mfHeadIcon] [mfSummary 摘要文本]                    ← 有摘要显示摘要
      或 [mfSectionLabel 工具] [mfCount N] · [mfSectionLabel 消息] [mfCount M]  ← 无摘要显示统计
    [mfArrow ChevronDown]
  </div>
  [expanded && metaFoldBody]
    [expandedHeader]
    [visibleStart>0 && <button metaFoldMore>显示更早 N 条</button>]  ← 分批展开
    [visibleChildren]
    [expandedFooter]
  </div>
</div>
```

**分批展开（expand-budget）：**

```js
estimateContentRenderCost: tool-call = args字符 + result字符（walkChars 深度≤6）；text/reasoning = 文本长度
computeVisibleStart: 从尾部往前（用户最关心最近），每批 ≤15 项 / ≤24K 字符
"显示更早" → batchCount+1 → 更早窗口可见；折叠再展开不重置（保留进度）
```

### 2.9 摘要合成（mata-fold/summary/）

**工具描述符注册表（tool-registry.ts）——摘要的"动词+宾语"来源：**

```js
TOOL_DESCRIPTORS = [{
  canonical: "read_file", aliases: ["Read", "read-file"],
  category: "file_read", group: "read",
  actionKey: "metaFold.summary.action.read",          // 动词："读取"
  objectFields: ["filePath", "file_path", "path", "name", "file"],  // 宾语字段优先级
  noObjectKey: "metaFold.summary.noObject.read"        // 无宾语兜底
}, {
  canonical: "execute_command", aliases: ["Bash", "BashOutput", "KillShell", "execute"],
  actionKey: "...action.command", objectFields: ["command"], noObjectKey: "运行命令"
}, ...]
normalizeToolName: 别名归一化（mcp_* → mcp_call_tool，*_automation → automation_update）
```

**合成链路：** `extractAtom`（从工具参数提取动作+宾语）→ `selectSummary`（选最优决策）→ `renderTemplate`（渲染模板）→ `summary.text`

**模板（zh-CN）：**

| key | 文案 |
|---|---|
| `metaFold.summary.compose` | `{verb} {object}`（"读取 src/utils.ts"） |
| `metaFold.summary.running` | `正在{text}`（流式中） |
| `metaFold.summary.waiting` | `等待确认：{object}` |
| `metaFold.summary.waitingPlan` | 等待确认执行计划 |
| `metaFold.summary.categoryCount` | `{count} 类操作` |
| `metaFold.summary.multiStage` | `{verb1}、{verb2}：{topic}` |
| 动作动词 | 读取/写入/修改/追加内容到/删除/查看文件列表/搜索文件/搜索代码/检查诊断/运行命令/搜索资料/读取网页/整理任务计划/制定执行计划/加载技能/生成图片…（30+） |
| 无宾语兜底 | 查看相关文件/写入文件/修改文件/运行命令…（noObject.*） |

### 2.10 轮次时长（use-turn-duration-ms）—— 用户看到的"5m17s"

```js
startTime = 首条 user 消息 createTime（组内找，找不到向前回溯前驱组）
endTime   = 最晚 assistant 消息 finishTime（优先）或 createTime
边界      = session separator / compact divider / 新的 user 消息
显示      = fold.completedWithDuration："已完成 {duration}"（还有 fold.completed："已完成"）
```

### 2.11 工具状态三元组（每工具 running/done/error 词条）

| 工具 | 标题（fallbackTitle） | running | done | 其它 |
|---|---|---|---|---|
| command | 执行命令 | 执行中… | 运行成功 | confirm"确认执行命令？" run/skip/reject |
| readFile | — | 读取中 | 已读取 | 读取失败 |
| writeFile | — | 创建/生成中 / 编辑/修改中 | 创建/编辑 | {count} 处修改 · … 省略 {count} 行 · 接受/拒绝 |
| webSearch | 网页搜索 | 搜索网页中... | — | — |
| webFetch | 网页获取 | 生成摘要 | — | — |
| question | 向用户提问 | 问题生成中... | — | 等待你的回答... / 已跳过该问题 |
| plan | — | 制定计划中 | 已创建计划 | 预览计划 / 构建 |
| todo | 任务列表 | 接收中... | — | 进度更新 {completed}/{total} |

### 2.12 加载提示语（loading/tips）

- **WITTY_TIPS_ZH 100+ 条俏皮语**："信息梳头中" / "废话压缩中" / "重点藏得有点深，努力捞取" / "目标是少让你改两轮" / "咖啡因已就位，开始深度思考" / "正在把九曲十八弯的思路捋成一条直线" …
- **PRACTICAL_TIPS_ZH 实用技巧**："生成或修改文件，切换到做一做（Craft）模式" / "多步骤或重要任务，先用想一想（Plan）规划" …

### 2.13 其它细节

- **message-time**：今天 `HH:MM`；昨天 `昨天 HH:MM`；今年 `M月D日 HH:MM`；往年 `YYYY年M月D日 HH:MM`（英文对应 Mar 5 14:30）
- **AssistantWidgetContent**：文本块内嵌 widget 宿主（show_widget 提升到消息末尾 widgetContents）
- **checkpoint-actions / user-cancelled-indicator / continue-card / model-switch-divider**：检查点废弃恢复 / 用户取消指示 / 继续卡片 / 模型切换分隔线

### 2.14 渲染顺序（Virtuoso + renderMessageGroup + renderMessageItem）

**虚拟滚动（Virtuoso）：**
```js
itemContent: renderMessageGroup       // 每个轮次 group = 一个虚拟 item
overscan: 25                          // 视口外预渲染 25 个
increaseViewportBy: { top: 800, bottom: 800 }
initialTopMostItemIndex: 定位到最新组（会话活跃 align:"start"，否则 "end"）
atTopStateChange: 滚动到顶 → 加载更多历史（HeaderComponent spinner "正在加载更多"）
atBottomStateChange: 控制"回到底部"按钮（chatMessageBottomToolbar）
followOutput: 流式吸底跟随
alignToBottom: 活跃会话时底部对齐
```

**每轮次的 DOM 顺序（renderMessageGroup）：**
```jsx
<div class="group-messages" data-user-message-id>
  <ExpertFoldProvider>            // 专家折叠（专家消息收成一行）
    <MetaFoldProvider>            // 元折叠 Context（useFoldHook）
      group.messages.map(renderMessageItem)   // 组内消息按序渲染
    </MetaFoldProvider>
  </ExpertFoldProvider>
</div>
```
- `shouldApplyGroupMinHeight`：最后组最小高度填满视口（减去 FOOTER_HEIGHT）
- `isAssistantOnlyGroup`（继续组）→ paddingTop: 24

**renderMessageItem（单条消息）：**
- **user 分支**：`normalizeContentBlocks` → `contextBlocks`（资源链接上下文，按 uri+name 去重）/ `inputBlocks`（正文输入）→ UserBubble（Slate 编辑器，key = messageId + 规范化内容，内容变强制重挂载）；**编辑态**：userMessageEditor（保存=resendPrompt + isEdited 标记）
- **assistant 分支**：
  - 组内第一条 → **TurnFoldAvatar**（头像 + collapsible + foldStatus）
  - 后续消息 → 普通 Avatar（shouldShowAvatar 控制）
  - 内容 → **CompactAssMessage**（useFold 决策：折叠 → MetaFold 折叠条；展开 → 块渲染列表）
  - 用户取消 → cancelledIndicator；废弃 → checkpoint 恢复按钮

**TurnFoldAvatar —— "完成 5m17s"的真正载体：**
```js
foldStatus = turnDurationMs != null ? t("metaFold.turnCompletedWithDuration", { duration: formatDurationMs(turnDurationMs) }) : t("metaFold.turnCompleted")
// "已完成 5m17s" / "已完成"
<Avatar collapsible={turnFoldActive} collapsed={turnCollapsed} onToggle={() => setTurnCollapsed(!turnCollapsed)} foldStatus />
```
→ **轮次时长挂在"头像"上**（不是折叠条），**点击头像 = 切换整轮折叠**！这是用户看到的交互入口。

**formatDurationMs 格式：**
```js
hours > 0  → "1h23m"
minutes > 0 → "5m17s"    // ← 用户看到的 5m17s
else       → "42s"
```

**"显示更早"分批展开（expand-budget）：**
```js
estimateContentRenderCost: tool-call = args字符 + result字符（walk 深度≤6）；text/reasoning = 文本长度
computeVisibleStart: 从尾部往前（用户最关心最近），每批 ≤15 项 / ≤24K 字符
"显示更早" → batchCount+1 → 更早窗口可见；折叠再展开不重置（保留进度）
```

---

## 三、SUPERCRZY 差距矩阵

| 模块 | WorkBuddy | SUPERCRZY 现状 | 差距 |
|---|---|---|---|
| 交替式回复 | 系统提示引导 | ✅ 已有 | 无 |
| 过程折叠 | MetaFold（摘要+时长+统计） | 折叠条"执行过程·N 工具·N 思考"（固定文案） | **摘要合成 / 时长** |
| 展开回看 | 块树递归渲染 | ✅ flow 持久化已落地 | 无 |
| 深度思考块 | "深度思考"标题+点击展开+完成自动收+吸底 | ThinkingBlock"Turn N 正在思考"+按钮展开 | **标题/交互** |
| 工具卡片 | ToolCard 容器+每工具渲染器 | ToolCallBlock 8 态 | 已对齐（更细） |
| 行数徽标 | cb-file-diff +N/-M | ✅ lines-badge（刚修复） | 无 |
| 流式输出 | TruncatedPre（冻结） | ✅ streamOutput 滚动（更强） | 无 |
| 写文件 diff | DiffViewer/MultiEditDiffViewer | 只有行数徽标，无 diff 视图 | **diff 视图** |
| 工具图标 | tool-icon-registry（20+ 图标） | 仅命令/lint 有图标 | **图标注册表** |
| 工具友好名 | tool-name-map | 裸 toolName | **名称映射** |
| 执行状态条 | 输入框上方（正在执行命令/等待模型/生成回复中） | ✅ 刚实施 | 无 |
| 轮次时长 | "已完成 5m17s"**挂在轮次头像上**，点击头像切换折叠 | 有 elapsedMs 未展示 | **头像/折叠条时长** |
| 摘要合成 | 动词+宾语（运行命令/读取 X） | 无 | **描述符注册表** |
| 虚拟滚动 | Virtuoso（overscan 25 + 800px 预渲染 + 吸底 + 加载更多） | 普通滚动 | 低优先级 |
| 分批展开 | 15 项/24K 字符预算+"显示更早" | 无 | 低优先级 |
| 加载俏皮语 | 100+ 条轮播 | 无 | 低优先级 |
| 工具状态词条 | 每工具三元组 | 部分（chatui 有） | 中优先级 |
| 消息真实时间 | id 时间戳防污染 | 无 | 低优先级 |

---

## 四、复刻实施计划（保留 SUPERCRZY 样式）

### P0 · 核心体验闭环（一次做完）

1. **折叠条摘要合成**
   - 新建 `client/src/utils/tool-summary.ts`：TOOL_DESCRIPTORS 表（我们的工具名）
     - `shell_exec` → 动词"运行命令"，宾语 = command 参数
     - `file_read` → "读取"，宾语 = file_path
     - `file_write` → "写入"，宾语 = file_path（新文件）/ "修改"（已存在）
     - `file_search`/`glob`/`grep` → "搜索文件/搜索代码"
     - `lint_file` → "检查诊断"
     - `web_search` → "搜索资料"，`web_fetch` → "读取网页"
     - `git_*` → "处理 Git"，`task_*` → "整理任务"，`skill_*` → "加载技能"，`memory_*` → "处理记忆"
     - `draw_diagram` → "绘制图表"，`create_plan` → "制定执行计划"
     - 兜底："继续处理任务过程"
   - 合成规则：单工具 `动词+宾语`；多工具合并 `运行命令、修改：topic`；分类 `N 类操作`
2. **轮次时长**（"已完成 5m17s"）
   - 复用 `msg.elapsedMs`（done 事件已算）→ `formatDurationMs`（1h23m/5m17s/42s）
   - **挂载位置对齐 WorkBuddy：轮次头像上显示"已完成 5m17s"，点击头像切换折叠**（我们也可同时放折叠条）
3. **"深度思考"块**
   - ThinkingBlock：header 标题改 "深度思考"（i18n `chat.deepThinking`），点击标题展开/收起（替换按钮），完成自动收起 + 箭头

### P1 · 体验增强

4. **工具图标 + 友好名称**（tool-icon-registry 同款）
   - `client/src/utils/tool-meta.ts`：normalizeName → exactMatch → prefixMatch → fallback
   - SVG 描边图标（我们设计语言）：命令/文件读/文件写/搜索/网页/图表/Git/任务/技能/记忆/提问/兜底
   - 工具友好名映射：file_write→"写文件"、shell_exec→"运行命令"…
5. **写文件 Diff 视图**
   - 后端 file_write 返回 oldContent（已有？）+ 前端 DiffViewer 组件（行级 diff）
   - 新文件 → 内容截断 + "省略 N 行"；修改 → 改前/改后 diff
6. **加载俏皮提示语**
   - 状态条旁边轮播（复用 aiStatus 出现期间），我们自己的文案（禁 emoji）

### P2 · 完整对齐（按需）

7. 分批展开（"显示更早 N 条"）
8. 工具状态三元组词条补全
9. 消息真实时间修复

---

## 五、我们可超越 WorkBuddy 的优化点

1. **状态机更细**：我们 8 态（approved/skipped/denied 划线）vs WorkBuddy 5 态
2. **安全标签**：risk/perm/blocked 标签 WorkBuddy 没有
3. **流式输出**：我们边跑边滚 vs WorkBuddy TruncatedPre 冻结截断
4. **历史过程持久化**：我们 flow 落库可回看 vs WorkBuddy 刷新丢失
5. **幽灵工作台/宠物**：差异化功能，WorkBuddy 没有

---

## 六、参考源码位置（拆包路径）

```
conversation-render/src/list-like-render/…（扩展注册表/转换器）
conversation-render/src/block-render/…（块模型/渲染器）
cb-chat-ui/src/components/message-timeline.tsx（主组件）
cb-chat-ui/src/components/message-timeline/mata-fold/…（折叠/摘要/时长/预算）
cb-chat-ui/src/components/message-timeline/reasoning/reasoning.tsx（深度思考块）
cb-chat-ui/src/components/tool-renderer/common/tool-card.tsx（工具卡片容器）
cb-chat-ui/src/components/tools/renderers/…（每工具渲染器）
cb-chat-ui/src/components/message-timeline/loading/tips/*（俏皮提示语）
```
