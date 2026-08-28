# WorkBuddy 对话区细节全景研究（2026-08-21）

> 拆包 WorkBuddy 5.3.14（`/private/tmp/workbuddy-asar-review/renderer/assets/src-CocHqt_k.js`）系统性深挖。
> 目标：把 WorkBuddy 对话工作区的**每一处可感知细节**挖清楚（怎么实现、怎么配合），作为 SUPERCRZY BOT 的学习清单。
> 此前已研究（见 `alternating-chat-1to1-alignment-2026-08-21.md` / `workbuddy-chat-architecture-2026-08-21.md`）：交替式渲染、三层折叠、工具卡片、授权机制、打字机节奏、代码块、时间、图标、虚拟列表。

---

## 一、消息时间（MessageTime）

**WorkBuddy 实现**（`message-timeline/message-time/index.tsx`）：

```ts
今天 → "14:30"
昨天 → "昨天 14:30"
今年 → "8月21日 14:30"（中文）/ "Aug 21 14:30"（英文）
跨年 → "2025年12月31日 14:30" / "Dec 31, 2025 14:30"
```

- 基于 `useMemo`，locale 驱动
- 今天不显示日期只显示时分

**我们现状**：时间显示在消息 footer。✅ 基本对齐（需核对跨年/英文格式）。

---

## 二、消息操作栏 + 反馈（AssistantFeedback）

**WorkBuddy 实现**（`message-feedback/`）：

```
助手消息底部工具栏（完成态显示）：
┌──────────────────────────────────────────┐
│ [⧉ 复制] [👍] [👎] [⋯ 更多]     模型名/图标   │
└──────────────────────────────────────────┘
```

**显示条件**（关键细节）：
- `messageType === 'assistant'`
- **下一条不是 assistant**（连续 assistant 不重复显示）
- 消息 `complete`（或用户取消 / 非活动会话）
- `config.showFeedback !== false`

**各按钮实现**：
- **CopyButton**：仅复制 text blocks（`content.filter(type==='text')`），点击后图标变"已复制" 2s 恢复；带 Tooltip + 埋点（data-track-*）
- **RatingBar**：like/dislike（可配置 showLike/showDislike）
- **MoreMenu**：删除等（可配置 showDelete/showMoreMenu）
- **模型信息**：`message.extra.modelName/modelId` + `responseModelName/responseModelId`（自动模型时显示实际响应模型）+ `getModelIcon` 图标（url 或 inline-svg）
- **credit 显示**：`message.extra.credit`

**我们现状**：消息操作栏（复制/编辑/重发）已实现，但**缺**：👍👎 反馈、模型信息展示（当前用哪个模型回复）、credit 展示。

---

## 三、输入区（ChatInput）

**WorkBuddy 实现**（`chat-input/`，信息量大）：

| 细节 | 实现 |
|---|---|
| **高度记忆** | `INPUT_HEIGHT_STORAGE_KEY` localStorage 记忆输入框高度；`MIN/MAX_INPUT_HEIGHT` 限制；底部 `resize-handle` 拖拽调高 |
| **@提及** | mention 按钮 + mention-skeleton（加载态）；`use-content-blocks` 管理 |
| **additions** | 添加内容块（文件/图片等），`additions.tsx` + `addition-navigation.ts`（键盘导航） |
| **input-context** | 输入上下文（contextSlot），`input-context.tsx` |
| **输入历史** | `use-input-history.ts`（↑↓ 切换历史输入） |
| **键盘导航** | `keyboard-navigation.ts` + `use-chat-input-navigation.ts` |
| **上下文用量** | `context-usage-display.tsx` + `usage-by-category-popover.tsx`（按类别分类用量，popover 展开） |
| **拖拽** | `drop-zone.tsx`（拖文件进输入区）+ `drop-zone-filename-utils` |
| **模式选择** | craft/plan/ask 模式 + modeSelector（Expert 激活时变化） |
| **错误边界** | `chat-input-error-boundary`（输入区渲染错误隔离） |
| **命令风险** | `command-risk.ts`（输入命令风险检测） |
| **工具栏紧凑** | `use-toolbar-compaction.ts`（宽度不足时工具栏自动折叠） |

**我们现状**：输入框 + 附件 + 模型选择 + 语音 + 工作文件夹 + 权限已实现；**缺**：输入高度记忆/拖拽调整、@提及、输入历史（↑↓）、上下文用量环（分类 popover）、工具栏紧凑自适应。

---

## 四、消息队列（MessageQueuePanel）

**WorkBuddy 实现**：
- 待发送队列面板（连发多条时排队）
- 每项 = `contentBlocks` + `previewText`；**降级逻辑**：有文件 → 前缀"文件"图标文案，有图片 → "图片"前缀；无文本 → `emptyPreview` 占位
- 图标集：拖拽（drag）/发送/删除/加载中/编辑

**我们现状**：有 pendingQueue（待发送队列）✅ 但 UI 形态未对齐（我们是待发送队列发送逻辑，WorkBuddy 有独立面板 + 拖拽排序）。

