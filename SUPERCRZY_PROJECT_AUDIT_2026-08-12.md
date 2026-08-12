# SUPERCRZY Agent 项目深度检查报告

> 审计日期：2026-08-12 · 审计范围：全仓库（client + server + 工程配置）
> 结论先行：**这是一个功能野心大、Agent 核心设计成熟、但工程化严重缺失的个人项目 —— "能用但脆"。**

---

## 一、总体评分

| 维度 | 评级 | 一句话 |
|------|------|--------|
| 架构设计 | ★★★★☆ | Agent Loop 统一复用，Planner/压缩/检查点设计成熟 |
| 功能完整度 | ★★★★☆ | 14 页面 + 40 服务文件，覆盖聊天/技能/记忆/任务/网关/CLI |
| 代码质量 | ★★☆☆☆ | 2 万行零测试，类型检查两端合计 60+ 错误 |
| 工程规范 | ★☆☆☆☆ | 无 CI / 无 lint / 无测试 / git 历史严重滞后 |
| 安全 | ★★☆☆☆ | 明文服务器密码、任意文件读取、shell 裸执行、API 无鉴权 |
| 文档 | ★★☆☆☆ | 数量充足但已过时 2 个月，状态与代码脱节 |

**综合：★★★☆☆ —— 可以跑起来，但经不起一次"意外"。**

---

## 二、项目概况

| 项 | 值 |
|----|----|
| 代码量 | client ~10,798 行 + server ~9,853 行 ≈ **2.0 万行** TS/Vue |
| 前端 | Vue3 + NaiveUI + Vite + Monaco + xterm + echarts + mermaid，14 个页面 |
| 后端 | Koa3 + better-sqlite3 + Socket.IO/SSE/WS 三通道，40+ 源文件 |
| 通信演进 | SSE(agent-stream) → WS(agent-ws) → **Socket.IO(agent-socketio, 主通道, :3002)** |
| Agent 核心 | `agent.ts runAgentLoop()`：动态 maxTurns + 复杂度预估 + Planner 模式 + 上下文压缩 + 检查点续跑 + 工具循环防护 |
| 工具 | 16 个（memory/file/shell/web/task/skill/ask_user） |
| 扩展 | 技能系统（SKILL.md 关键词匹配 + GitHub 安装）、记忆系统、定时任务、微信/QQ 网关、CLI、Cloudflare/localtunnel 隧道 |
| 部署 | VPS 107.174.107.199，agent.supercrzy.com + supercrzy.com，systemd + nginx |

---

## 三、核心风险清单（按严重度）

### 🔴 P0 — 必须先处理

| # | 风险 | 证据 | 后果 |
|---|------|------|------|
| 1 | **Git 历史严重滞后 + 无远程仓库** | 仅 2 个 commit（3ec4eaf / e24227e），`git branch -a` 无 origin；**105 个文件变更未提交**，7/2 日志已记录 107 个，至今 40 天 | 整个 Socket.IO 改造、Automations/Tasks/Models 页面、QQ 网关、全部新 UI 组件只存在于工作区。磁盘损坏/误操作即全部丢失，无任何备份 |
| 2 | **客户端构建（标准流程）必失败** | `pnpm build` = `vue-tsc -b && vite build`，而 vue-tsc 报 **30+ 错误**（详见第四节） | 无法产出新 dist；现 dist 为 6 月旧产物，与源码不同步 |
| 3 | **服务端类型检查 27 个错误** | `tsc --noEmit`：`config.tunnel` 未定义（app.ts:408/409）、`@koa/multer`/`localtunnel` 无类型声明、agent.ts:473-475 `'en'` possibly undefined、tools.ts:582 类型不匹配 | strict 模式形同虚设，错误只能靠运行时暴露 |
| 4 | **明文存储 VPS root 密码** | `SUPERCRZY_AGENT_参考手册.md` 明文存 VPS root 密码（已 [REDACTED]）+ IP + SSH 命令（未提交 git，但本地明文存在） | 文件一旦被同步/分享/发给 AI 即泄露；应改用 SSH Key 并删除密码记录 |
| 5 | **`/api/preview/` 任意文件读取** | `app.ts:374-385`：`ctx.path` 直接拼路径，`GET /api/preview//etc/passwd` 即可读取任意文件并以 HTML 返回 | 叠加"tunnel 默认开启 + CORS 全开 + API 无鉴权"（app.ts:350、409-413），公网可达时等于裸奔 |

### 🟡 P1 — 应尽快处理

| # | 风险 | 证据 |
|---|------|------|
| 6 | **零测试** | 全仓库无一个 `.test.ts`（仅 node_modules 内第三方）；40+ 服务文件、三通道通信全部手工验证 |
| 7 | **零 CI / 零 lint** | 无 `.github/`、无 ESLint 配置；类型检查失败也无人拦截 |
| 8 | **shell_exec 裸执行** | `tools.ts:168` `exec(args.command)` 直接执行，工具描述写"仅只读命令"但**执行器无任何白名单/黑名单/沙箱**；`dangerous:true` 只触发前端确认面板，API 直调可绕过 |
| 9 | **依赖已知漏洞** | xlsx **0.18.5**（CVE-2023-30533 原型污染 + CVE-2024-22363 ReDoS，npm 包已停更）；pdf-parse 2.4.5 生态差 |
| 10 | **文档全面过时** | `SUPERCRZY_DEVELOPMENT_STATUS.md`（5/8）仍列 6 个工具卡片"待实现"，实际 WebSearchCard/WebFetchCard/ReadFileCard/ExecuteCmdCard/ListFileCard **均已实现**；通信层已切 Socket.IO 为主，文档仍称 SSE 为主；参考手册（6/3）已 2 个月未更新 |

