# 双轨 → 单轨迁移计划（ChatMessage 数据模型重构）

> 背景：三方对比（docs/WORKSPACE_CHAT_ARCH_COMPARE_2026-08-20.md）确认最大结构性差距——
> 我们的 ChatMessage 同时维护 `content`（正文）+ `flow`（过程节点）两份状态；
> WorkBuddy/GPT 都是单一数组（content blocks / turn items），渲染即 map，无同步成本。
> 日期：2026-08-20

---

## 目标态

```ts
interface ChatMessage {
  // 唯一真相：按真实顺序的块数组（对齐 WorkBuddy content blocks / GPT turn items）
  content: ContentBlock[]   // {type:'text'|'thinking'|'tool'|'diagram', ...}
  // ❌ 删除 flow / diagrams / processCollapsed 等平行字段
}
```

- 思考、正文、工具调用、图片都是 `content` 数组元素，顺序即真实顺序
- 渲染 = 遍历数组按 type 分发（我们已经有了 rendererKey 注册表，直接复用）
- 折叠/摘要/图位置 = 数组顺序的自然结果，零同步

## 当前双轨的同步成本（要消灭的）

| 同步逻辑 | 位置 | 作用 |
|---|---|---|
| `serializeWithDiagrams` | stores/chat.ts | 落库前把 diagrams 的 SVG 合并进 content |
| `serializeWithFlow` | stores/chat.ts | 落库前把 flow 序列化进 attachments |
| `parseFlowFromAttachments` | stores/chat.ts | 加载时从 attachments 还原 flow |
| `autoExtractDiagrams` + `flowDiagramSet` | ChatView | 从 content 提取图 + 过滤 flow 已有 |
| `SVG_BLOCK_RE/SVG_BARE_RE` 从正文 remove | MessageFlowRenderer | 渲染时把正文里的 SVG 抠掉 |
| `contentWithoutDiagrams` | MessageFlowRenderer | 无 flow 消息去图渲染 |
| `normalizeContent` 字符串→ContentBlock[] | utils/content-blocks | 双形态 content 归一 |

## 分阶段迁移（每阶段独立可回退）

### 阶段 1：SSE 事件直写 content（数据层归位）
- **不改渲染**：MessageFlowRenderer 仍遍历 flow（渲染层零风险）
- 流式事件改为同时 append content blocks：
  - `text` → push `{type:'text', text}`（按 flush 合并，或用 flow 的 text 节点同步）
  - `tool_call` → push `{type:'tool', tool}`（与 flow tool 节点同对象引用）
  - `diagram` → push `{type:'diagram', svg}`（已有 flow diagram 节点）
  - `thinking` → push `{type:'thinking', ...}`
- **content 成为唯一持久化载体**：落库只存 content（blocks 数组），移除 serializeWithFlow/serializeWithDiagrams/parseFlowFromAttachments
- 历史消息加载：旧数据（string content / attachments.flow）→ 归一化构建 blocks；新数据直接是 blocks
- 验证：流式/历史/折叠/图位置全部行为不变

### 阶段 2：渲染层切换到 content（行为对齐 GPT/WorkBuddy）
- MessageFlowRenderer 改为遍历 `msg.content`（blocks），flow 相关辅助（flowDisplay/visibleFlow/shouldCollapse/lastBodyText/processSummary）改为基于 blocks 派生
- 删除 `ChatMessage.flow` 字段；旧代码引用 flow 处全部切换
- 折叠逻辑：MetaFold 语义 → 对 blocks 分段（thinking/tool 连续块 = 可折叠段）
- 验证：长过程分批展开（F10）、轮次折叠（F3）、图位置（diagram block）全部回归

### 阶段 3：清理双轨产物
- 删除：serializeWithDiagrams/serializeWithFlow/parseFlowFromAttachments/autoExtractDiagrams/flowDiagramSet/contentWithoutDiagrams/SVG_BLOCK_RE 等
- types：ChatMessage 收敛（删 flow/diagrams/processCollapsed 可选字段）
- ChatView 瘦身：SSE case 里 flow.push 逻辑删除，直写 content

## 风险与收益

| | 收益 | 风险 |
|---|---|---|
| 阶段 1 | 持久化单一化，刷新/历史不再丢图丢过程 | 低（渲染未动） |
| 阶段 2 | 渲染与数据同构，图位置/正文顺序天然正确 | 中（折叠/分批逻辑重写，需回归） |
| 阶段 3 | 代码量净减（估 -400~600 行同步代码），ChatView 瘦身 | 低（纯删除） |

## 前置依赖

- ✅ 渲染器注册表（已建，阶段 2 直接复用）
- ✅ diagram 节点（已建，阶段 1 直写）
- ⚠️ 需要先确认：历史数据量（data/*.db 里 messages 的 content/attachments 形态）
