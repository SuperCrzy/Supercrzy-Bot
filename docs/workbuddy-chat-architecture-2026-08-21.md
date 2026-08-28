# WorkBuddy 5.3.14 对话区底层架构研究报告

> 拆包对象：`/Applications/WorkBuddy.app/Contents/Resources/app.asar`（270M，2026-08-17 构建）
> 拆包目录：`/private/tmp/workbuddy-asar-review/`，核心源码在 `renderer/assets/src-CocHqt_k.js`（9.9M，557 个组件源文件，`//#region` 注释暴露完整源码路径）
> 研究日期：2026-08-21

## 一、一句话结论

WorkBuddy 对话区 = **"content blocks 顺序数组"数据模型 + 按 type 分派的渲染器 + 可选的折叠增强**。默认（非紧凑模式）就是**纯交替式渲染**——思考、正文、工具、正文按真实顺序全部显示；折叠是"紧凑模式"开关下的增强，完成态 turnFold 只留最后正文 + 图。

**这印证了老板要的"交替式对话"就是 WorkBuddy 的默认形态，我们不应把折叠做成默认。**

---

## 二、数据模型（核心）

一条 assistant 消息 = `content: AssistantMessageContent[]`——**content blocks 顺序数组**：

```ts
type AssistantMessageContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }          // 深度思考
  | { type: 'tool-call'; tool: ToolCall }        // 工具调用（含 id/name/arguments/status/result/duration）
  | { type: 'image' }                             // 图片
  | { type: 'plan' }                              // 计划
  | { type: 'question'; question: ...; options }  // 提问
  | { type: 'artifact' }                          // 产物
```

- **交替式 = 数组按真实顺序保存**：`[reasoning, text, tool-call, text, tool-call, text]`——思考→说明→工具→回复交替排列
- 消息级字段：`messageId`、`requestId`、`createTime`（开始流式）、**`finishTime`（收尾时精确写入，供耗时计算）**、`complete`、`extra`
- 工具块内部：`toolCallId`、`name`、`arguments`、`status`（pending/approved/running/executed/error/denied…）、`result`、`duration`、`streamOutput`、`metaData`
- 维护方：`acp-message-accumulator`（toolCallId → contentBlockIndex 映射、toolCallId → parser、toolCallId → status、parentToolUseId → 子 Agent）

## 三、渲染流程（交替式如何实现）

```
MessageTimeline
└── useMessageGroups（按 user 消息分组）
    └── MessageGroup
        ├── UserMessage（user-bubble + 编辑 + 工具条）
        └── AssistantMessage（CompactAssMessage）
            └── AssistantContentRenderer（按 content.type 分派，逐个渲染）
                ├── text       → Markdown 正文（AssistantWidgetContent，含 widget 宿主）
                ├── reasoning  → 思考块（ThinkingBlock）
                ├── tool-call  → ToolCard（tool-renderer registry 按工具名分派）
                ├── image      → 图片渲染器
                ├── plan       → 计划渲染器
                ├── question   → 问答卡片（question-answer-display）
                └── artifact   → 产物卡片
```

**不折叠时（useFold=false）**：`contents.map(renderContent)` 按 index 顺序全部渲染——这就是交替式。**正文永远原位，思考/工具按真实顺序插在正文之间。**

## 四、折叠模型（三层，enableMetaFold=isCompactMode 才启用）

1. **段级折叠（执行中）**：`computeSegments` 把连续 `reasoning/tool-call`（≥2 个）聚成 foldable 段（**单个工具不折叠**，直接显示）；`seg.shouldFold = bodyTextAfter || hasEnd`（从后往前：**段后有正文→折叠**；**流结束→全部折叠**）。折叠条 `MetaFold`：summary + stats（工具 N 次·消息 M 条·错误 N）+ topToolName headIcon + **isRunning（接收中显示运行态）**
2. **turnFold（完成态整体折叠）**：`turnFoldActive = enableMetaFold && hasEnd && !isReceiving && lastBodyTextContent && length>1` → 消息收成 Avatar 头部（collapsible），只渲染 **turnFoldSegments 中的 anchor（最后正文）+ widgetContents（show_widget/图 提升显示）**，其余收进 MetaFold 折叠条
3. **豁免**：show_widget 类工具（图）、支付卡、宿主标记 unfoldable 的工具——不折叠，常显

## 五、工具渲染（tool-renderer 体系）

