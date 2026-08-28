# WorkBuddy 交替式对话目录结构 + 语义联动机制（源码级实证·第二篇）

> 拆包对象：/Applications/WorkBuddy.app（658M 解包于 /tmp/wb-asar2）
> 本篇聚焦：①完整目录结构（双层包架构）②"语义联动"机制（卡片文案动态推导，非写死）
> 前篇：WORKBUDDY_DEEP_DIVE_INTERLEAVED_2026-08-20.md（数据模型/状态机/i18n/icon/联动链条）
> 日期：2026-08-20

---

## 一、双层包架构（谁负责什么）

WorkBuddy 把"渲染引擎"和"渲染器实现"拆成两个包：

```
packages/conversation-render/    ← 渲染引擎（通用、无业务）
└── src/
    ├── shared/                      共享层
    │   ├── i18n/                    create-t / use-i18n / locales/{en-US,zh-CN}.ts
    │   ├── theme/                   css-var / config-provider / use-expand-motion
    │   ├── components/              icon-button / tooltip / popover / menu / search-panel
    │   ├── icons/                   chat-input 系列 / toolbar / tool 系列
    │   ├── search/                  搜索结果高亮（highlight-dom / markdown-to-searchable）
    │   └── components/react-markdown/  markdown 渲染
    │       ├── code-block/          代码块（one-dark/one-light 主题）
    │       ├── inline-code/         ★行内代码 = 路径检测器（见 4.6）
    │       │   ├── path-detector.ts ★5 级路径模式检测
    │       │   ├── use-path-detection.ts
    │       │   └── use-resolved-type.ts
    │       └── utils/               truncate-path.ts（路径截断）
    ├── block-render/                通用块渲染引擎（block model/operations/renderer/registry）
    ├── list-like-render/            虚拟列表渲染（Virtuoso）+ 事件总线 + 扩展
    ├── scenarios/                   场景层
    │   ├── common/
    │   │   ├── tool-call/           ★工具调用场景
    │   │   │   ├── tool-view-runtime.tsx   RenderRuntimeProvider（宿主注入运行时）
    │   │   │   ├── tool-view-types.ts      defineTool + matchPriority + ToolMatchPriority
    │   │   │   └── views/           22+ 工具视图（read-file / write-file / web-fetch ...）
    │   │   │       ├── _shared/     tool-avatar.tsx（工具头像）
    │   │   │       └── entries.ts   ★渲染器注册入口
    │   │   └── workbuddy-message/   agent / cancelled-indicator / self-bubble / user-message-editor
    │   └── task-chat/               TaskChatList / MessageLinkedList / message-transforms
    └── chat-input/                  Slate 编辑器（phrase 短语 / status-chips / send-button）

packages/cb-chat-ui/              ← 渲染器实现层（有业务、具体工具）
└── src/components/tool-renderer/
    ├── common/                      ToolCard 公共组件（SingleLineToolHeader 等）
    ├── icons/                       工具图标集
    ├── renderers/                  ★20 个工具渲染器目录
    │   ├── read-file/               read-file-renderer.tsx（full）+ read-file-compact-renderer.tsx
    │   ├── write-file/              write-file-renderer.tsx + compact + animated-number.tsx（数字滚动）
    │   ├── list-file/               list-file-renderer.tsx + compact
    │   ├── web-search/              web-search-renderer.tsx + compact + web-search-utils.ts
    │   ├── web-fetch/               web-fetch-renderer.tsx + compact（★compact = 一行卡片）
    │   ├── execute-command/         execute-command-renderer.tsx + compact
    │   ├── image-gen/               image-gen-renderer.tsx
    │   ├── video-gen/               video-gen-renderer.tsx
    │   ├── skill/                   skill-renderer.tsx
    │   ├── task/                    task-renderer.tsx
    │   ├── plan/                    plan-create / plan-update renderer
    │   ├── plan-task/               plan-task-renderer.tsx
    │   ├── mcp/                     mcp-tool / mcp-match / mcp-integration renderer
    │   ├── delete-files/            delete-files-renderer.tsx + compact
    │   ├── read-lints/              read-lints-renderer.tsx
    │   ├── completion/              completion-renderer.tsx
    │   ├── connect-cloud-service/   connect-cloud-service-renderer.tsx
    │   ├── open-result-view/        open-result-view-renderer.tsx
    │   ├── search-reference/        search-reference-renderer.tsx（知识库检索）
    │   └── unknown-tool/            unknown-tool-renderer.tsx（兜底）
    └── index.ts                    ★toolRendererRegistry 注册入口
```