### 🟢 P2 — 顺手清理

| # | 问题 |
|---|------|
| 11 | server 根目录 3 个 **0 字节 db 文件**（agent.db / deepseek-agent.db / supercrzy.db），真库在 data/ 下 |
| 12 | 残留文件：`TasksView.vue.bak2`、`vite.config.ts.bak`、`vite.config.ts`（已删改用 .mjs）、`tsconfig.tsbuildinfo`、client/src 下编译残留 `i18n/index.js`、`router/index.js`、`types/index.js`、`composables/useChatSearch.js` + .map |
| 13 | client dependencies 误装 `socket.io`（应只在 server）；echarts 6.0 与 ESM 有兼容问题（TS1203） |
| 14 | 三套通信代码并存（agent-stream/agent-ws/agent-socketio），维护成本高；Socket.IO 通过"mock Koa ctx + SSE 事件桥接"复用 runAgentLoop，耦合较绕 |
| 15 | README 声称 "18 DeepSeek Models"，预设模型实际只有 7 个 deepseek 模型 |

---

## 四、类型检查明细（关键错误）

### server（27 错误，tsc --noEmit）
```
app.ts(408,66)  config.tunnel 不存在 → tunnel 功能已写但 config 类型未更新
app.ts(409,14)  同上
upload.ts(7)    @koa/multer 无声明文件（需 @types/koa__multer）
upload.ts(20-31) 多个参数隐式 any
agent.ts(473-475) 'en' possibly undefined
tools.ts(582)   "interaction" 不是合法 category
tunnel.ts(6)    localtunnel 无声明文件
tunnel.ts(119-144) tunnel 变量 unknown
```

### client（30+ 错误，vue-tsc --noEmit）
```
@intlify/core-base → @intlify/devtools-types 模块缺失（vue-i18n 10 依赖问题）
echarts@6.0  TS1203: Export assignment 与 ESM 不兼容
ToolCallBlock.vue(50)  resultDisplay 不存在
DetailPanel.vue(49,91,95)  onClick 类型不匹配、qrCodeURL/mobilePreviewURL 不存在
MainLayout.vue(210-216)  分组选项联合类型访问错误
SvgIcon.vue(75)  'ellipses' 不在 IconDef
stores/chat.ts(211)  string 赋给 ContentBlock[]
ChatView.vue(102-123,235-239,362-423)  toolCalls/thinking 不存在、ContentBlock[]↔string 冲突、md/highlight 隐式 any
```

---

## 五、做得好的地方（值得保留）

1. **Agent Loop 工程化成熟**（agent.ts）：动态 maxTurns + `estimateComplexity`、Planner 模式（复杂任务先规划）、每 3 轮上下文裁剪 + LLM 摘要压缩、接近上限时提示收敛、ETA 估算 —— 这不是玩具代码。
2. **检查点续跑**（`saveCheckpoint` + `resumeCheckpoint`）：Agent 长任务可在断点恢复，微信网关也支持"继续检查点"指令。
3. **工具防护三层**：`tool-guardrails.ts`（重复失败/幂等无进展检测 → warn/block/halt）、`security-shield.ts`（凭据/PII/Prompt 注入扫描 + 响应脱敏）、`ask_user` 交互暂停。
4. **多通道统一**：agent-socketio 复用 runAgentLoop，避免两套 Agent 实现漂移（参考手册 Bug #8 的修复思路正确）。
5. **数据库实践**：WAL 模式、外键、索引、`ALTER TABLE` try/catch 迁移、automations 表结构设计完整。
6. **多 Provider 兼容**：`normalizeBaseUrl()` 统一处理 `/v1` 尾巴问题，覆盖 4 条代码路径。
7. **hooks + continuous-learning**：会话生命周期钩子 + 会话摘要/消息分析，是"自我学习"的雏形。

---

## 六、建议行动顺序（按 ROI 排序）

| 优先级 | 行动 | 工作量 |
|--------|------|--------|
| P0-1 | **git commit + push 到 GitHub**（含 .gitignore 已就位，敏感文件已排除）| 30 分钟 |
| P0-2 | 删除参考手册中的明文密码，改用 SSH Key 认证，密码移入密码管理器 | 30 分钟 |
| P0-3 | 修复 `/api/preview/` 任意文件读取（加路径白名单/目录限制）；为 shell_exec 加命令黑名单；CORS 白名单化 | 半天 |
| P0-4 | 修复两端类型错误（补 config.tunnel 类型、装 @types/koa__multer/@types/localtunnel、@intlify/devtools-types、echarts 改按需引入或降到 5.x、清理 ContentBlock 类型冲突）→ 恢复 `pnpm build` | 1-2 天 |
| P1-1 | 为 runAgentLoop 写核心单测（mock LLM + 真实工具），至少覆盖工具循环/压缩/checkpoint | 2-3 天 |
| P1-2 | 补 ESLint + 简单 CI（GitHub Actions: install → tsc → build）| 半天 |
| P1-3 | 替换 xlsx → exceljs（或移除该依赖若未使用）| 2 小时 |
| P1-4 | 更新三份状态文档至当前真实状态，删掉已实现的"待办" | 2 小时 |
| P2 | 清理 0 字节 db、.bak、src 下编译残留 .js；决定三通道去留（建议只留 Socket.IO）| 2 小时 |

---

## 七、一句话总结

> Agent 的"脑子"（runAgentLoop + 防护体系）是专业级的；但"身体"（工程化、git、测试、安全、文档）还停在个人原型阶段。**先备份，再补测试，再开源。** 当前状态离 push 到 GitHub 公开还差：1 次 commit、2 天类型修复、半天安全加固。

---

*报告由 Crzy 基于全仓库静态审计生成 · 2026-08-12*
