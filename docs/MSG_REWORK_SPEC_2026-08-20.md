# SUPERCRZY 消息区重写 · 完整功能规格书（V1.0）

> 2026-08-20 · 重写 MessageFlowRenderer.vue 前定稿 · 逐项确认后开工

---

## 零、重写目标（一句话）

把散落在 ChatView.vue（4955 行）里的消息渲染逻辑，收拢成一个独立的 `MessageFlowRenderer.vue` 组件，按 WorkBuddy 的块架构（轮次分组 → 折叠条 → 块渲染）实现，**保留全部现有功能 + 对齐 WorkBuddy/GPT 的体验细节**。

---

## 一、功能总清单（F1-F20，逐项验收）

### A. 轮次与消息层

| # | 功能 | 现状 | 重写后目标 | 验收标准 |
|---|---|---|---|---|
| F1 | **轮次分组** | 无（每条消息独立） | user 消息 + 后续 AI 过程为 1 组 | 一条 user 消息 + 其 AI 回复视觉上成组 |
| F2 | **AI 头像 + 时长徽标** | 无 | 轮次头像显示"已完成 26s"（TurnFoldAvatar 同款） | 完成态头像旁显示时长 |
| F3 | **点击头像切换折叠** | 仅折叠条可点 | 头像 + 折叠条都可点击切换 | 点头像=展开/收起整轮 |
| F4 | **消息真实时间** | 无 | 今天 HH:MM / 昨天 / M月D日 | 时间正确显示 |
| F5 | **消息操作工具栏** | ✅ 已有（复制/编辑/重发） | 原样保留 | 不回归 |

### B. 折叠与摘要层

| # | 功能 | 现状 | 重写后目标 | 验收标准 |
|---|---|---|---|---|
| F6 | **折叠决策引擎** | ✅ shouldCollapse（6 态验证过） | 保留 + 补充：ask_user 交互工具不折叠 | 提问工具不折叠 |
| F7 | **折叠条摘要合成** | ✅ tool-summary.ts（28 工具） | 保留，支持多段"运行命令、修改：topic" | 摘要符合动词+宾语 |
| F8 | **折叠条轮次时长** | ✅ "已完成 5m17s" | 保留（挂在折叠条 + 头像两处） | 双位置显示 |
| F9 | **折叠态只显示最后正文** | ✅ lastBodyText | 保留 | 折叠后只有最终报告 |
| F10 | **分批展开** | ❌ 无 | 长过程尾部优先，每批 15 项/24K 字符，"显示更早 N 条" | 超长过程分批加载 |

### C. 块渲染层（WorkBuddy 核心结构）

| # | 功能 | 现状 | 重写后目标 | 验收标准 |
|---|---|---|---|---|
| F11 | **深度思考块** | ✅ ThinkingBlock/Group | 保留（标题+展开+代码草稿折叠） | 点击展开推理，代码折叠为占位 |
| F12 | **交替式正文** | ✅ 工具轮中间正文保留 | 保留 | 正文在工具前后平铺 |
| F13 | **工具卡片** | ✅ ToolCallBlock | 保留（图标+友好名+8 态） | 全工具渲染正确 |
| F14 | **写文件卡片 = "编辑 文件名 +N"** | ✅ fileHeaderLabel | 保留（GPT 同款） | header 显示文件名+行数 |
| F15 | **行号代码流式视图** | ✅ streamCodeLines | 保留（自动吸底+数字滚动） | 执行中代码逐块长出来 |
| F16 | **文件 diff** | ✅ FileDiffViewer（LCS） | 保留 | 新增绿/删除红 |
| F17 | **工具图标注册表** | ✅ tool-meta.ts | 保留 | 13 类图标映射正确 |

### D. 状态与反馈层

| # | 功能 | 现状 | 重写后目标 | 验收标准 |
|---|---|---|---|---|
| F18 | **全局执行状态条** | ✅ aiStatus（输入框上方） | 保留（含"等待模型响应"） | 阶段切换正确 |
| F19 | **停止原因横幅** | ✅ stop-reason-banner | 保留 | 轮次超限显示原因+检查点 |
| F20 | **错误摘要** | ✅ 卡片 header 红徽标 | 保留 | 失败原因 header 可见 |

