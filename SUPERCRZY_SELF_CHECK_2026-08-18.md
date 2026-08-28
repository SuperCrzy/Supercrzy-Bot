# SUPERCRZY Agent 全量自检报告（假功能 + Bug）

> 自检日期：2026-08-18 · 方式：双 Agent 前后端交叉审计 + 运行时实测（API 抽样 + 浏览器全链路）
> 结论：**核心链路（聊天/工具/幽灵/工作区/设置）真实可用；发现 4 个"假功能"、6 个死代码、6 个名不副实/小 bug**

---

## 一、🔴 假功能（有入口但无真实实现）

| # | 功能 | 现状 | 证据 |
|---|------|------|------|
| 1 | **语音输入按钮**（聊天输入框） | 死按钮：仅弹 toast「语音输入即将支持」，无任何识别逻辑 | ChatView.vue:1415-1418 注释自认「占位（后续接语音识别）」 |
| 2 | **消息点赞 / 点踩** | 只改本地 `msg.feedback`，无持久化，刷新即丢（对标 WorkBuddy MessageFeedback，开发状态文档亦标 ❌ 待实现） | ChatView.vue:586-591, 1829-1831 |
| 3 | **日志页（Logs）** | 名不副实：`/api/stats/logs` 返回的是聊天消息，不是系统日志；页面 WARN/ERROR/DEBUG 过滤按钮恒查不到数据（硬编码 `level:'info'`） | LogsView.vue:107；stats 路由 |
| 4 | **用量页（Usage）cost** | token 统计已正常（2.1M），但 **cost 恒为 0**（流式结束后从未回填 cost 字段） | /api/stats/usage 实测 `cost:0` |

## 二、⚪ 死代码 / 未接入（不影响主链路，但占体积）

| # | 项 | 现状 | 证据 |
|---|----|------|------|
| 5 | **Socket.IO(:3002)** | 启动打印「Socket.IO: port 3002」，但全仓无 socket.io 依赖/代码（幽灵工作台已改用 ws，纯遗留） | app.ts:477；package.json 无 socket.io |
| 6 | **services/hooks.ts** | 只做副作用注册，`triggerHook/withSession/safeSend` 全仓零调用 → continuous-learning / security-shield 永不运行 | app.ts:20 |
| 7 | **services/relay-server.ts** | 无任何 src import（仅 dist 残留），内含 `server.listen(3100)` | 全仓 grep 无引用 |
| 8 | **web_search 工具** | 有 executor 但**无 toolDefinition**，被白名单过滤，模型永远收不到该工具 | tools.ts:650 vs 857-1161 |
| 9 | **tavilyApiKey** | settings 白名单无此 key，无写入入口，tools.ts Tavily 分支永不激活 | tools.ts:660；settings.ts:66 |
| 10 | **幻影工具 notebook_edit** | app.ts toolNameMap 声明了它，但 tools.ts 无定义/executor | app.ts:112 |

## 三、🟡 名不副实 / 小 bug

| # | 项 | 现状 | 证据 |
|---|----|------|------|
| 11 | **DetailPanel 首次打开空白** | store 默认 tab=`artifacts`，但 DetailPanel 的 tabs 数组无 artifacts、模板无该分支 → 首次打开右侧面板空白 | stores/app.ts:18；DetailPanel.vue:363-369 |
| 12 | **「内联差异」开关** | 保存到后端但全仓无渲染逻辑读取 inlineDiff，开关无效 | SettingsView.vue:99；app.ts:81 |
| 13 | **侧边栏底部用户名恒 `default`** | currentAgent 无任何赋值入口，未设昵称时显示恒为 default | MainLayout.vue:233；app.ts:286-288 |
| 14 | **DetailPanel 预览 iframe** | previewUrl 仅被赋空串，iframe 渲染分支永不可达 | DetailPanel.vue:319 |
| 15 | **ghost /status 恒真** | `getGhostSuggestions().length > 0 \|\| true` 恒为 true | ghost.ts:59 |
| 16 | **GET /api/chat/agent（遗留端点）** | 声明 web_search/file_read/file_write 但流解析丢弃 tool_calls（POST 主通道正常，GET 是遗留死端点） | agent-stream.ts:55-97 |
| 17 | **死导出** | `setAgent/connect/isConnected/getModelDisplayName/clearPreview/clearFileChanges/getModelSelectOptions/artifactIcon` 全仓零调用 | 各文件 grep |
| 18 | **ocr.ts 硬编码路径** | 硬编码本机 python 绝对路径，跨机失效 | ocr.ts:15 |

