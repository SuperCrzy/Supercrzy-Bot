# SUPERCRZY BOT 项目手册

> 版本：2026-08-23 · 维护人：老板 + Crzy（AI 搭档）
> 用途：项目全貌速查 —— 沟通核心 / 架构规划 / 文件位置 / 进行中事项 / 未处理事项
> 维护建议：每次完成一轮实质工作后，把新进展追加到 `.workbuddy/memory/YYYY-MM-DD.md`，并在此手册"近期进展"节更新

---

## 1. 项目总览

| 项 | 内容 |
|---|---|
| **产品名** | SUPERCRZY BOT（2026-08-12 老板定名；背景：当天马斯克发布 Grok Bot） |
| **一句话定位** | 开箱即用的 AI Agent 平台：统一大脑 + Agent Loop + 多工具 + 多平台网关，原生对接 DeepSeek V4 |
| **差异化** | 自带 supercrzy.com 新闻生态内容源（"自带内容源的 Agent"，对标 Grok 实时搜索路线） |
| **形态** | Web（PWA 可安装）+ Electron 桌面 App 双形态（老板 2026-08-15 定：很多人更喜欢 App） |
| **商业化节奏** | 先开源 → 有用户后再做签名/证书/手机版（老板 2026-08-16 定） |
| **部署形态** | 自部署（本地打磨）→ 未来云服务；邮箱登录推迟到云服务上线时（单用户 self-hosted 无登录意义，架构预留不建用户表） |
| **技术栈** | pnpm monorepo · Vue3 + Pinia + NaiveUI + Vite（client）· Koa3 + better-sqlite3（server）· Electron（desktop） |
| **当前版本** | git HEAD `8fbb170` "版本更新功能完善 + 版本号统一 V0.3.0"；**167 个文件未提交**（8-20~8-23 全部大改，老板定"固化放最后"） |
| **测试** | server vitest 37 项 + client 9 项 |
| **搜索架构** | 自建 SearXNG 元搜索（美国 VPS 107.174.107.199:8080，8-23 部署，聚合 70+ 引擎）为主引擎；Tavily/Serper 有 key 优先 |
| **记忆检索** | SQLite FTS5（trigram）+ BM25 + 加权排名（8-23 落地，替代原 LIKE 全表扫描） |

---

## 2. 沟通核心（老板 ↔ Crzy 协作规范）

### 2.1 工作方式

- **CLI 优先**，中文技术讨论，双语（中英）环境，结构化输出（含表格）
- 习惯斜杠命令（`@skill` / `@scene`）及"继续"恢复任务
- **先研究再动手**：实施计划前必须经过老板审批，不自动推进
- **快速事实纠正**：老板纠正后即时更新已交付部分，不重做整任务
- **深度验证后才声明修复成功**：反对过早下结论；关键修复用浏览器实测（agent-browser）或离线验证背书
- **分析现有作品而非凭空创作**；事实准确性要求高，禁止编造不存在的产品缺口/品牌信息

### 2.2 表达规范（老板强约束）

- **禁止"低预算/没资源/零成本"道歉体**——约束条件不是卖点，亮点只讲资产力 + 打法巧
- 拒绝汇报式/framing 语言，聚焦 actionable 动作
- 界面 UI **禁止 emoji 图标**、坚持原创设计（不照抄竞品 UI 范式）
- 总结页待确认项要实在具体，便于老板决策

### 2.3 关键决策记录（老板拍板）

| 日期 | 决策 | 影响 |
|---|---|---|
| 08-12 | 产品定名 SUPERCRZY BOT；品牌视觉统一（橙黄渐变 logo） | 界面/PWA/manifest 统一；localStorage 键保持 `supercrzy:` 前缀兼容 |
| 08-15 | 技术路线：能用成熟开源就不自研，自研只用于差异化核心 | 复用 computer-use-mcp、Agent Skills 开放标准（agentskills.io，三级渐进披露） |
| 08-15 | 产品双形态：Web + Electron 桌面 App | packages/desktop；启动须 `env -u ELECTRON_RUN_AS_NODE` |
| 08-16 | 商业化：先开源，有用户后再签名/证书/手机版 | 暂缓 Apple 开发者账号、Windows 签名、Capacitor 套壳 |
| 08-16 | 部署：自部署 + 未来云服务；邮箱登录推迟 | 本地阶段用数据一键导出/导入迁移 |
| 08-16 | 4 个创新方向全选：对话分享导出 / 技能包一键导入 / 多模型对比 / 幽灵模式 | ghost tab 已占位；对话分享、技能包待做 |
| 08-18 | 接入 supercrzy.com 新闻生态（独家内容源） | 差异化定位：自带内容源的 Agent；路线待确认（API/RSS/抓取） |
| 08-20 | **固化打包放最后**——"需要目前做的稳定成型了，要不然一直修改，打包没意义" | 先结构优化成型，最后才提交/打包/开源 |
| 08-23 | **搜索自建落地**：SearXNG 部署到美国 VPS 作主引擎（固定成本，摆脱免费源质量依赖） | 搜索链：Tavily(key) → Serper(key) → SearXNG(自建) → Bing RSS → DDG |
| 08-23 | **记忆检索升级**：SQLite FTS5(trigram)+BM25+加权排名替代 LIKE 全表扫描（追平 WorkBuddy BM25 机制） | agent_memory 加 confidence/usage_count/last_used 三列 + FTS5 虚拟表 |
| 08-23 | **🔴 VPS 防火墙禁忌**：绝对禁止 `ufw reset`（曾误删 80/443 致 supercrzy.com/cms 断流 12.5h）；动 ufw 前强制备份 | ufw 安全函数已装 VPS ~/.bashrc；root 密码老板明确不改 |

