# SUPERCRZY BOT 全盘自检报告(2026-08-24)

> 深度对比 WorkBuddy(腾讯)/ Harness(DeepSeek) 全部技术与功能,输出差距 + 亮点。
> 素材:WorkBuddy 解包(renderer/main 组件全量)/ Harness 源码(packages 全量)/ 本项目代码验证。

---

## 一、功能对比矩阵

| 维度 | WorkBuddy | Harness | SUPERCRZY BOT | 状态 |
|---|---|---|---|---|
| 产品形态 | Electron 桌面 + 云文档 | 纯前端框架(SDK) | **Web PWA + Electron App + 自动更新** | ✅ 领先 |
| 登录/账号 | workbuddy 账号 + 云同步 + 配额 | 无(本地) | 无(自部署,邮箱登录推迟到云服务) | ⚠️ 推迟 |
| 聊天主通道 | agent-chat(SSE 类) | conversation(event 日志) | SSE agent(工具调用) | ✅ |
| 上下文压缩 | 有 | **compaction(日志锁)+ spill(溢出)** | compressContext(超限兜底) | 🟡 缺 spill |
| 沙箱 | 有 | sandbox-local / -policy / -windows-acl | **三层:L1 黑名单/L2 软沙箱/L3 sandbox-exec** | ✅ 领先 |
| 技能系统 | chat-skill-selector | ui-skill(SKILL.md,agentskills.io) | **SKILL.md 对齐开放标准 + 欢迎页选择 + /@ 触发** | ✅ 对齐 |
| 专家系统 | **expert-picker / expert-selector** | ui-agent-preset | 无 | 🔴 缺 |
| MCP/连接器 | **use-connector-actions + mcp-app-artifact** | mcp 包 | mcp.json 配置(无 UI 生态) | 🔴 缺 UI 生态 |
| 自动化 | automation | schedule(日历规范化/夏令时) | automations(rrule) | ✅ |
| 目标管理 | 无 | **goal(get_goal 工具/不注入上下文)** | 无 | 🔴 缺 |
| 子代理 | 无 | **subagent(具名提供方委派)** | 幽灵模式(多 Agent 并行,UI 雏形) | 🟡 半 |
| 工作流 | task(任务协同/分享) | **workflow(tool-workflow/worker-thread)** | plan_update(状态推进,非编排) | 🟡 弱 |
| 会话分支 | 无 | **fork(replay 事件日志)** | checkpoint 续跑 + 重生成(今日) | 🟡 无 UI 分叉 |
| 消息反馈 | 有 | ui-message-feedback | 点赞/点踩 | ✅ |
| 产物系统 | **artifact(拖拽/槽位面板/HTML 预览)** | ui-deliverables | 产物卡片化 + 时间线 + 双向联动(今日) | ✅ 追平 |
| 对话分享 | **share-task-dialog / agent-share / share-html-zip** | 无 | **已实现本地导出**(复制/下载 Markdown + 分享图片) | 🟡 差在线链接 |
| 文档处理 | **docx-preview + main-docs-service** | 无 | 文件预览(只读) | 🟡 只读 |
| 终端 | shellsession | terminal | 无独立终端(shell 工具) | 🟢 低 |
| 代码运行 | 有 | **code-runtime** | shell 工具 | 🟢 低 |
| 记忆 | 有 | context 相关 | **recall/remember/记忆页 + MD 导入流程** | ✅ 强 |
| 凭证管理 | auth(登录态) | credential | 自定义 provider key 双存储 | ✅ |
| 权限档位 | 有 | ui-permission-presets | workspace-only / sandbox / full | ✅ 对齐 |
| 模型管理 | 有 | ui-model-selection | Models 页 + custom_providers | ✅ |
| 多模型对比 | 无 | 无 | **并行对比 + 推荐**(差异化创新) | ✅ 独有 |
| 主题/i18n | 有 | ui-theme | 暗色/亮色 + 中英 | ✅ |
| 实时轨迹 | 有 | **ui-trajectory(TrajectoryTable)** | 时间线全对话回放(今日) | ✅ 追平 |
| 输入框 | 高融合 | **触发管线(/@统一)+ 引用插入** | 引用/归档/编辑重生成/触发管线(今日) | ✅ 反超 |
| 守卫/审核 | 有 | guard | 沙箱扫描 + 权限审批 | ✅ |

---

## 二、架构与技术对比