- **ToolCard**（common/tool-card.tsx）：通用卡片容器
  ```
  tool-card-container → tool-card → tool-inner
    ├── card-header（icon + title + control + buttons；clickableHeader 点击切换）
    ├── card-content（hidden: !resultVisible —— 结果默认折叠，点击展开；defaultShowResult 控制）
    └── card-bottom
  ```
- **registry 分派**：`assistantContentRenderers[toolName]` → 各工具专用渲染器（execute-command / delete-files / image-gen / completion / connect-cloud-service 等）+ `defaultToolRenderer` 兜底
- **common**：diff-viewer、tool-approval-menu（权限）、loading-dots、tool-renderer-error-boundary、truncate-tool-content、tool-value-normalizer
- **名称映射**：`getToolDisplayName(toolName)`（i18n key 表 + fallback 下划线转空格）
- **icon**：tool-renderer/icons（index.ts 聚合）、getToolIconByName

## 六、时间显示（三处配合）

1. **MessageTime**（message-time/index.tsx）：消息时间——今天 `HH:MM`；昨天 `昨天 HH:MM`；今年 `M月D日 HH:MM`；往年 `YYYY年M月D日 HH:MM`（按 locale）
2. **turnDurationMs**（use-turn-duration-ms.ts）：**轮次耗时 = 最后 assistant 消息的 finishTime（精确结束）− createTime（开始流式）**；跨组计算（下一组 user 消息前最近的 assistant end）；历史回放无 finishTime 时回退 createTime 差值
3. **ToolCard duration**：单工具耗时（工具完成后）

## 七、虚拟列表

`react-virtuoso`，配置 `overscan: 200` + `increaseViewportBy: { top: 1500, bottom: 1500 }`——只渲染视口附近（我们当前是"尾部优先渐进加载"，DOM 仍会全量，是差距）

## 八、其他配套

- **accumulator**（acp-message-accumulator）：ACP 事件 → content blocks 增量构建，支持断线 hydrate 继续接收
- **reconnect-retry**（acp-reconnect-retry）：断线重试
- **expand-budget**（expand-budget.ts）：展开预算——24K 字符 / 6 层深度成本走查（"显示更早"分批）
- **loading/tips**：加载骨架 + 提示语（中英）
- **continue-card**：轮次超限后的"继续"卡片
- **checkpoint-actions / restore-button**：checkpoint 恢复
- **summary-context**：会话总结上下文
- **session-separator / compact-divider**：会话/紧凑模式分隔线
- **user-cancelled-indicator**：用户取消标记
- **model-switch-divider**：模型切换分隔
- **message-skeleton**：消息骨架屏

## 九、对我们项目的启示与建议

| WorkBuddy | 我们 | 差距/建议 |
|---|---|---|
| content blocks 单轨数组 | content + flow 双轨 | 渲染层已统一（id 全覆盖），存储迁移为后续 |
| 默认交替式全渲染 | 应恢复 | **默认执行中交替式**：thinking 摘要行 + 说明文字 + 工具卡片 + 回复按顺序显示 |
| 完成态 turnFold 只出结论 | ✅ 已实现 | 保留（用户明确要求"最后只出现结论"） |
| 工具卡片 clickableHeader + 结果默认折叠 | ToolCallBlock 完成折叠 ✅ | 执行中默认**不展开**（紧凑），点击展开 |
| 思考块独立 block | thinking 节点 ✅ | 完成折叠成"深度思考 N 轮"，**进行中不撑开大段推理** |
| MetaFold 折叠条（summary+stats+icon+isRunning） | ✅ 折叠条 + 动态摘要 + 行数 | 对齐 |
| turnDurationMs（finishTime−createTime） | ✅ done 时 elapsedMs | 对齐 |
| MessageTime 分级时间 | ✅ 已有 | 对齐 |
| 工具名 i18n 映射 + icon 注册表 | ✅ tool-meta/renderer-registry | 对齐 |
| 虚拟列表 virtuoso | 渐进加载 | 真窗口化为后续 |
| 断线 hydrate | 重试+去重 | 事件缓冲续传为后续 |

## 十、建议的最终形态（一次改对）

```
执行中（交替式，默认）：
  [深度思考]（一行摘要，进行中显示状态）
  AI 说明文字（markdown 正常显示）     ← "思考完会读一小段"
  [工具卡片]（icon+名+状态+耗时，紧凑，点击展开输出/diff）
  AI 回复（正常显示）
  ... 交替按真实顺序 ...

完成后（整体折叠）：
  你的消息
  [执行过程 工具9次·思考3轮 · 已完成 24s]（一个折叠条，点击展开完整交替过程）
  最终结论（最后一段正文）
  图/产物（保留）
```