---

## 3. 架构规划

### 3.1 Monorepo 全景

```
supercrzy-agent/
├── packages/
│   ├── client/            # Vue3 + Pinia + NaiveUI 前端（Vite dev 5173 / build → client/dist）
│   ├── server/            # Koa3 + better-sqlite3 后端（3000，生产静态托管 client/dist）
│   └── desktop/           # Electron 桌面端（主进程加载 client/dist + 内嵌 spawn 后端 + 深链 supercrzy://）
├── docs/                  # 规划/拆解/对比文档（见 §4.2）
├── scripts/               # install.command / make-app.sh / serve-releases.sh
├── data/                  # 数据与剧本文件（sqlite db 在 packages/server/data/）
├── start.sh / start.bat   # 一键启动（生产模式）
├── SUPERCRZY BOT.app      # macOS 桌面图标入口（需与 start.sh 同级）
└── .workbuddy/memory/     # 记忆系统（见 §4.4）
```

### 3.2 前端（client）

- **视图层** `src/views/`：ChatView（聊天主界面）、WorkspaceView（工作台）、ModelsView、SkillsView、MemoryView、GatewayView、AutomationsView、RoutinesView、UsageView、SettingsView、SearchView、TasksView、GhostWorkbenchView、LogsView
- **状态层** `src/stores/`：`chat.ts`（会话/持久化）、`chat-stream.ts`（SSE 流处理 + 打字机引擎，可多实例）、`app.ts`（全局/预览面板）、`plan.ts`（任务胶囊进度）
- **消息区渲染架构**（8-20 重构后）：
  - `MessageFlowRenderer.vue` —— 消息时序流主渲染（thinking/tool/text/diagram 节点按序 + 折叠态）
  - `components/chat/renderers/` —— **渲染器注册表** `tool-renderer-registry.ts`（8 分支：command/lint/read-me/web-fetch/multi-edit/read-file/write-file/generic，EXACT→PREFIX→函数→generic）+ CommandRenderer / LintRenderer / FileOpRenderer
  - `ToolCallBlock.vue` —— header 外壳 + 授权 + 状态徽标 + 按 rendererKey 分发
  - 专属卡片：WebFetchCard（一行卡片）/ VisualizerReadMeCard / MultiEditDiffViewer / FileDiffViewer / ToolErrorBoundary（错误边界）/ ThinkingGroup+ThinkingBlock / PlanCapsule / CompareResult / GhostPanel
- **打字机引擎** `src/utils/typewriter.ts`：WorkBuddy streaming-text 同款（40ms 帧 / 1-4 字符 ≈ 25-100 字符/秒，非对称 EMA 平滑，emoji 代理对保护）；流结束"加速收尾"（24ms/16 字符，防瞬间全出）
- **文件预览** `src/utils/file-preview.ts` → 后端 `/api/filesystem/read` → appStore preview 面板

### 3.3 后端（server）