---

## 五、文件变更面板（FileChangesPanel）

**WorkBuddy 实现**：
- `files` 列表 + **`checkpoints` 快照下拉**（回到某个 checkpoint 查看当时文件状态）
- `onAcceptAll / onRejectAll`（全部接受/拒绝）
- `onFileClick`（点文件定位）、`onFileAccept/onFileReject`（单个文件接受/拒绝）
- `expanded` 展开态 + checkpoint 下拉点击外部关闭

**我们现状**：右侧 DetailPanel 有变更 Tab + diff ✅；**缺**：checkpoint 快照选择器（回到历史状态看文件）、全部接受/拒绝按钮。

---

## 六、错误横幅（ErrorBanner）

**WorkBuddy 实现**：错误时对话区顶部横幅，操作 = **关闭 / 复制错误信息 / 重试 / 查看文档 / 提交反馈**（5 个动作，均有 i18n）。

**我们现状**：消息有错误提示 + 重试按钮；**缺**：统一的错误横幅（复制错误/查看文档/提交反馈）。

---

## 七、问题浮层（QuestionFloating）

**WorkBuddy 实现**：Agent 提问时浮层（对话区顶部 portal，与授权浮层同级）：
- `questions[]` + **`currentIndex` 逐个提问**（一次一个）
- 选项选择（onSelect）/ 自定义输入（customInputs，**多选自由输入支持"反选"标记**：用户勾掉排除但保留草稿）
- onDismiss / onSkip（跳过）

**我们现状**：有 ask_question 工具 + 提问面板（ChatView question 事件）✅；**缺**：逐个提问的浮层形态（当前可能是内嵌卡片）。

---

## 八、Agent 卡片（AgentCard）

**WorkBuddy 实现**：聊天中 Agent 角色卡片（ChatBubbleIcon + context-menu 菜单）。**我们现状**：有角色系统（RoleCapsule）✅，形态可对齐。

---

## 九、输入横幅（InputBanner）

**WorkBuddy 实现**：输入区上方的提示横幅（warning 三角图标 / info 圆点图标 + 文案），如 API 异常提示。**我们现状**：欢迎页有 API Key 引导卡，但输入区上方无统一横幅。

---

## 十、额度估算（CreditEstimate）

**WorkBuddy 实现**：`formatCreditRange({min,max})`——区间格式化（min===max 显示单值，0 处理特殊逻辑）+ 校验；发送前估算额度显示。**我们现状**：无额度体系（商业化后需要）。

---

## 十一、其它待挖模块（目录已定位）

| 模块 | 说明 | 优先级 |
|---|---|---|
| `breadcrumb` | 面包屑（会话路径） | 低 |
| `collapsible-section` | 可折叠区块（侧栏） | 低 |
| `confirm-dialog` | 确认对话框 | 中 |
| `context-menu` | 右键菜单 | 低 |
| `dnd-editor` | 拖拽编辑器（消息块拖拽排序？） | 中 |
| `integration` | 集成（连接器） | 中 |
| `plugins` | 插件系统 | 高（技能包方向） |
| `share-file-dialog` / `share-channel` | 分享文件/渠道 | 高（分享导出方向） |
| `sidebar-nav` / `chat-search` | 侧栏导航 / 会话搜索 | 中 |
| `top-tab` | 顶部 Tab（任务列表/文件列表） | 中 |
| `task-list` | 任务列表 | 高（计划方向） |
| `cb-infinite-scroll` / `scroll-list` | 无限滚动（历史加载） | 高（虚拟列表方向） |
| `credit-usage-text` | 额度文本 | 低 |

---

## 十二、学习建议优先级（用户可感知价值排序）

| 优先级 | 细节 | 理由 |
|---|---|---|
| P0 | **消息反馈栏**（👍👎 + 模型信息 + 复制） | 每轮都可见，完成态交互完整性 |
| P0 | **问题浮层逐个提问** | Agent 提问是高频交互，浮层更醒目 |
| P1 | **输入区增强**（高度记忆/输入历史 ↑↓/上下文环） | 输入体验直接感知 |
| P1 | **文件变更 checkpoint 快照** | 已有变更面板，补快照选择器 |
| P2 | **错误横幅**（复制错误/重试/反馈） | 异常场景体验 |
| P2 | **输入横幅**（统一提示位） | 欢迎页引导迁移 |
| P3 | 额度/分享/插件/任务列表 | 商业化/传播阶段再做 |

---

## 结论

WorkBuddy 的"细节感"来自一套**统一的交互约定**：
1. **浮层化**（授权/问题/错误都在对话区顶部 portal，不推挤消息流）
2. **图标 + Tooltip**（所有按钮 icon + tooltip，hover 可懂）
3. **状态反馈**（复制 2s 恢复、加载动画、埋点）
4. **配置开关**（每个细节都有 config.showXxx，可裁剪）
5. **localStorage 记忆**（输入高度等个性化）

我们的对话工作区核心（交替式/折叠/工具/代码块）已对齐，**下一步按上表 P0→P2 逐项补齐细节**。
