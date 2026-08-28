# SUPERCRZY 消息区重写计划（对齐 WorkBuddy / GPT + 差异化提升）

> 2026-08-20 定稿 · 基于两轮拆包研究（WorkBuddy 658M / ChatGPT 221M）+ 7 项已实现功能核验

---

## 一、已实现（本次重写必须保留的 7 项，全部核验在位）

| # | 功能 | 位置 | 状态 |
|---|---|---|---|
| 1 | 执行过程折叠（点击展开/收起） | ChatView.vue shouldCollapse | ✅ 浏览器实测 |
| 2 | 折叠条摘要合成（"运行命令 npm run build"） | utils/tool-summary.ts | ✅ |
| 3 | 轮次时长（"已完成 5m17s"） | formatDurationMs | ✅ |
| 4 | 深度思考块（标题+展开+代码草稿折叠） | ThinkingBlock/ThinkingGroup | ✅ |
| 5 | 交替式回复（工具轮中间正文不丢弃） | agent.ts content_chunk | ✅ |
| 6 | 写代码流式（行号代码视图 +N 数字滚动+等待模型响应） | ToolCallBlock streamCodeLines | ✅ |
| 7 | 写文件卡片 "编辑 文件名 +N" | ToolCallBlock fileHeaderLabel | ✅ |
| 8 | 全局执行状态条（输入框上方） | ChatView aiStatus | ✅ |
| 9 | 文件 diff（行级 LCS） | FileDiffViewer.vue | ✅ |
| 10 | 停止原因横幅（轮次上限/检查点） | stop-reason-banner | ✅ |
| 11 | 附件兼容（3 形态） | attachmentList | ✅ |

---

## 二、从 WorkBuddy 学（重写时对齐的结构）

### 架构层（本次重写核心目标）
- **块渲染架构**：conversation-render（list-like-render + block-render）——消息 = 轮次分组 → 帧转换 → 块树。**这就是重写 MessageFlowRenderer 的依据**
- **轮次分组**：user 消息 + 后续 assistant 过程为 1 组（Virtuoso 虚拟滚动，一虚拟 item 一组）
- **折叠决策引擎**：hasEnd + 非流式 + 有正文 + 内容>1 → 折叠；交互工具（ask_user）不折叠
- **分批展开**：长过程尾部优先，每批 15 项/24K 字符预算，"显示更早 N 条"

### 交互层（我们缺的细节）
- **TurnFoldAvatar**："已完成 5m17s" 挂轮次头像上，点击头像=切换整轮折叠（我们目前只在折叠条）
- **工具状态三元组词条**：执行中/已读取/运行成功 + 生成中三点
- **消息真实时间**：id 内嵌 13 位时间戳取小值防污染；今天 HH:MM/昨天/M月D日
- **检查点/继续卡片**：模型切换分隔线、用户取消指示、continue-card

---

## 三、从 GPT 学

- **CodeDiff 完整视图**：改前/改后逐行对比 + 高亮（我们有 FileDiffViewer 雏形，可补行内高亮）
- **todoPlan 步骤进度**："Step N / M" 胶囊（我们有 plan capsule，可加进度百分比）
- **写代码实时行数**：已实现（+N 滚动）
- **artifact 预览**：写文件后可直接在侧栏预览（我们有 onPreview 链路，可强化）

---

## 四、我们可超越 WorkBuddy/GPT 的点（差异化）

| 差异化 | 我们 | WorkBuddy | GPT |
|---|---|---|---|
| 历史过程持久化 | ✅ flow 落库刷新可回看 | ❌ 刷新丢失 | ❌ 刷新丢失 |
| 8 态工具状态机 | ✅ 更细 | 4-5 态 | 3 态 |
| 安全标签（risk/perm/blocked） | ✅ | 无 | 无 |
| 深度思考流式推理 | ✅ 实时可见 | 完成才展开 | 完全不显示 |
| 幽灵工作台（多 Agent 并行） | ✅ | ❌ | ❌ |
| 宠物（思考陪伴） | ⏳ 待做 | ❌ | ❌ |
| 多模型对比 | ✅ | ❌ | ❌ |
| 技能包生态 | ✅ | ✅ | ❌ |

---

## 五、重写范围（MessageFlowRenderer.vue）

```
MessageFlowRenderer（新组件，按 WorkBuddy conversation-render 结构）
├─ 轮次分组（user 消息 + 后续 assistant 过程）
├─ 折叠条（摘要 + 已完成 XmXs + 点击展开/收起）
├─ 折叠态 → 只渲染最后一段正文（lastBodyText）
└─ 展开态 → 块渲染
   ├─ 深度思考块（标题 + 展开 + 代码草稿折叠）
   ├─ 交替正文（工具轮中间说明）
   ├─ 工具卡片（图标 + 友好名 + "编辑 文件名 +N" + 流式代码）
   └─ 文件 diff / 错误摘要 / 停止原因横幅
```

**迁移策略**：辅助函数（shouldCollapse/isMsgStreaming/lastBodyText/flowDisplay/processSummary/toggleProcess/attachmentList/renderMarkdown）从 ChatView 迁入组件；子组件（ThinkingBlock/ThinkingGroup/ToolCallBlock/FileDiffViewer）原样复用；ChatView 只留 SSE 事件处理和消息列表。

---

## 六、实施顺序（P0 → P2）

| 阶段 | 内容 | 价值 |
|---|---|---|
| **P0** | MessageFlowRenderer 组件实现（块架构 + 折叠 + 全部现有功能迁入） | 一劳永逸 |
| **P0** | ChatView 替换 + 回归（浏览器实测全链路） | 稳定 |
| **P1** | TurnFoldAvatar（时长挂头像+点击折叠） | 对齐 WorkBuddy 交互 |
| **P1** | 分批展开（15 项/24K 预算） | 长任务体验 |
| **P1** | CodeDiff 行内高亮 | GPT 观感 |
| **P2** | 消息真实时间 / 检查点继续卡片 / 工具状态词条补全 | 细节完整 |
| **P2** | 宠物（思考陪伴） | 差异化 |