- **入口** `src/app.ts`；**Agent Loop** `services/agent.ts`（动态 maxTurns 10-100，checkpoint 续跑，playbook 自动复盘）
- **工具** `services/tools.ts`（toolExecutors + toolDefinitions：file/shell/web/memory/skill/draw_diagram/create_plan/ask_question/git…；web_fetch 结构化、draw_diagram 流式 chunk）
- **web_search 六层降级链**（8-22/8-23 改造）：①Tavily(key, 免费1000/月, AI 摘要) → ②Serper(key, Google 原生, 免费2500/月) → ③**SearXNG(searxngUrl, 自建 VPS 主引擎, 聚合 70+)** → ④**DeepSeek 官方原生搜索**(web_search_20250305 服务器工具, 2026-08-23 接入, 复用 DEEPSEEK key 零配置, 服务端执行, 每次≈1-2分钱, 无摘要仅标题+URL) → ⑤Bing RSS（redirect follow + `<item>` 校验）→ ⑥DDG lite；带 `timeRange` 参数（day/week/month/year）+ `postProcessSearchResults`（同域名≤2/标题去重/日期排序/时效过滤保底）
- **web_fetch 四层降级**（8-22 改造）：①Jina 官方(key) → ②Jina 免费 → ③原生 fetch → ④Chrome headless（webFetchChromeFallback，SPA/反爬可用）
- **记忆检索**（8-23 P0.1 落地）：`services/memory-search.ts` —— FTS5 trigram + BM25 + 加权排名（`(0.3+importance/10)×confidence×0.95^天数×类别权重`，experience×1.5/user×1.3/knowledge×1.0/general×0.8）；**混合召回**（≥3 字符走 FTS + 2 字中文词 LIKE 补充，trigram 无法匹配 2 字词）；命中更新 usage_count/last_used；agent.ts 三处注入升级（Stored/Related/recall）
- **路由** `routes/`：chat / session / settings / filesystem / skills / memory / models / gateway / ghost / tasks / automations / routines / checkpoints / history / upload / ocr / mcp / stats / workspace / system / roles / playbook
- **服务** `services/`：sandbox（三层防御：L1 黑名单 → L2 软沙箱 → L3 sandbox-exec）、terminal、tunnel、scheduler、ghost-engine/ghost-ws（幽灵工作台）、qqbot / wechat-bot-runner（网关）、context-compressor、tool-guardrails、skill-loader/skill-evolve、mcp-manager、playbook-match、error-classifier
- **通信**：聊天主通道 SSE（`POST /api/chat/agent`）；终端 WebSocket（`/ws/terminal`）；幽灵工作台 ws（`/ws/ghost`）；Socket.IO 从未实现（勿混淆）

### 3.4 桌面端（desktop）

- main.cjs（主进程）+ preload.cjs + tray.cjs；electron-builder 打包；electron-updater 自动更新（启动 6s 静默检测 → 弹窗确认 → 重启安装，publish 源 `${env.UPDATE_URL}`）
- 本地测试：`scripts/serve-releases.sh` + dev-app-update.yml（http://localhost:8080）
- mac 自动更新依赖签名（未签名只到下载、装不上）

### 3.5 数据模型（核心现状与规划）

- **当前：双轨** —— 一条 assistant 消息同时有 `content`（最终正文，chunk 到达即写，完整）+ `flow`（过程节点数组：thinking/tool/text/diagram 按序，打字机逐步渲染）。持久化：content 落库 + flow 序列化进 attachments
- **已知代价**：content 与 flow 需要同步（合并/提取/去重/位置同步），近期多个 bug（图被推走、正文劈开、刷新截断、SVG 乱码）都是双轨的并发症
- **单轨化计划**（docs/SINGLE_TRACK_MIGRATION_PLAN_2026-08-20.md，未执行）：
  - 阶段 1：SSE 直写 content blocks（渲染不动，content 成为唯一持久化，删 serializeWithFlow/Diagrams/parseFlowFromAttachments）
  - 阶段 2：渲染层切 content（MessageFlowRenderer 遍历 blocks，删 ChatMessage.flow）
  - 阶段 3：清理双轨产物（估净减 400-600 行）
  - 前置已就绪：渲染器注册表 ✅、diagram 节点 ✅

### 3.6 架构差距对标结论（8-20 三方对比，docs/WORKSPACE_CHAT_ARCH_COMPARE_2026-08-20.md）

| 差距 | 状态 |
|---|---|
| 双轨数据模型（content + flow）vs WorkBuddy/GPT 单轨 blocks | ⏳ 单轨化计划已出，待排期 |
| ChatView 巨型组件（4869 行，28 SSE case） | 🟡 已抽 chat-stream.ts（打字机层 -150 行），SSE case 未全抽 |
| ToolCallBlock 24 处 isXxx 分支 | ✅ 已注册表化 + 拆 renderers/（1231→1141 行） |
| 9-10 个死组件 | ✅ 已删（ExecuteCmdCard/ReadFileCard/WriteFileCard/ListFileCard/WebSearchCard/ReasoningBox/ProcessFold/QuestionCard/TaskPanel/TaskItem；PlanCapsule 实际在用保留） |
| 状态词平铺 vs tool.<name>.<status> 命名空间 | 🟡 部分（动词推导 + editProgress 已做） |
| 无渲染器注册表 | ✅ tool-renderer-registry.ts |

---

## 4. 文件位置索引（关键文件地图）

### 4.1 根目录

