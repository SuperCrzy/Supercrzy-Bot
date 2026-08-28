# SUPERCRZY BOT 全盘核实 + 深度盘查 + 开源评估(2026-08-24)

> 全部结论基于代码实证(后端 22 路由/28 工具/18 表/17 服务 + 前端 14 视图/30+ 组件穷举核实),非记忆推断。

---

## 一、功能核实(代码实证清单)

### 后端:28 个内置工具
memory_store/recall/list · file_read/write/exists/multi_edit/lint_file · draw_diagram · shell_exec · web_fetch/web_search · deep_research · ask_question/ask_user · task_create/update/list · create_plan · git_status/diff/commit · computer_use · skill_list/search/view/install · 另按配置动态注入 MCP 工具(`mcp_<server>_<tool>`)

### 后端:22 路由文件 / 150+ 端点
聊天(SSE agent/对比/工具授权) · 自动化(rrule+事件触发) · 幽灵(并行引擎) · checkpoint · 文件系统 · 历史检索 · **MCP(CRUD+预设+官方 registry 搜索)** · 记忆(含 AI 导入) · 模型(14 预设+自定义+discover) · OCR(RapidOCR) · playbook 经验 · 专家角色 · 例程 · 会话(归档/产物/分支作废/反馈) · 设置(令牌) · 技能(市场/安全扫描/安装/导出) · 统计 · 系统更新(SSE) · 任务 · 上传 · 工作区 · **多平台网关(微信/企微/钉钉/飞书/QQ/Telegram/Discord/Slack)**

### 后端:17 个特色服务
deep-research(移植 19.6k★) · ghost-engine(多 Agent 并行) · reflection(5 问反思) · playbook-match · skill-evolve(自动建技能) · tunnel(穿透) · computer-use(桌面控制) · notifier(多平台推送) · qqbot/wechat-bot · role-router · memory-search(FTS5+语义) · context-compressor(55% 阈值) · scheduler · channel-format · **tool-guardrails(循环防护)** · **error-classifier(错误分类降级)**

### 前端:14 视图 / 30+ 组件 / 4 stores
Chat(核心) · GhostWorkbench · Search · Tasks · Automations · Routines · Workspace · Skills · Memory · Models · Logs · Usage · Gateway · Settings(5 tab:账户/显示/Agent/隐私/MCP)
DetailPanel 6 tab:产物/文件/变更/预览/时间线/幽灵(今日补齐叙事化三件套)

---

## 二、代码隐患(核实中发现,需修)

| # | 隐患 | 位置 | 影响 |
|---|---|---|---|
| 1 | **file_delete 遗留引用** | agent.ts 授权逻辑引用,但 tools.ts 无定义无执行器 | 前端若引导调用报"未找到执行器" |
| 2 | **28 个执行器但只注入 18 个 schema** | 10 个工具(file_write/shell_exec/multi_edit 等)靠系统提示文本学习,不在工具 schema | 模型可能误用/行为不稳定 |
| 3 | **channels 表建在 gateway.ts** 而非 database.ts | 建表分散 | 维护风险,启动顺序依赖 |
| 4 | **174 处未提交改动**(65 修改+90 未跟踪) | main 分支 | 开源前必须整理,防敏感配置混入 |
| 5 | **测试覆盖低**:仅 7 测试文件/50 用例 | 对 28 工具/22 路由/18 表 | 开源后 CI 挂红风险 |
| 6 | 版本 0.3.0(未到 1.0) | — | 开源观感 |

---

## 三、优化空间盘查(各维度)

### UI / 界面
- 输入框悬浮卡片方案已出(22px 圆角+阴影+附件缩略图+底栏胶囊),待落地(老板暂缓)
- ChatView 5300+ 行超大组件 → 建议拆分(输入区/消息区/操作区独立组件)
- 暗色/亮色 token 体系已有,细节一致性可打磨

### 功能
- **已强**:多模型对比(独有)、幽灵并行引擎、deep-research、reflection 反思闭环、skill-evolve 技能自进化、tool-guardrails 循环防护、error-classifier 降级策略、多平台网关——**这些 WorkBuddy/Harness 都没有**
- **可加**:goal 目标追踪(借鉴 Harness)、workflow 编排、subagent 正式化、上下文 spill
- **可修**:工具白名单机制(18/28 不一致)、file_delete 清理

### 技术 / 代码 / 结构
- 搜索五层链(DeepSeek→Tavily→Serper→SearXNG→Bing→DDG)领先
- 上下文压缩器(55% 阈值+头部尾部保护)扎实
- 沙箱三层防护扎实
- 建议:路由/服务分层已清晰;补单元测试(playbook-match 已有,工具执行器/tool-guardrails/error-classifier 应补)

### 细节
- 空状态/错误提示覆盖较全(ErrorBanner/ToolErrorBoundary)
- PWA 离线能力可强化
- Electron 打包验证(需真机)

---

## 四、开源评估:当前不宜,预计 1-2 个月后

### 就绪度检查结果
| 项 | 状态 |
|---|---|
| LICENSE | ✅ MIT |
| .gitignore | ✅ 完整(.env/*.db/data/uploads/.workbuddy 全屏蔽) |
| 敏感密钥历史 | ✅ 无真实泄露(3 处命中均为占位符/测试假 key) |
| README 双语 | ✅ README.md + README.zh-CN.md |
| 文档 | ✅ docs/ 20 篇 |
| **未提交改动** | ⚠️ **174 处未提交** |
| **测试覆盖** | ⚠️ 50 用例(28 工具/22 路由/18 表) |
| **版本** | ⚠️ 0.3.0 |
| 远程仓库 | ⚠️ SuperCrzy/deepseek-agent(旧名,应改 supercrzy-bot) |

### 结论:暂不开源,预计 1-2 个月
1. **当前最大阻碍**:174 处未提交改动(含今天 7 项新功能 + MCP 市场)——提交前需全面 review,防止新功能带入敏感配置
2. **测试不足**:50 用例对 28 工具/22 路由偏少,开源后 CI 挂红难看;至少补到 100+(工具执行器/防护/压缩器/网关)
3. **版本 0.3.0**:体验优化(输入框/稳定)完成到 1.0 再开源,符合老板"先优化体验后开源"节奏
4. **工具白名单隐患**(18/28)开源前必修

### 开源前清单(Checklist)
- [ ] 清理 174 处未提交改动 + 全面 review(重点:新功能配置/日志无敏感信息)
- [ ] 修复 file_delete 遗留 + 工具白名单统一(全注入 or 明确禁用)
- [ ] 测试补到 100+(工具执行器/压缩器/防护/网关/沙箱)
- [ ] 版本升 1.0 + CHANGELOG 整理
- [ ] 远程仓库改名 supercrzy-bot
- [ ] 开源公告 README 补架构图/快速开始/贡献指南

---

## 五、总体判断

**项目真实状态比自检报告展示的更强**:今天核实发现 deep-research/ghost-engine/reflection/skill-evolve/tool-guardrails/error-classifier/多平台网关等一批差异化服务,这些是 WorkBuddy/Harness 都没有的。功能覆盖度"反超"的判断成立。

**主要风险不在功能,在工程化**:未提交改动堆积、测试覆盖低、工具白名单不一致——这些不解决,开源就是砸招牌;解决了,这是个有真实差异化的开源项目(多模型对比+幽灵并行+反思闭环+技能自进化都是卖点)。