**每个工具渲染器目录的标准结构**：
```
read-file/
├── read-file-renderer.tsx          完整模式（full）
├── read-file-compact-renderer.tsx  折叠模式（compact）← 默认形态
├── read-file-utils.ts              数据转换/工具函数
└── index.ts                        导出 createReadFileRenderer(config)
```

**关键设计：compact / full 双形态**。`createXxxRenderer(config)` 工厂接收 `{compact?: boolean}`——`compact=true` 渲染一行 header，否则完整视图。**默认 compact**。

---

## 二、配套体系（tool-renderer 层 7 件套）

| 配套 | 作用 |
|---|---|
| `toolRendererRegistry` | 渲染器注册表（index.ts 统一登记） |
| `ToolRendererPriority` | 渲染器竞争优先级（NONE=0 / DEFAULT=1 / EXACT=10） |
| `ToolArgsValidator` | 工具参数校验器——参数错误时给出语义化反馈 |
| `resolveToolExplanation` | 工具语义解释（展示"为什么调用这个工具"） |
| `getToolIcon` | icon 解析入口（走 toolIconEntries 注册表） |
| `ToolRendererErrorBoundary` | 渲染器错误边界（单卡片崩溃不炸整个消息区） |
| `config.renderIcon?.(tool.name, props)` | 渲染器级 icon 覆盖钩子（默认用注册表 icon） |

---

## 三、语义联动：8 大模式（核心章节）

> 用户洞察"操作任务和工具时与语义联动，不是固定的，会显得智能"——WorkBuddy 的实现即"卡片文案由数据动态推导"。

### 3.1 状态机 → 状态词（每个 renderer 内部 switch）

```js
// 所有 renderer 统一的两组集合：
const isExecuting = ["idle","pending","parsing","stream_executing","full_executing"].includes(tool.status);
const isCompleted = tool.status === "executed";
const isFailed    = tool.status === "failed" || tool.status === "cancelled";
```

进行中 5 态 → 进行时状态词（读取中/搜索中/生成摘要），executed → 完成态（已读取/已搜索），failed/cancelled → 失败态。

### 3.2 动词动态推导（不写死操作名）★

```js
// write-file：新建 vs 修改 是推导出来的，不是工具名写死
const isModify = tool.name === "replace_in_file" || oldContent && !isNewFile;
const getOperateName = () => {
  if (isModify) return isExecuting ? i18n["tool.writeFile.modifying"] : i18n["tool.writeFile.edited"];
  return isExecuting ? i18n["tool.writeFile.generating"] : i18n["tool.writeFile.created"];
};
// 结果：同一工具，根据是否已有旧内容，显示"生成中/已创建" 或 "修改中/已编辑"
```

### 3.3 数字动态计算

```js
// write-file：LCS diff → +N/-M 行（diffLines 逐行对比）
const { addedLines, removedLines } = computeLineDiffStats(oldContent, newContent);
// 多文件编辑：修改 {index}/{total}（editIndex）· {count} 处修改（multiEditCount）
```

### 3.4 i18n 插值（{count} 模板）

```
tool.writeFile.multiEditCount = {count} 处修改
tool.writeFile.editIndex      = 修改 {index}/{total}
tool.listFile.moreResults     = {count} 个更多文件
tool.imageGen.generatingWithPrompt = 生成中: {prompt}
```

### 3.5 标题三级语义回落 ★

```js
// web-fetch：网页真实标题 → 域名 → i18n 兜底
const displayTitle = (pageTitle ?? "").trim() || getDomainFromUrl(url) || i18n["tool.webFetch.title"];
```

### 3.6 文件名 → 点击定位（onFileClick）

```js
// read-file / write-file / list-file 全部支持
onFileClick(filePath, startLine, endLine);  // 打开文件 + 光标定位行号
// web-search 另有 onResultClick（结果可点击）
```

### 3.7 正文路径检测（inline-code path-detector）★

**AI 回复正文里的代码路径/符号自动变成可点击链接**——正文层面的语义联动：