| 文件 | 说明 |
|---|---|
| `start.sh` / `start.bat` | 一键启动（生产模式 3000） |
| `SUPERCRZY BOT.app` / `SUPERCRZY BOT.command` | macOS 桌面入口 |
| `README.md` / `README.zh-CN.md` | 双语 README（开源就绪） |
| `CHANGELOG.md` | 变更日志 |
| `pnpm-workspace.yaml` | monorepo 根（沙箱白名单上溯锚点） |
| `SUPERCRZY_DEVELOPMENT_STATUS.md` | ⚠️ 2026-05-08 旧文档，**已过时**（ReasoningBox/ProcessFold/WriteFileCard 等组件已删） |

### 4.2 docs/（规划与拆解）

| 文档 | 内容 |
|---|---|
| `SUPERCRZY_TODO_2026-08-20.md` | 待办主清单（✅P0 全完成 → 🟡P1 → 🟢P2） |
| `SINGLE_TRACK_MIGRATION_PLAN_2026-08-20.md` | 双轨单轨化三阶段计划 |
| `WORKSPACE_CHAT_ARCH_COMPARE_2026-08-20.md` | WorkBuddy vs GPT vs 我们的对话架构对比 |
| `WORKBUDDY_DEEP_DIVE_INTERLEAVED_2026-08-20.md` | WorkBuddy 交替式架构源码级拆解 |
| `WORKBUDDY_SEMANTIC_LINKAGE_2026-08-20.md` | 语义联动 8 大模式 + WebFetchCompactRenderer |
| `MSG_REWORK_SPEC_2026-08-20.md` | 消息区重写规格书 V1.0（F1-F24） |
| `MSG_REWORK_PLAN_2026-08-20.md` / `MSG_REWORK_ROADMAP_2026-08-20.md` | 重写计划与路线图 |
| `supercrzy-relationship-2026-08-20.md` | supercrzy.com × SUPERCRZY BOT 生态关联研究 |
| `TECH_COMPARISON_WORKBUDDY_2026-08-22.md` | WorkBuddy 底层技术对比（搜索/记忆/沙箱/agent 编排）与增强路线 |
| `TECH_COMPARISON_HERMES_WORKBUDDY_2026-08-22.md` | Hermes × WorkBuddy × 我们三方全面对比（插件化 provider/prefetch 注入） |
| `workspace-diagnosis-2026-08-21.md` | 对话区诊断（P0 工具归属+持久化状态机 → P1/P2 分层修复） |
| `workbuddy-chat-architecture-2026-08-21.md` | WorkBuddy 对话区全量拆解（content blocks/交替式/三层折叠） |
| `workbuddy-details-research-2026-08-21.md` | WorkBuddy 细节全景深挖（时间/反馈栏/输入区/队列/错误横幅） |
| `alternating-chat-1to1-alignment-2026-08-21.md` | 交替式对话 1:1 对齐方案（块引擎/折叠/时间/面板三批顺序） |
| `WORKBUDDY_MSG_ARCH_REPLICATION.md` / `WORKBUDDY_REVERSE_ANALYSIS.md` | WorkBuddy 逆向分析（8-19） |
| `SUPERCRZY_IMPLEMENTATION_CHECKLIST.md` | 实施检查清单 |

### 4.3 关键源码文件

| 文件 | 职责 |
|---|---|
| `packages/client/src/views/ChatView.vue` | 聊天主界面（发送/SSE 事件/授权/附件/总计时） |
| `packages/client/src/components/chat/MessageFlowRenderer.vue` | 消息时序流渲染 + 折叠态 + 正文路径检测 |
| `packages/client/src/stores/chat-stream.ts` | SSE 流处理 + 打字机引擎 + 流式画图 |
| `packages/client/src/stores/chat.ts` | 会话管理 + 持久化（serializeWithFlow/Diagrams + 加载兜底） |
| `packages/client/src/stores/plan.ts` | 任务胶囊进度（planFinished 区分"步骤完成/回复结束"） |
| `packages/client/src/utils/typewriter.ts` | 打字机引擎（EMA 平滑） |
| `packages/client/src/utils/tool-meta.ts` / `tool-summary.ts` | 工具图标注册表 / 折叠摘要 |
| `packages/client/src/utils/file-preview.ts` | 文件预览（openFilePreview → preview 面板） |
| `packages/client/src/types/index.ts` | ChatMessage / ChatFlowNode / ToolStatus 10 态 / SSEEvent |
| `packages/server/src/services/agent.ts` | Agent Loop + plan 推进 + SSE 事件 |
| `packages/server/src/services/tools.ts` | 全部工具实现（web_fetch 结构化 / draw_diagram 流式） |
| `packages/server/src/services/sandbox.ts` | 三层沙箱 + assertSafeFilePath（返回错误字符串非抛错！） |
| `packages/server/src/routes/filesystem.ts` | 目录浏览 + 文件读取（白名单校验） |
| `packages/server/src/routes/chat.ts` | 聊天路由（tool-confirm 等） |
| `packages/desktop/main.cjs` | Electron 主进程 + 自动更新 |

