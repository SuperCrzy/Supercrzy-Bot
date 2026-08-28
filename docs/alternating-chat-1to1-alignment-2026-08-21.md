# SUPERCRZY 交替式对话 1:1 对齐方案（基于 WorkBuddy 5.3.14 拆包深度研究）

> 研究日期：2026-08-21
> 拆包对象：`/Applications/WorkBuddy.app` renderer/assets/src-CocHqt_k.js（9.9M，557 组件源文件）
> 目标：交替式对话的**渲染流程、折叠、工具、时间、面板、编辑器、图标**全部对齐 WorkBuddy

## 一、WorkBuddy 交替式对话的完整架构（双层）

```
┌─ conversation-render（渲染内核：块引擎 + 扩展系统）
│   BlockView / BlockMap —— 块渲染（content → block → 组件）
│   extensions（converters + renderers 注册表）：
│   ├── reasoning  （convertReasoningPart → ReasoningRenderer）
│   ├── user-message（toolbar/frame/self-bubble）
│   ├── tool-call  （ToolCard）
│   └── text / image / plan / question / artifact ...
│
└─ cb-chat-ui（对话 UI 壳）
    MessageTimeline（react-virtuoso 虚拟列表，overscan 200 + viewport 1500）
    └── message-timeline（消息布局：avatar/assistantCreateTime/正文/工具卡片/操作栏/加载更多）
        └── CompactAssMessage（useFoldHook 交替式渲染核心）
            ├── useFold=false → contents.map(renderContent) ← 【纯交替式：思考→正文→工具→正文 全渲染】
            ├── 折叠模式 → segments.map：
            │     foldable 段 → MetaFold（折叠条：stats/summary/headIcon/isRunning/itemCosts，children=段内渲染）
            │     normal 段（正文）→ 直接渲染【正文永不折叠】
            └── turnFold（完成态）：turnCollapsed → 只渲染 anchor（最后正文）+ widgetContents（图/产物）
        └── AssistantContentRenderer（按 contentType 分派）
            ├── text → AssistantWidgetContent（widget 宿主）+ MarkdownThemeProvider("loose") + MarkdownRenderer
            ├── reasoning → MarkdownThemeProvider("reasoning") + ReasoningRenderer（complete 控制）
            ├── tool-call → assistantContentRenderers[toolName] → defaultToolRenderer → DefaultToolRenderer
            └── 其他 → renderers 注册表
```

## 二、协作机制（各系统怎么配合）

### 1. 数据模型（一切的基础）
- assistant 消息 = `content: AssistantMessageContent[]` **顺序数组**（交替式的根基）
- 类型：`text | reasoning | tool-call | image | plan | question | artifact`
- 消息字段：`createTime`（开始流式）、**`finishTime`（收尾精确写入，耗时计算）**、`complete`（是否播完）、`requestId`
- ACP accumulator：`toolCallId → contentBlockIndex / parser / status`，断线 hydrate 续传

### 2. 交替式渲染（核心）
- **useFold=false（默认）**：`contents.map(renderContent)` —— 按数组顺序全部渲染，思考/正文/工具交替出现
- **折叠模式**：foldable 段（连续 reasoning/tool-call ≥2）→ MetaFold 折叠条；normal 段（正文/单工具）**直接渲染** → 正文永远原位
- **完成态 turnFold**：`hasEnd && !isReceiving` → 只留 anchor（最后正文）+ widget，其余收进 MetaFold

### 3. 折叠系统（useFoldHook）
- `enableMetaFold = isCompactMode`（紧凑模式开关）
- `computeSegments`：连续 foldable ≥2 成段；单工具 normal
- `seg.shouldFold = bodyTextAfter || hasEnd`（从后往前：段后有正文→折叠；流结束→全部折叠）
- MetaFold 折叠条：`stats（工具 N 次·消息 M 条·错误 N）+ summary + headIcon（topToolName 图标）+ isRunning（接收中运行态）+ itemCosts（展开预算）`
- expand-budget：24K 字符 / 6 层深度成本走查（"显示更早"分批）

### 4. 工具系统（tool-renderer）
- `ToolCard`：通用卡片容器（icon + title + control + buttons + card-content[hidden:!resultVisible] + bottom）
- `assistantContentRenderers[toolName]` 注册表 → 各工具专用 renderer（execute-command/delete-files/image-gen/completion/connect-cloud-service…）→ `defaultToolRenderer` 兜底 → `DefaultToolRenderer`
- `tool-name-map`：`getToolDisplayName`（i18n key 表 + fallback 下划线转空格）
- 图标：`getToolIconByName`（tool-renderer/icons）