## 四、✅ 实测正常（重点澄清）

| 项 | 验证结果 |
|----|---------|
| **聊天主通道工具执行** | POST /api/chat/agent SSE 实测：tool_call(shell_exec)→tool_result→done 完整链路 ✅；浏览器 UI 消息含命令执行结果 ✅（工具卡片在过程自动折叠后隐藏，展开可见，非缺失） |
| workspace/files | 8-12 的 404 已修复，返回真实文件树 ✅ |
| settings 密钥 | 已脱敏，无明文泄露 ✅ |
| ws 端口 | /ws/ghost、/ws/terminal 均用 location.host 动态拼接，无 5173/3000 错配 ✅ |
| 假数据兜底 | 全站 catch 分支置空/报错，无硬编码演示数据 ✅ |
| 视图可达性 | 14 视图全部注册可达，无死路由 ✅ |
| usage tokens | 已回填（2.1M tokens），仅 cost 未回填（见 #4）✅ |

---

*报告由 Crzy 双 Agent 审计 + 运行时实测生成 · 2026-08-18*

---

## 五、修复记录（2026-08-18 同日）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 语音按钮死按钮 | ✅ 接入 Web Speech API（浏览器原生语音识别，语言跟随界面；录音中红点脉冲，不支持浏览器给提示） |
| 2 | 点赞/点踩无持久化 | ✅ messages 表加 feedback 列（含迁移），新增 `POST /api/sessions/messages/:msgId/feedback`，前端乐观更新+失败回滚+刷新回显（实测 curl 置 up → 刷新按钮 active） |
| 3 | 日志页名不副实 | ✅ 降级为「最近消息」（标题/说明更新），过滤按钮改为角色（全部/AI 回复/用户消息），实测过滤生效 |
| 4 | usage cost 恒 0 | ✅ 后端模型单价表（¥/1M）按 usage 算 cost 下发，前端 usage 事件接收并随消息持久化（cost 需新发消息后体现） |
| 5 | Socket.IO(:3002) 空壳 | ✅ 删启动日志残留 |
| 6 | hooks.ts 死代码 | ✅ 删除 hooks.ts + continuous-learning.ts + security-shield.ts + import |
| 7 | relay-server.ts 死代码 | ✅ 删除文件 |
| 8 | web_search 工具不可用 | ✅ 补 toolDefinition（Tavily 优先 + Bing RSS 免费兜底），settings 白名单加 tavilyApiKey（可选配置） |
| 10 | notebook_edit 幻影 | ✅ 删 toolNameMap 引用 |
| 11 | DetailPanel 首开空白 | ✅ 默认 tab `artifacts`→`files`（类型同步清理） |
| 12 | inlineDiff 开关无效 | ✅ 设置页/后端/词条全链路移除 |
| 13 | 用户名恒 default | ✅ 改读 userName，未设时显示品牌名 |
| 14 | 预览 iframe 死分支 | ✅ 清理 previewUrl 死分支（主线 HtmlPreview+preview_update 已通，实测确认） |
| 15 | ghost/status 恒真 | ✅ 去掉 `\|\| true` |
| 16 | GET /chat/agent 遗留 | ✅ 删路由+import（POST 主通道不变） |
| 17 | 死导出 | ✅ 清 appStore 6 个（setAgent/connect/isConnected/clearPreview/clearFileChanges/getModelDisplayName）+ ChatView artifactIcon；getModelSelectOptions 确认有引用保留 |
| 18 | ocr 硬编码路径 | ✅ 默认改 `python3` + OCR_PYTHON_BIN 可覆盖 |

**验证**：server TSC ✅ client TSC ✅ vitest 37+13 ✅ pnpm build ✅ 浏览器回归（聊天+工具 ✅ 设置页无残留 ✅ 日志页角色过滤 ✅ 点赞持久化 ✅ 语音按钮 UI ✅ 幽灵/工作区未破坏）✅