### 4.4 记忆系统（.workbuddy/memory/）

| 文件 | 内容 |
|---|---|
| `YYYY-MM-DD.md` | 每日工作日志（append-only，8-15 起连续记录） |
| `MEMORY.md` | 长期项目备忘（品牌/约定/环境事实/沙箱/文件误删恢复/新闻生态方向） |

### 4.5 数据与沙箱

| 项 | 位置 |
|---|---|
| SQLite 数据库 | `packages/server/data/supercrzy.db` |
| 上传文件 | `uploads/` |
| Agent 沙箱白名单 | 项目仓库根（上溯 pnpm-workspace.yaml）+ workspaceDir + ~/.workbuddy/{binaries,skills} 只读 + ~/.local/bin + /tmp；home 其余全禁；凭据文件任何路径禁 |
| 文件误删恢复 | `~/.workbuddy/file-history/<uuid>/<hash>@vN`（每次写入自动留版本，明文 UTF-8） |

---

## 5. 进行中的事项

### 5.1 8-20 完成（当天全绿验证：双端 tsc ✅ / build ✅ / server 37 测试 ✅）

- **P0 消息区体验 7 项全部完成**：正文路径检测（linkifyPaths + 事件委托）、WebFetchCard A+B（结构化 JSON + 一行卡片）、read_file 文件定位、语义联动（动词推导 + editProgress）、ToolErrorBoundary、状态机 10 态（parsing/cancelled/destroyed）、tool createTime
- **结构性三件套**：删 10 死组件 / 渲染器注册表 / ToolCallBlock 拆 renderers/
- **SSE 抽离第一步**：stores/chat-stream.ts（打字机 + flow 更新 + 流式画图集中，可多实例供幽灵模式复用）
- **流式画图**：draw_diagram 按标签切块推 diagram_chunk → "先出画板再逐框绘制"（WorkBuddy 同款机制）
- **打字机引擎统一**：正文/思考共用 25-100 字符/秒匀速（思考不再喷射）
- **体验修复 8 连**：思考推文字（live 撑开）、折叠保留图、流式可上滑（去掉强制吸底）、总计时（"已用时 Xs"→"已完成"）、产物折叠（前 3 张 + 展开全部）、授权按钮倒计时、用户消息引号修复、任务胶囊"收尾中…"态、SVG 裸露/乱码修复、done 加速收尾

### 5.2 8-21~8-23 完成（老板拍板全量落地）

