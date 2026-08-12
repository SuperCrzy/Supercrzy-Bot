# SUPERCRZY Agent UI 功能深度检查报告

> 检查日期：2026-08-12 · 方式：前端调用点 ↔ 后端路由交叉比对 + 实际请求验证（服务运行中）
> 结论：**15 个页面中 3 个核心功能不可用、5 个半空/名不副实、1 个纯摆设；最严重的是聊天 API key 已失效。**

---

## 一、结论总览

| 级别 | 数量 | 问题 |
|------|------|------|
| 🔴 不工作 | 3 | 聊天发不出消息(401)、工作台 WS 连不上、交付面板文件 Tab 404 |
| 🟡 半空/名不副实 | 5 | 搜索、日志、用量、频道文件、Socket.IO 未接入 |
| ⚪ 纯摆设 | 1 | 用户管理(硬编码假数据) |
| 🟢 正常 | 6 | 会话/历史、记忆、任务、自动化、技能、网关 |
| ⚠️ 安全 | 1 | /api/settings 明文返回全部密钥 |

---

## 二、详细清单(按严重度)

### 🔴 不工作

**1. 聊天发不出消息 —— API key 已失效(401)** ⚡最重要
- 实测 `POST /api/chat/agent`:DeepSeek 返回 `Authentication Fails, Your api key: ****f022 is invalid`
- settings 表里的 key `sk-bbc6…f022` 已失效(可能过期或被删除)
- 后果:UI 里发任何消息都会返回"API 服务异常 (auth)",Agent 模式完全不可用
- 修复:更新 settings 表 / 设置页里的 DeepSeek API Key(需用户提供新 key)

**2. 工作台(Workspace)文件树 + 终端 + 编辑器全部连不上**
- 前端 WS_URL 硬编码 `ws://localhost:${location.port}/ws/terminal`(`WorkspaceView.vue`)
- dev 模式(location.port=5173)时连到 Vite,Vite 代理只配了 `/api`,**没有 /ws 代理** → WebSocket 连接失败
- 生产模式(3000 serve)时 location.port=3000 才能通 —— 说明 dev 环境一直是坏的
- 另外 WS_URL 硬编码 localhost,局域网访问也会连错
- 注意:后端 terminal.ts 其实有 listFiles/readFile/writeFile 能力(走 WS),但前端 dev 摸不到

**3. 右侧交付面板"文件"Tab 空(404)**
- `DetailPanel.vue` loadFiles 调 `GET /api/workspace/files` → 后端无此路由 → 404,文件树永远加载不出来
- 文件预览调 `GET /api/workspace/files/content?path=` → 同样 404
- 后端有 WS 版文件能力,但没有 HTTP 版 → 两套方案打架,HTTP 侧悬空

### 🟡 半空/名不副实

**4. 搜索页(Search)实际搜不到**
- `SearchView.vue` 逻辑:全量拉取所有 sessions + 所有 messages 在浏览器端过滤
- 且 `m.content?.toLowerCase()` 在历史消息(ContentBlock[] 数组)上不存在 → 抛错被 catch 吞掉 → 结果恒空
- 后端其实有 `GET /api/history/search` 路由,前端没用
- 另:全量拉取方式在数据多时极慢

**5. 日志页(Logs)显示的是聊天消息,不是系统日志**
- `GET /api/stats/logs` 返回 messages 表最近 50 条(role/content/session_title)
- 页面标题"系统日志(真实数据 + 搜索 + 过滤)",实际展示的是聊天记录,无日志级别/来源/进程信息
- 系统运行日志(console.log)没有任何入库机制

**6. 用量页(Usage)token/cost 恒为 0**
- `GET /api/stats/usage` 的 tokens/cost 来自 messages.token_count/cost
- 但消息持久化时从未写入这两个字段(流式响应没有 usage 事件回传,前端 tokenCount 从未赋值)
- 柱状图只有消息数有值,token/cost 卡片永远是 0

**7. 频道页(Channel)文件列表是硬编码假数据**
- `ChannelView.vue` onMounted 调 `GET /api/channel/files` → 404
- catch 分支填充硬编码 `[{name:'src',isDir:true},…{name:'package.json'}]` —— 页面显示假文件树

**8. Socket.IO 服务(:3002)前端根本没接**
- client 源码 grep `socket.io-client` / `io(` 无任何结果
- 聊天实际走 SSE(fetch `/api/chat/agent`),Socket.IO server 是死代码(仅 QQ/微信网关可能使用)
- 与参考手册"Socket.IO 为主通道"的描述不符

### ⚪ 纯摆设

**9. 用户管理(Users)完全硬编码**
- `UsersView.vue` 里 `users = ref([{Admin…},{API User…}])` 静态数组,无任何 API 调用
- 开关不生效,增删改全无 —— 纯装饰页面

### ⚠️ 安全注意

**10. `GET /api/settings` 明文返回全部密钥**
- 响应含 `apiKey`(sk-bbc6…f022)和 `qqAppSecret` 明文
- API 无鉴权,若 LAN/公网暴露即泄露;建议脱敏(只返回 hasApiKey 布尔)

### 🟢 正常工作的

| 功能 | 验证 |
|------|------|
| 会话/历史 | `/api/history`、`/api/sessions` 有真实数据 ✅ |
| 记忆 | `/api/memory` 返回记忆记录 ✅ |
| 任务 | `/api/tasks` 有真实任务 ✅ |
| 自动化 | `/api/automations` 有真实自动化(Content Pipeline)✅ |
| 技能 | `/api/skills` 返回 8+ 技能,`POST /api/skills/sync` 可初始化 ✅ |
| 网关 | `/api/gateway/platforms`、`channels`、`wechat/status` 均正常(QQ Bot 已配置)✅ |
| 聊天 UI | 输入框/模式切换/模型选择/消息渲染等 UI 层完整 ✅ |

---

## 三、修复建议(按优先级)

| 优先级 | 修复项 | 工作量 |
|--------|--------|--------|
| P0 | 更新 DeepSeek API Key(需用户提供新 key) | 1 分钟(用户操作) |
| P1 | 工作台 WS 修复:Vite proxy 加 `/ws` 转发到 3000;WS_URL 改为相对路径/可配置 | 半小时 |
| P1 | 补 HTTP `GET /api/workspace/files` + `/content` 路由(复用 terminal.ts 文件逻辑),或让 DetailPanel 走 WS | 1-2 小时 |
| P2 | Search 改用 `GET /api/history/search`(后端全文检索) | 1 小时 |
| P2 | Logs 改接真实日志(或降级为"最近消息"并改标题) | 1 小时 |
| P2 | Usage 流式完成后回填 token_count/cost | 1 小时 |
| P2 | Channel 假数据兜底移除(404 时显示空态而非假文件) | 半小时 |
| P2 | Users 页移除或接真实数据 | 半小时 |
| P3 | settings 密钥脱敏返回 | 半小时 |
| P3 | 清理/接入 Socket.IO 死代码 | 按需 |

---

*报告由 Crzy 基于运行中的服务实测生成 · 2026-08-12*