```js
// path-detector.ts 5 级模式：
SYMBOL_PATTERN         = /^[a-zA-Z_][a-zA-Z0-9_]*$/                        // 符号（变量/函数名）
ABSOLUTE_PATH_PATTERN  = /^(?:[a-zA-Z]:[\\/]|[\\/])(?:[^\\/]+[\\/])*[^\\/]+[\\/]?/  // 绝对路径
RELATIVE_PATH_PATTERN  = /^(?![.\\/]$).../                                 // 相对路径
FILENAME_PATTERN       = /^(?:[^\\/]+)\.(?:[a-zA-Z0-9]+)$/                 // 文件名（带扩展名）
CODE_RANGE_PATTERN     = ...                                               // 代码范围（含行号 L12-30）

// 检测类型函数：isSymbol / isAbsolutePath / isRelativePath / isFilename
//              hasLineRange（带行号）/ parseLineRange（解析 L12-30）/ extractPurePath
// 综合判定：detectPathType → detectPath（usePathDetection hook）
```

→ 正文中 `src/utils/tool-meta.ts`、`demo.py`、`app.ts:12` 均可识别、可点击、可定位。

### 3.8 展开决策语义化

```js
// write-file：执行中有 diff → 自动展开；完成后有 diff → 手动展开
const hasDiff = !!(addedLines || removedLines) || isMultiEdit;
const expanded = showFileChangesDetails && hasDiff && isExecuting
              || isCompleted && hasDiff && manuallyExpanded;
// web-search：完成且有条目才可展开（canExpand），否则 header 不可点
const canExpand = isCompleted && hasResults;
```

---

## 四、WebFetchCompactRenderer 全文（我们方案 A 的官方答案）

```jsx
function WebFetchCompactRenderer({ tool, config }) {
  const { url, title: pageTitle, loading } = normalizeWebFetchData(converter(tool));
  const displayTitle = pageTitle.trim() || getDomainFromUrl(url) || i18n["tool.webFetch.title"];
  const isExecuting = ["idle","pending","parsing","stream_executing","full_executing"].includes(tool.status);

  return (
    <div className="web-fetch-compact">
      <div className="web-fetch-compact__header">
        {!isExecuting && (config?.renderIcon?.(tool.name) || <WebIcon/>)}   {/* 执行中隐藏 icon */}
        <span className={isExecuting ? "--loading" : ""}>
          {isExecuting && loading ? i18n["tool.webFetch.summarizing"] : i18n["tool.webFetch.title"]}
          {/* 执行中+loading → "生成摘要"；否则 → "网页获取" */}
        </span>
        <span className="web-fetch-compact__title">{displayTitle}</span>
      </div>
    </div>
  );
}
// converter：从 tool.result 提取结构化 payload
defaultConverter = (tool) => {
  const payload = getResultPayload(tool);   // { title, favicon, content, loading }
  return { url: tool.args?.url, title: payload.title, ... };
};
```

**要点**：
1. **一行卡片**（header 只有 icon + action + title），无 body，绝不占屏
2. **result 是结构化 JSON**（getResultPayload 提取 title/favicon/content/loading）——后端必须返回结构化数据
3. 执行中隐藏 icon、显示"生成摘要"；完成显示"网页获取"+ 标题
4. 标题三级语义：真实标题 → 域名 → 兜底

---

## 五、对 SUPERCRZY BOT 的落地映射

| 机制 | 落地建议 |
|---|---|
| 双层包架构 | 我们单组件（ToolCallBlock.vue），可先抽 `renderers/` 目录按工具拆分 |
| compact/full 双形态 | **每个工具卡片 = compact 一行 + full 展开**（WebFetchCard 方案 A 即此） |
| 动词动态推导 | 我们 fileHeaderLabel 已有雏形（"编辑 demo.py"），扩成 isModify 推导 |
| 数字动态计算 | +N/-M 行已有（lineStat），补齐 editIndex 进度 |
| i18n 插值 | tool-summary.ts 平铺表 → 改 {count} 模板插值 |
| 文件名点击定位 | **待做**（onFileClick 对应我们 openAttachment/编辑器跳转） |
| 正文路径检测 | **待做**（markdown 渲染后扫路径模式 → 点击定位）——高性价比亮点 |
| ToolRendererErrorBoundary | 我们单卡片渲染错误会炸整条消息，需补 |