- **对话区 1:1 对齐 WorkBuddy**（8-21 十项全落地）：工具归属按 toolCallId 精确更新 / 持久化状态机 / 分段 MetaFold / 消息级渐进渲染 / SSE 断线重连+去重 / 工具参数增量解析 / 消息块模型 id / 富文本复制 / 数据层抽取 / 思考实时展开+自动跟随
- **消息区最终形态定稿**（8-21，老板确认后不改）：执行中交替式全渲染（思考+说明+工具+回复按序）；完成后整体折叠只出结论（一个折叠条：工具 N 次·思考 M 轮·已完成 Xs）+ 全部正文 + diagram；ThinkingBlock markdown 渲染（含代码框）
- **细节体验 20+ 项**（8-21）：代码块复制按钮/完成态折叠延迟修复/折叠条常驻/思考推理 markdown/正文代码框对齐 cr-code-like-box/提问浮层化/输入历史↑↓/上下文环分类/输入高度记忆/错误横幅+输入横幅/选中色多轮修复/代码框双主题/白黑模式全面修复/历史提问导航条 QuestionNavRail（固定侧边+完整面板）
- **技能市场体系**（8-22）：内置 32 技能 + 开源市场（browse.sh 461 + GitHub 官方）+ 分类 Tab + 安装/卸载/开关 + 双列卡片 + 全量双语 + 图标 LOGO 丰富
- **搜索智能层**（8-22/8-23）：五层降级链（SearXNG 自建为主）+ 时效性过滤（timeRange + maxAgeDays + 保底）+ 溯源约束 + 权威源优先级 + 结果后处理（去重排序）+ web_fetch 四层降级（Chrome headless 兜底）
- **P0.1 记忆 FTS5**（8-23）：agent_memory 加 confidence/usage_count/last_used + FTS5 trigram 虚拟表 + BM25 加权排名 + 混合召回（2 字词 LIKE 补充）；实测"分析 OpenAI 公司"经验排第一 ✅
- **P0.2 SearXNG 部署**（8-23）：VPS Docker 部署 + ufw 防火墙（8080 仅限本机 IP）+ locale 踩坑（Babel 格式设空串）+ limiter 关闭 + 端到端 30 条结果 ✅
- **4 创新方向全部完成**：对话分享导出 / 技能包一键导入 / 多模型对比 / 幽灵模式（多 bot 并行+协调）
- **智能感 5 项细节**（8-23，对齐 Harness/GPT）：每轮性能指标（折叠条"已完成 Xs · 首字 X.Xs · 打字 X 字符/s"）/ 思考折叠第一行摘要 / 引用来源卡片（SourceCards）/ 骨架屏（typing+脉动线）/ 思考渲染 rAF 节流 ✅ 实测通过
- **视觉多模态 + 搜索全包**（8-23）：图片上传→vision-exp 自动路由（实测识别测试图 ✅）/ DeepSeek 官方原生搜索接入六层链（一个 key 全包聊天+视觉+搜索）/ embedding 混合检索（0.8cos+0.2rank，配 key 激活）/ 互斥工具屏障（写类串行）✅
- **侧边栏会话列表去模型名**（8-23）：只留标题+相对时间（WorkBuddy/Harness 惯例，模型名有误导性）✅
- **产物卡片化**（8-23，工作区叙事化 🔴1）：DetailPanel 新增「产物」tab（默认主入口），AI 产出按轮分组卡片流——edit（file_write/multi_edit）/ diagram（画图）类型 icon + 文件名/路径 + 完成/失败状态角标 + 组头轮次摘要折叠（默认展开最新轮 + showMore）；点文件卡片→预览，点图卡片→内联展开 SVG；顺手修 completeDiagram title 丢失 bug ✅ 实测通过
- **时间线升级 + 产物↔消息联动**（8-23，🔴2+🟡3）：时间线从"最后一条消息 flow"→ 全对话轨迹回放（TimelinePanel 重写，对齐 Harness TrajectoryTable）：每条 assistant 消息=一轮，含摘要/思考/工具(名+状态+耗时+产出文件)/产物胶囊/每轮指标(TTFT+耗时)/token 用量，搜索框过滤 + 默认展开最新轮；产物卡片与时间线轮次 hover 跳转按钮 → 消息区滚动居中 + 高亮闪光（store.focusMessage 直接 DOM 定位，ChatView watch 处理长会话渲染窗口）✅ 实测通过
- **输入框/会话管理 5 项**（8-24，老板"全部开始"）：①**对话内一键引用**（消息 hover/选中文本 → 输入框引用块 → 注入「> 用户引用/AI 回复引用」标记 → 系统提示声明引用=最高优先级上下文）②**归档对话**（sessions.archived 列 + ?archived 过滤 + 归档区/恢复，对齐 GPT archiveConversation）③**输入触发管线**（/与@统一：光标 token 检测 + 分组候选 + ↑↓/Enter/Esc，对齐 harness ui-input-trigger）④**@文件/@技能/@对话 + 斜杠命令**（/new /search /help /skill）⑤**消息编辑/重生成**（批量作废端点 DELETE ?after=msgId + submitEdit 分支作废 + AI 消息「重新生成」按钮，对齐 GPT regenerateFromMessageId）✅ 全部实测通过
- **MCP 预设市场**（8-24，对接官方 registry）：官方 MCP Registry(registry.modelcontextprotocol.io)开源可编程读取(23,700+ 服务器,服务端 ?search= 过滤);后端 `GET /api/mcp/presets`(内置 Playwright/时间/filesystem/Git 4 个官方精选)+ `GET /api/mcp/search?q=`(代理官方 + 1h 缓存);前端设置页 MCP tab 三段式(推荐连接器卡/注册表搜索 30 条/已装列表)+ 添加确认弹窗(命令或 URL 预览 + 社区风险警告)+ 自动测试连接;stdio npx @latest 天然自动更新 ✅ 实测通过

### 5.3 当前状态

- **167 个文件未提交**（git HEAD 仍是 V0.3.0）——老板已明确：**固化放最后**，等稳定成型
- 前后端 dev server 常驻问题：后台进程回合结束被沙箱回收，需要时说"重启服务"（后端 kill 3000 + tsx app.ts；前端 vite --port 5173）
- PWA/HTTP 缓存：前端改动后需 **Cmd/Ctrl+Shift+R 强刷** 才能看到新代码
- **VPS 防火墙安全函数已装**（/root/.bashrc `ufw()`：reset 拦截 + 执行前强制备份），任何 ufw 操作自动留底

---

## 6. 未处理事项（按优先级 · 2026-08-23 更新）

### 🔴 架构路线图（8-23 评审定稿，P0.1/P0.2 已完成）

> 战略定位：不做万能 Agent，做"AI 内容研究员 Agent"——场景（AI 新闻/公司分析/产品对比/技术解读）高度重复 → Experience→Skill 复利快，与新闻生态天然契合