### E. 其它现有功能（重写不得回归）

| 功能 | 说明 |
|---|---|
| 打字指示器（思考中三点） | 保留 |
| 角色分发/技能匹配/经验应用行 | 保留 |
| Planner 计划卡片 | 保留 |
| 多模型对比（live/完成） | 保留 |
| 重试提示 | 保留 |
| 交付摘要（产物卡片） | 保留 |
| SVG 图卡片（提取/预览/下载） | 保留 |
| 附件展示（3 形态兼容） | 保留 |
| Routine 推荐卡片 | 保留 |

---

## 二、明确不做（本期边界）

| 项 | 原因 |
|---|---|
| 虚拟滚动（Virtuoso） | 消息量小，虚拟滚动收益低、回归风险高（后续 P2 评估） |
| 像素级抄 WorkBuddy 视觉 | 保持我们原创设计系统 |
| 俏皮提示语 | 上一轮已移除（用户不需要） |
| 宠物联动 | 独立功能，不属消息区重写范围 |

---

## 三、重写文件清单

| 文件 | 动作 |
|---|---|
| `components/chat/MessageFlowRenderer.vue` | **新建**（核心：轮次分组+折叠条+块渲染） |
| `views/ChatView.vue` | 消息区模板替换为组件；迁出辅助函数（shouldCollapse/isMsgStreaming/lastBodyText/flowDisplay/processSummary/toggleProcess/attachmentList/renderMarkdown 等） |
| `components/chat/ThinkingBlock.vue` / `ThinkingGroup.vue` | 原样复用 |
| `components/chat/ToolCallBlock.vue` / `FileDiffViewer.vue` | 原样复用 |
| `utils/tool-summary.ts` / `tool-meta.ts` | 原样复用 |

---

## 四、实施顺序

1. **P0-1**：新建 MessageFlowRenderer（F1-F20 全部迁入 + F2/F3/F4 新增）
2. **P0-2**：ChatView 替换 + 双端 TSC + build
3. **P0-3**：浏览器实测回归（历史折叠/点击展开/深度思考/工具卡片/行数滚动/附件/停止横幅）
4. **P1**：F10 分批展开 + F3 头像折叠细节打磨
5. **P2**：F4 真实时间 + 虚拟滚动评估

---

## 五、确认事项（请老板逐项拍板）

- [ ] F1-F20 功能清单是否完整？有无增删？
- [ ] F2/F3（时长挂头像 + 点击头像折叠）是否本期做？
- [ ] F4（消息真实时间）是否本期做？
- [ ] 二期边界（虚拟滚动/俏皮语）是否认可？
- [ ] 确认后按 P0-1 → P0-2 → P0-3 开工

---

## 六、文件工具可视化规范（补充章节——拆包实证 2026-08-20）

> 老板要求深入了解 WorkBuddy 的"读取可视化指南"和小 icon。以下全部来自二次拆包（658M）实证。

### 6.1 读文件卡片（ReadFileCompactRenderer）——"读取可视化"

**设计规范（源码注释原文）**：`单行展示：[眼睛图标] Read [文件名] [行号范围]`

```
[👁 ViewedIcon] 已读取 demo.py  L12-30
                ↑状态词   ↑文件名(悬停全路径)  ↑行号范围
```

| 元素 | 实现 |
|---|---|
| 图标 | ViewedIcon（眼睛，16x16 描边：眼眶+瞳孔，SVG path 已提取） |
| 状态词 | 读取中（running）/ 已读取（done）/ 读取失败（failed） |
| 文件名 | `filePath.split('/').pop()`，title=全路径，**可点击打开文件** |
| 行号范围 | `L{startLine}-{endLine}`（如 L12-30），图片不显示 |

### 6.2 写文件卡片（WriteFileCompactRenderer）—— 我们已对齐 90%

