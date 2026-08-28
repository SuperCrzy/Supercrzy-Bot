# SUPERCRZY 消息区重写 · 完整规划表

> 2026-08-20 · 基于 MSG_REWORK_SPEC_2026-08-20.md（F1-F24 功能规格）+ 两次拆包研究
> 目标：一次架构对齐，不再打补丁

---

## 一、总览

| 阶段 | 内容 | 涉及功能 | 预估文件 |
|---|---|---|---|
| **P0 架构重写** | MessageFlowRenderer 组件 + ChatView 替换 + 回归 | F1-F20 全部迁入 | 新建 1 + 改 1 |
| **P1 文件工具可视化** | 读文件/写文件/指南卡片 + 图标注册表对齐 | F21-F24 | 新建 3 + 改 2 |
| **P2 体验细节** | 真实时间 / 头像折叠 / 分批展开 / 多文件编辑 | F3/F4/F10/F24 | 改 2-3 |

---

## 二、P0 · 架构重写（核心，一次到位）

### P0-1 新建 MessageFlowRenderer.vue（组件骨架 + 全部逻辑迁入）

| 子项 | 内容 | 验收标准 |
|---|---|---|
| M1 | 组件 props/事件契约（message/permission/autoApprove/showReasoning + allow/deny/retry） | 类型定义清晰 |
| M2 | 辅助函数迁入：shouldCollapse/isMsgStreaming/lastBodyText/flowDisplay/processSummary/toggleProcess/attachmentList/renderMarkdown | 无 ChatView 残留依赖 |
| M3 | 子组件复用：ThinkingBlock/ThinkingGroup/ToolCallBlock/FileDiffViewer | 原样引用 |
| M4 | utils 复用：tool-summary/tool-meta | 原样引用 |

### P0-2 替换 ChatView 消息区

| 子项 | 内容 | 验收标准 |
|---|---|---|
| M5 | 消息区模板（330-560 行）替换为 `<MessageFlowRenderer>` | 模板瘦身 |
| M6 | 保留 ChatView 自身逻辑：SSE 事件处理、发送、打字机 | 不回归 |
| M7 | 双端 TSC + build | 零错误 |

### P0-3 浏览器回归（全链路实测）

| 子项 | 验收标准 |
|---|---|
| M8 | 历史消息默认折叠 → 折叠条摘要 + 时长 |
| M9 | 点击折叠条展开/收起（实测 1↔8 节点） |
| M10 | 深度思考块标题 + 点击展开 + 代码草稿折叠 |
| M11 | 工具卡片：图标 + 友好名 + "编辑 文件名 +N" + 行号流式 |
| M12 | 交替式正文（工具间说明可见） |
| M13 | 附件 3 形态兼容 / 停止原因横幅 / 错误摘要 |

---

## 三、P1 · 文件工具可视化（拆包实证对齐）

| # | 任务 | 内容 | 文件 | 验收标准 |
|---|---|---|---|---|
| F21 | **读文件卡片可视化** | [眼睛图标] 已读取 {文件名} L{行号范围}；文件名可点击打开；状态词（读取中/已读取/失败） | ToolCallBlock 改造 + tool-meta | 读文件显示行号范围 |
| F22 | **图标注册表对齐** | 补 Folder/Trash/Image 图标 + 完整工具映射（对齐 WorkBuddy 17 种） | tool-meta.ts | 17 类映射正确 |
| F23 | **可视化指南卡片** | read_me 工具专属卡片：文档图标 + 读取可视化指南中.../已读取 + 展开 pre 内容 | 新建 VisualizerReadMeCard.vue | read_me 专属渲染 |
| F24 | **多文件编辑** | MultiEditDiffViewer：{count} 处修改徽标 + 接受/拒绝（需后端 multi_edit） | 新建 + 后端 | 多处修改展示 |

---

## 四、P2 · 体验细节（对齐 WorkBuddy 交互）

| # | 任务 | 内容 | 验收标准 |
|---|---|---|---|
| F3 | **头像折叠** | "已完成 26s" 挂 AI 头像，点击头像 = 切换整轮折叠（TurnFoldAvatar 同款） | 头像可点 |
| F4 | **消息真实时间** | 今天 HH:MM / 昨天 / M月D日；id 内嵌时间戳防污染 | 时间正确 |
| F10 | **分批展开** | 长过程尾部优先，每批 15 项/24K 字符，"显示更早 N 条" | 超长分批 |
| F17 | **CodeDiff 行内高亮** | 改前/改后逐行对比 + 行内高亮（GPT 观感） | diff 高亮 |

---

## 五、明确不做（本期边界）

| 项 | 原因 |
|---|---|
| 虚拟滚动（Virtuoso） | 消息量小，收益低回归风险高（P3 评估） |
| 像素级抄 WorkBuddy 视觉 | 保持原创设计系统 |
| 俏皮提示语 | 已移除，不需要 |
| 宠物联动 | 独立功能，不属消息区 |

---

## 六、执行顺序与依赖

```
P0-1 (M1-M4 组件) → P0-2 (M5-M7 替换) → P0-3 (M8-M13 回归)
        ↓ 稳定后
P1 (F21 → F22 → F23 → F24)
        ↓
P2 (F3 → F4 → F10 → F17)
```

**依赖**：P0 完成才动 P1（P1 都改 ToolCallBlock/tool-meta，避免并行冲突）；P2 无强依赖可随时插。

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 迁移遗漏辅助函数 → 运行时 undefined | P0-3 浏览器全链路实测兜底 |
| ChatView 残留逻辑耦合 | M2 逐函数核对 + grep 确认无残留 |
| flow 数据格式变化 → 历史会话异常 | 附件 3 形态兼容已验（attachmentList） |
| 重写期间体验不稳定 | 完成后一次性切换，不渐进 |

---

## 八、交付物

| 交付物 | 位置 |
|---|---|
| 功能规格书（F1-F24） | docs/MSG_REWORK_SPEC_2026-08-20.md |
| 学习矩阵计划 | docs/MSG_REWORK_PLAN_2026-08-20.md |
| 重写组件 | packages/client/src/components/chat/MessageFlowRenderer.vue |
| 拆包研究文档 | docs/WORKBUDDY_MSG_ARCH_REPLICATION.md |