| 层面 | WorkBuddy | Harness | 我们 |
|---|---|---|---|
| 进程架构 | Electron main + daemon-app-server 守护进程 | 纯包化(host + plugins) | Koa3 后端 + Vite 前端,tsx 热更 |
| 插件化 | plugins 目录 | **ui-\* 全部是插件(30+ 包,渐进披露)** | 无插件架构(功能都在视图内) |
| 会话模型 | 状态存储 | **事件日志(session event log,replay/fork/seed)** | SQLite 消息表(线性) |
| 上下文策略 | 压缩 | **compaction 日志锁 + spill 溢出** | 滑动窗口 + compressContext |
| 沙箱技术 | 有 | sandbox-local / ACL | **macOS sandbox-exec 硬沙箱** |
| 搜索 | 内置 | 无(工具) | **Tavily→Serper→SearXNG→Bing→DDG 链** |
| 认证 | 账号体系 | 无 | 无(自部署) |

---

## 三、全盘自检

### A. 做得不错的(亮点)

1. **产品形态双端**(Web PWA + Electron App + 自动更新)——比 WorkBuddy 纯桌面更广,比 Harness 纯前端更完整
2. **沙箱三层防护**(黑名单 → 软沙箱 → sandbox-exec 硬沙箱,自动降级)——三家最体系化
3. **输入框功能密度反超**(今日:对话引用 / 归档 / 编辑重生成 / /@ 触发管线 / @文件技能会话)——比 WorkBuddy 功能量更多,比 Harness 多"消息级引用"
4. **工作区叙事化三件套**(产物卡片化 + 时间线全轨迹 + 双向联动)——追平 Harness trajectory/deliverables
5. **记忆系统完整**(recall/remember/记忆页 + MD 导入工作流)
6. **技能对齐开放标准**(SKILL.md,agentskills.io 40+ 平台)
7. **多模型对比**(WorkBuddy/Harness 都没有的差异化创新)
8. **幽灵模式**(多 Agent 并行雏形,为 subagent 预留)
9. **自部署 + 数据本地**(隐私优先,单用户形态明确)
10. **checkpoint 分支续跑 + 重生成**(对话可回退,GPT regenerate 级)

### B. 需要提升的(差距清单)

| 优先级 | 差距 | 对齐谁 | 说明 |
|---|---|---|---|
| 🔴 1 | **专家系统** | WorkBuddy expert | 专家角色/专家包是 WorkBuddy 生态核心,我们无 |
| 🔴 2 | **MCP/连接器 UI 生态** | WorkBuddy connectors | 有 mcp.json 配置但无管理页/连接器市场 |
| 🔴 3 | **goal 目标管理** | Harness goal | 长任务目标追踪(get_goal),防漂移 |
| 🟡 4 | **workflow 工作流编排** | Harness workflow | plan 只有状态推进,无步骤编排/worker |
| 🟡 5 | **subagent 正式化** | Harness subagent | 幽灵模式升为具名子代理(委派/结果回收) |
| 🟡 6 | **上下文 spill 溢出** | Harness spill | 超长会话溢出到文件,不止压缩 |
| 🟡 7 | **会话 fork UI** | Harness fork | checkpoint 有续跑但无"从任意消息分叉"按钮 |
| 🟡 8 | **在线链接分享** | WorkBuddy share | 本地导出(复制/下载 MD + 图片)已有,差在线链接形态 |
| 🟢 9 | 独立终端面板 | WorkBuddy shellsession | shell 工具可视化 |
| 🟢 10 | 文档在线编辑 | WorkBuddy docs service | 现在只读预览 |
| 🟢 11 | 配额/套餐 | WorkBuddy quota | 云服务阶段做 |

---

## 四、提升路线建议

**下一阶段(体验优先,老板 8-23 定的方向)**:
1. 🔴 专家系统(对标 WorkBuddy 专家中心)——差异化竞争点
2. 🔴 MCP 连接器管理页(让 mcp.json 可视化)
3. 🟡 幽灵模式 → 正式 subagent(委派/回收)

**远期(云服务/开源后)**:
- 登录 + 云同步 + 配额(WorkBuddy auth/quota)
- 团队协作 + 对话分享(WorkBuddy share/teams-task)
- goal/workflow 编排(Harness 级)

**本报告结论**:功能覆盖度已追平甚至反超 WorkBuddy(输入框/沙箱/记忆/产物),核心差距在**生态层**(专家/MCP/账号)——这些正是 WorkBuddy 靠腾讯生态堆起来的,单机自部署形态下优先级可延后;架构层差距在 **goal/subagent/workflow 的工程化**(Harness 的包化插件架构值得参考)。