**设计规范（源码注释原文）**：`收起状态：一行内联 [编辑图标] [操作名] [文件名] [+N -N] [展开箭头]；展开状态：收起行 + 下方灰色背景 diff 内容区`

| 元素 | WorkBuddy | 我们 |
|---|---|---|
| 操作名 | 生成中/已创建、修改中/已编辑、失败 | ✅ "编辑 {文件名}" |
| 行数徽标 | +N -M（addedLines/removedLines 分离） | ✅ +N（-M 待补） |
| 展开时机 | **执行中有 diff 自动展开**，完成手动展开 | ⚠️ 执行中展开（流式区），完成折叠 |
| diff 统计 | computeLineDiffStats（LCS fallback） | ✅ FileDiffViewer LCS |
| 多处修改 | MultiEditDiffViewer + "{count} 处修改" 徽标 | ❌ 待做 |
| 省略行 | "… 省略 {count} 行" | ✅ |
| 接受/拒绝 | accept/reject 按钮 | ❌ 待做 |

### 6.3 可视化指南卡片（VisualizerReadMeRenderer）——用户说的"读取可视化指南"

`visualize:read_me` / `read_me` 工具的专属渲染（对应我们 WorkBuddy 的 read_me 模块）：

```
[DocIcon 文档图标] 读取可视化指南中... [箭头]
[已读取可视化指南]
展开 → pre 显示指南内容
```

| 元素 | 实现 |
|---|---|
| 图标 | DocIcon（文档+放大镜组合，SVG path 已提取） |
| 标题 | tool.visualizerReadMe.title |
| 状态 | 读取可视化指南中...（cb-shining-text 闪烁）/ 已读取可视化指南 |
| 交互 | 完成可点击展开，内容 pre 展示 |

### 6.4 图标体系（tool-icon-registry）——17 种图标完整映射

**匹配算法**：normalizeName（小写去下划线）→ exactMatchMap 精确 → prefixEntries 前缀（按长度降序）→ FALLBACK

| 图标 | 工具（精确映射节选） |
|---|---|
| EyeIcon 眼睛 | Read/read_file/read_lints/preview_url/present_files/ListMcpResources |
| PencilIcon 铅笔 | Write/Edit/write_to_file/replace_in_file/edit_file/SaveMemory |
| TerminalIcon 终端 | Bash/execute_command/run_command/InstallBinary |
| SearchIcon 放大镜 | Glob/Grep/search_files/ToolSearch/LSP |
| FolderIcon 文件夹 | list_files/list_dir/FileUpload |
| GlobeIcon 地球 | WebFetch/WebSearch/web_fetch |
| TrashIcon 垃圾桶 | DeleteFiles/delete_files |
| WrenchIcon 扳手 | **FALLBACK 兜底** |
| 其它 | Check/Clipboard/Cloud/Database/Debug/Grid/Image/Send/Sparkle |

**我们的差距**：tool-meta.ts 有 13 类，但缺 Folder/Trash/Image 等；图标是内联 SVG 非注册表组件。

### 6.5 状态词条（zh-CN 实证）

```
readFile: 读取中/已读取/读取失败
writeFile: 生成中/已创建、修改中/已编辑、{count} 处修改、…省略{count}行、接受/拒绝
visualizerReadMe: 读取可视化指南中.../已读取可视化指南
```

### 6.6 重写落地（新增 F21-F23）

| # | 功能 | 内容 |
|---|---|---|
| F21 | 读文件卡片可视化 | [眼睛图标] 已读取 {文件名} L{行号范围}，文件名可点击打开 |
| F22 | 图标注册表对齐 | 补 Folder/Trash/Image 等图标 + 完整工具映射（对齐 WorkBuddy 17 种） |
| F23 | 可视化指南卡片 | read_me 工具专属卡片（文档图标+状态词+展开内容） |

### 6.7 多文件编辑（F24，P1）

MultiEditDiffViewer（多处修改 {count} 处修改 徽标 + 接受/拒绝）—— 需要后端 multi_edit 工具配合，放 P1。