### 5. 时间系统
- `MessageTime`（message-time）：今天 `HH:MM` / 昨天 `昨天 HH:MM` / 今年 `M月D日 HH:MM` / 往年 `YYYY年M月D日 HH:MM`
- `useTurnDurationMs`：轮次耗时 = `finishTime − createTime`（收尾写入精确值）；跨组计算；历史回退 createTime 差值
- 工具 duration：ToolCard 内（工具完成）

### 6. 面板/编辑器
- plan-editor（计划编辑器：创建/编辑执行计划）
- question-floating（提问浮层）
- file-changes-panel（文件变更 diff 面板）
- task-list（任务列表）
- dnd-editor（拖拽编辑器）
- message-queue-panel（消息队列）/ queue-banner

### 7. 图标（用户问的）
- **Codicon（VS Code 同款图标库）**：`init_codicon` 全量引入
- 工具图标：tool-renderer/icons 注册表（按工具名取图标）

### 8. markdown 渲染
- `MarkdownThemeProvider`：主题体系（text="loose" / reasoning="reasoning"）
- `MarkdownRenderer`：`complete: message.complete`（流式中不完整渲染）
- `AssistantWidgetContent`：**widget 宿主**（markdown 里的图/代码块等 widget 化，可点开展开/操作）

## 三、我们 1:1 对齐状态

| WorkBuddy 系统 | 我们 | 状态 |
|---|---|---|
| 交替式渲染（contents.map） | flow 顺序渲染 | ✅ **已对齐** |
| 正文永不折叠 | text 段独立永不折叠 | ✅ **已对齐**（17:51 修复） |
| turnFold 完成态折叠 | 完成态合并折叠条 | ✅ **已对齐** |
| MetaFold 折叠条（stats/summary/icon/isRunning/耗时） | 折叠条 + 动态摘要 + 行数 + 耗时 | ✅ **已对齐** |
| ToolCard + registry + name-map | ToolCallBlock + tool-renderer-registry + tool-meta | ✅ **已对齐** |
| 工具执行中紧凑/完成后折叠 | ✅ | ✅ **已对齐** |
| MessageTime + turnDuration | ✅ | ✅ **已对齐** |
| 思考流式可见 + 完成后折叠 | ✅（ThinkingBlock + 自动滚动） | ✅ **已对齐** |
| **conversation-render 块引擎 + extensions** | MessageFlowRenderer 模板分派 | ⚠️ 概念对齐，无扩展系统 |
| **Codicon 图标库** | 手绘 SVG 图标 | ⚠️ 视觉风格可统一 |
| **MarkdownThemeProvider 主题** | 单一 markdown 样式 | ⚠️ 无 loose/reasoning 主题区分 |
| **AssistantWidgetContent widget 宿主** | v-html markdown | ⚠️ 图/代码块已处理，widget 化未做 |
| **react-virtuoso 虚拟列表** | 尾部优先渐进加载 | ⚠️ 真窗口化未做 |
| **ACP accumulator 断线续传** | SSE 重试+去重 | ⚠️ 事件缓冲续传未做 |
| plan-editor / question-floating / file-changes-panel | PlanCapsule / 提问面板 / DetailPanel | ✅ 已有对应，形态差异 |

## 四、对齐实施批次（建议顺序）

### 第一批（对话区体验补齐，1-2 天）
1. **工具名 i18n 映射**：对齐 `getToolDisplayName`（i18n key + fallback）
2. **工具图标注册表**：`getToolIconByName` 统一入口（现有 toolIcon 手绘 SVG 收进注册表）
3. **Markdown 主题区分**：正文/思考分别用 loose/reasoning 样式变量
4. **widget 宿主**：markdown 里 ```html 预览卡片、代码块折叠、SVG 卡片化（部分已有，补统一宿主）

### 第二批（架构级，2-3 天）
5. **渲染器注册表重构**：text/reasoning/tool/image 分派走注册表（对齐 AssistantContentRenderer + extensions 概念）
6. **真虚拟列表**：消息区窗口化（替换渐进加载）

### 第三批（深度对齐，按需）
7. **Codicon 全量**（视觉统一，工程量大）
8. **ACP 事件缓冲断线续传**
9. **plan-editor / queue-panel 完整版**

## 五、结论

**交替式对话核心（渲染/折叠/工具/时间/面板）已 1:1 对齐**；剩余差距主要在**深层架构**（块引擎扩展系统、widget 宿主、markdown 主题、Codicon、真虚拟列表、ACP 续传）。建议按第一批先补齐对话区体验，第二批做架构重构，第三批按产品需要取舍。
