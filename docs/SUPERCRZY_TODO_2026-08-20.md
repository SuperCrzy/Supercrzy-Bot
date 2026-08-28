# SUPERCRZY BOT 待办主清单（2026-08-20 整理）

> ⚠️ **已过时（2026-08-23 标注）**：本文 P0 全部完成、P1/P2 大部分完成或状态已变。
> **最新待办清单见 `docs/SUPERCRZY_PROJECT_HANDBOOK_2026-08-21.md` §6（已更新至 8-23）**。
> 保留本文仅作历史记录。

> 来源：消息区重写（F1-F24 已完成）+ 本轮 WorkBuddy 深度拆解落地项 + 项目级挂起事项
> 原则：先修体感问题（占屏/定位），再补智能感（语义联动），最后固化打包

---

## ✅ 已完成（勿重复做）

| 事项 | 说明 |
|---|---|
| 消息区重写 P0/P1/P2 + F24 | MessageFlowRenderer + ThinkingGroup/Block + ToolCallBlock + F3 头像折叠 + F4 真实时间 + F10 分批展开 + F17 行内高亮 + F24 多文件编辑 |
| 头像耗时位置修正 | 耗时从"头像内角标"改为"头像正下方小字"（avatar-wrap） |
| 双端 TSC / build | 全绿 |

---

## 🔴 P0 消息区体验落地（本轮拆解产出，按建议顺序做）

### 1. 正文路径检测（path-detector 移植）★最高性价比
- **做什么**：markdown 渲染后，扫描正文里的代码路径/符号（`src/utils/tool-meta.ts`、`demo.py`、`app.ts:12`）→ 变可点击 → 点击定位打开文件
- **参照**：WorkBuddy `inline-code/path-detector.ts` 5 级模式（SYMBOL / ABSOLUTE_PATH / RELATIVE_PATH / FILENAME / CODE_RANGE）
- **涉及**：MessageFlowRenderer 的 renderMarkdown 管线（markdown-it 后处理或 hljs 后处理）
- **验收**：正文中出现的真实项目路径可点击并打开对应文件

### 2. WebFetchCard 接线（方案 A）+ 后端结构化（方案 B）
- **A（前端）**：WebFetchCard.vue 是死组件（全项目无 import）——接进 ToolCallBlock（`v-if="isWebFetch"`），改成 WorkBuddy WebFetchCompactRenderer 形态：
  - 一行 header：icon + "网页获取/生成摘要" + 域名标题（执行中隐藏 icon、显示"生成摘要"）
  - **执行中不展开正文**（并行 N 张 = N 行，不占屏）
  - 展开态：Title / URL / Published Time 元信息 + 内容限高 240px 滚动 + 2000 字符截断
- **B（后端）**：web_fetch result 从 `"网页内容 (前6000字符):..."` 原始 dump 改为结构化 JSON `{title, url, publishedTime, content, truncated}`（前端解构展示，LLM 消化也更好）
- **参照**：WORKBUDDY_SEMANTIC_LINKAGE_2026-08-20.md 第四节 WebFetchCompactRenderer 全文
- **验收**：让 AI 研究一个网站，多张网页卡片全部一行显示、不占屏

### 3. read_file 文件定位联动
- **做什么**：read_file 卡片文件名变成可点击链接，点击 → 打开文件 + 定位行号（WorkBuddy `onFileClick(filePath, startLine, endLine)` 同款）
- **涉及**：ToolCallBlock（isReadFile 分支已有 fileName/readLineRange）→ 复用 openAttachment/文件打开能力
- **验收**：点击"已读取 demo.py L12-30"打开文件并跳转行号

### 4. 语义联动补全（动词推导 + i18n 命名空间）
- **动词动态推导**：fileHeaderLabel 扩展为 isModify 推导（有旧内容=修改中/已编辑，无=生成中/已创建），不是工具名写死
- **i18n 命名空间化**：tool-summary.ts 28 工具平铺表 → `tool.<工具>.<状态>` 结构 + `{count}` 插值（`{count} 处修改`、`修改 {index}/{total}`）
- **验收**：同一编辑工具对新建/已有文件显示不同动词

### 5. ToolRendererErrorBoundary
- **做什么**：单卡片渲染错误不炸整条消息（错误边界包住每个 tool block）
- **验收**：构造一个坏 result 的卡片，其余消息正常

### 6. 状态机补齐（10 态）
- **做什么**：ToolState 补 `parsing`（参数解析中）/ `cancelled` / `destroyed`；stream_executing 与 full_executing 语义分离
- **验收**：取消一轮任务时工具卡片显示 cancelled 态

### 7. tool block 存 createTime
- **做什么**：flow 工具节点记录真实执行时刻，历史重放时用 tool createTime 订正"已完成 XX"耗时（WorkBuddy correctAssistantCreateTimeFromTools 同款，替代/补充 id 内嵌时间戳）

---

## 🟡 P1 项目级挂起

### 8. 打包 1.0.2 固化成果
- **背景**：消息区重写大量改动还在本地，main 分支 112 处改动未提交，远端 stale
- **做什么**：git 提交 + 版本 1.0.2 + （可选）Electron 打包验证
- **注意**：PWA/HTTP 缓存——改完需强刷验证

### 9. 宠物（思考联动 + 设置开关）
- **背景**：CSS 占位功能全空；思考状态用宠物形象替代 WorkBuddy 风格文案，设置带 on/off 开关

### 10. 幽灵工作台 DetailPanel ghost tab
- **背景**：多 Agent 并行（幽灵模式）detail 面板 ghost tab 已占位，Socket.IO 从未实现，用 ws 新增 /ws/ghost 端点（阶段 A）

### 11. 更新进度条 UI / Git 深度集成 / PNG 导出 / App 签名 / 新闻生态接入
- 均为远期候选，逐个评估优先级

---

## 🟢 P2 远期

| 事项 | 备注 |
|---|---|
| 开源准备 | 仓库名 supercrzy-bot（SuperCrzy/deepseek-agent 是死 remote）；MIT + 双语 README + .gitignore 已就绪；开源前先本地打磨 |
| 新闻生态接入 | supercrzy.com 内容源 → news_search 工具 / 每日简报（复用 automations）/ 热点追踪；技术路线待确认（API/RSS/抓取） |
| App 签名/证书 | 有用户后再做（mac 签名 / Win CodeSign），当前未签名只到下载装不上 |

---

## 执行顺序建议

```
P0-1 正文路径检测 → P0-2 WebFetchCard A+B → P0-3 文件定位
→ P0-4/5/6/7 语义联动补全（一次迭代做完）
→ P1-8 打包 1.0.2 → P1-9 宠物 → P1-10 幽灵工作台
```