| 优先级 | 事项 | 说明 |
|---|---|---|
| P1 | **Deep Research Engine** | ✅ **2026-08-23 已完成**：services/deep-research.ts（generateSerpQueries → mapLimit(2) 并行 → processSerpResult → 递归下钻漏斗 → writeFinalReport）+ deep_research 工具；firecrawl→五层搜索链，generateObject→DeepSeek JSON mode，p-limit→手写 mapLimit，零新依赖；实测 5 learnings/7 urls/3.5k 字报告 ✅ |
| P1.5 | **Experience Reflection** | ✅ **2026-08-23 已完成**：services/reflection.ts，任务完成(有工具调用)异步 5 问反思 → category='experience' confidence=0.7；端到端验证沉淀"经验:current-event-news-brief" ✅ |
| P2 | **Skill Generation** | ✅ **2026-08-23 已完成**：LLM 自主判定 skillWorthy → 自动生成技能入库（实测自动创建 current-event-news-brief）；skills 表加 usage_count/last_used + 技能命中计数 + scheduler 180 天未用自动停用 |
| P3 | **幽灵多 Agent × 深度研究** | ✅ **2026-08-23 已完成**：幽灵工作台"深度研究模式"开关 + 子任务 mode 判定(research/agent) + research 幽灵直接跑 deep_research 内核；实测 3 幽灵并行 → 3.2 万字/198 来源/汇总 1.5 万字报告 |

### 🟡 搜索 / 记忆智能层增强（8-22 研究遗留）

| 事项 | 说明 |
|---|---|
| 时间敏感词自动触发搜索 | ✅ **2026-08-23 已完成**：TIME_SENSITIVE_RE 检测 → 命中注入"时效性强制要求"，禁止凭训练数据回答 |
| 搜索 provider 抽象 | 对齐 Hermes 插件化 WebProvider（search/extract 抽象基类 + 自动降级探测 TAVILY→SEARXNG→默认） |
| 记忆 prefetch 注入 | ✅ **2026-08-23 完成闭环**：turn 前 FTS5 语义预取（buildSystemPrompt 注入）+ turn 后 sync_turn（services/memory-sync.ts，LLM 提取用户偏好/项目事实入库） |
| embedding 混合检索 | ✅ **2026-08-23 已完成**：services/embedding.ts（OpenAI 兼容批量，默认硅基流动 BGE-M3，可配 key）+ memoryRankedSearchHybrid（async，final=0.8·normCosine+0.2·normRank，未配 key 完全退化 FTS5）+ memory_recall 走混合 |
| **视觉多模态** | ✅ **2026-08-23 已接入**：图片上传 → 后端 blocks 注入（text+image_url）→ 模型自动路由 deepseek-v4-flash-vision-exp；一个 DeepSeek key 全包聊天+视觉+搜索；实测识别测试图精准 ✅（图片仅首轮 user 消息硬约束） |
| 知识库 RAG | 新闻生态/知识库文档检索（远期，依赖上两项） |

### 🟡 消息区遗留技术债（8-20/8-21 定）

| 事项 | 说明 |
|---|---|
| **双轨单轨化 3 阶段** | docs/SINGLE_TRACK_MIGRATION_PLAN_2026-08-20.md（未执行）：①SSE 直写 content blocks ②渲染层切 content（删 ChatMessage.flow）③清理双轨产物（估净减 400-600 行）；根治 content/flow 同步 bug（图推走/正文劈开/刷新截断/SVG 乱码） |
| ChatView SSE case 全抽 | 28 个 case 仅打字机层抽走（chat-stream.ts），事件分发仍在组件内；ChatView 仍 5000+ 行 |
| 真虚拟列表 | 现为"渐进加载"（RENDER_CHUNK 40 尾部优先）非窗口化；react-virtuoso 式需高度测量，列后续 |
| ACP 续传 | SSE 断线重连现为"重跑+去重+副作用保护"，非断点续传；后端事件缓冲+Last-Event-ID 需架构级 pub/sub |
| 主对话嵌套 Sub-agent | 后端无子 agent 事件源（parentToolUseId）；Ghost 独立，前端数据结构已预留 id/toolCallId |
| 历史消息体系 | 会话分隔线/模型切换分隔线/压缩分隔线/按天分组（已研究未做，docs 有方案） |

### 🟢 项目级 / 远期

| 事项 | 备注 |
|---|---|
| **回归验证 + 关键场景实测** | 8-20~8-23 改动 ~50 处每处过类型检查但未跑全量回归；建议手动过：流式/思考/画图/读文件/刷新历史/多任务胶囊/搜索时效/记忆召回 |
| **打包固化** | git 提交 167 文件 + 版本 1.0.2 + Electron 打包验证（老板放最后，等稳定成型） |
| **开源（supercrzy-bot）** | SuperCrzy/deepseek-agent 是死 remote；MIT + 双语 README + .gitignore 已就绪；git 历史严重滞后需先固化 |
| App 签名/证书 | 有用户后再做（mac 签名 / Win CodeSign），未签名 mac 自动更新只到下载装不上 |
| 手机版（Capacitor 套壳） | 暂缓 |
| 新闻生态接入 | 技术路线待确认（API/RSS/抓取）；形态待定（news_search 工具 / SKILL 包 supercrzy-news / 每日简报 / 热点追踪） |
| 云服务化 | 未来：邮箱登录/多用户/云端搜索后端（腾讯/Hermes 模式平移） |
| I-4~I-9 快速创新候选 | 自适应权限 / 记忆遗忘曲线 / 省钱引擎（复杂度→模型路由）/ 错误自愈闭环 / 产物中心 / 专家团路由（ROADMAP 已列方案，按需评估） |
| tunnel 默认开启 | ROADMAP P0-2：无 RELAY 配置时自动走 localtunnel 暴露 3000（8-12 遗留，需核实现状） |

---

## 7. 踩坑备忘（技术血泪）

| 坑 | 教训 |
|---|---|
| vite 解析陷阱 | src 下同名 `.js` 优先于 `.ts`；编译产物严禁混进 src/（曾导致整个应用加载旧代码） |
| scoped 样式穿透 | v-html 内容样式必须在组件内用 `:deep` 定义，父组件 scoped 管不到子组件 |
| store 同名单函数遮蔽 | store 自己的 normalizeContent 遮蔽 utils 版 → 排查要全量 grep 同名函数 |
| 打字机 displayLength | 相对"当前 pending 快照"，每次 slice 后必须归零保留 emaLag，否则卡死 |
| finish 瞬间刷完 | done 时把缓冲一次性 append → 正文"一下输出"；改加速收尾（24ms/16 字符） |
| 加载兜底切片基准 | content 含 ```svg / flow 不含 → 对比前先剥离 SVG，否则把 SVG 中段补进正文 |
| SVG 提取正则 | 模型可能缺 `<svg>` 起始标签 → 按语言标记移除 + 缺头补全 |
| 折叠语义 | turnFold 只折叠思考/工具过程，正文 text + 图产物全保留；最终报告靠 lastBodyText |
| dev server 回收 | 后台进程回合结束被杀；nohup &! 也被拦；用 run_in_background 重启 |
| 死组件判定 | grep -v "组件路径" 会误过滤 import 行，判定必须全量 grep 含字符串 |
| **🔴 ufw reset 误删站点规则** | 8-23 生产事故：在 VPS 执行 `ufw reset` 清空服务器全部规则（含 80/443）→ supercrzy.com/cms.supercrzy.com 断流 12.5h。**绝对禁止 ufw reset；动 ufw 前必须 `ufw status numbered > ~/ufw-backup-MMDD.txt` 备份**（已装 ufw() 安全函数自动执行） |
| SearXNG locale | SearXNG 用 Babel locale 非 CLDR：`zh`/`zh-Hans` 均报 Invalid value，设 `""`（浏览器自动检测）；`limiter: true` 会误杀 JSON API，必须 false |

---

## 8. 常用命令速查

```bash
pnpm dev                    # 开发模式（前端 5173 + 后端 3000 热更新）
pnpm --filter @supercrzy/server start   # 生产单进程（3000 同时服务页面 + API）
pnpm cli                    # 终端对话模式（CLI 优先）
pnpm build                  # 生产构建（client/dist，后端静态托管）
pnpm test                   # server 37 + client 9 测试
pnpm desktop:dist           # Electron 打包（需有 GUI 的 Mac 跑 dmg）
./start.sh                  # 一键启动（生产）
# 开发时单独重启：
#   后端: kill -9 $(lsof -ti:3000); tsx packages/server/src/app.ts
#   前端: vite --port 5173 --strictPort
```

---

## 9. 下一步建议（Crzy 视角）

1. **P1 Deep Research Engine**——架构路线图下一棒，deep-research 循环已拆透（6-9 次查询漏斗），SearXNG + DeepSeek 即插即用，是"内容研究员 Agent"定位的核心能力
2. **回归实测 + 单轨化**——8-20~8-23 改动面大未全量回归；单轨化根治 content/flow 双轨同步 bug（图推走/正文劈开/刷新截断）
3. 之后按老板节奏：稳定成型 → 固化打包 1.0.2 → 开源 supercrzy-bot
4. P1.5 Experience Reflection / P2 Skill Generation 与新闻生态（每日简报/热点追踪）天然衔接，随时可插队

---

*本手册由 Crzy 整理，基于 .workbuddy/memory 日志 + docs 文档 + 源码结构。发现过时信息请告知更新。*
