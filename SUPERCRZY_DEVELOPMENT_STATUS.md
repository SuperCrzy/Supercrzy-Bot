# SuperCrzy Agent — 开发状态总览

> 基于 WorkBuddy v4.22.5 (54万行源码) 和 Hermes UI 逆向研究  
> 最后更新：2026-05-08
> **总进度：已完成 60/63 项 (95%)**  

---

## 一、文件存放位置

| 文件 | 路径 | 说明 |
|------|------|------|
| 项目入口 | `packages/server/src/app.ts` | Koa 后端启动 |
| 前端入口 | `packages/client/index.html` | Vite + Vue3 |
| 类型定义 | `packages/client/src/types/index.ts` | ContentBlock 等核心类型 |
| Agent Loop | `packages/server/src/services/agent.ts` | 多轮思考循环 |
| Agent WS | `packages/server/src/services/agent-ws.ts` | WebSocket 通信(备用) |
| Agent SSE | `packages/server/src/services/agent-stream.ts` | EventSource 流式(当前) |
| 聊天视图 | `packages/client/src/views/ChatView.vue` | 聊天主界面 |
| 布局组件 | `packages/client/src/components/layout/MainLayout.vue` | 三段式布局 |
| Detail 面板 | `packages/client/src/components/layout/DetailPanel.vue` | 右侧交付面板 |
| 思考折叠 | `packages/client/src/components/chat/ReasoningBox.vue` | 深度思考框 |
| 过程折叠 | `packages/client/src/components/chat/ProcessFold.vue` | MetaFold 折叠 |
| 工具卡片 | `packages/client/src/components/chat/ToolCallBlock.vue` | 工具调用展示 |
| 写文件卡 | `packages/client/src/components/chat/WriteFileCard.vue` | 文件写入展示 |
| 搜索输入 | `packages/client/src/components/chat/ChatSearchInput.vue` | 聊天搜索 |
| 搜索逻辑 | `packages/client/src/composables/useChatSearch.ts` | TreeWalker 高亮 |
| 状态管理 | `packages/client/src/stores/app.ts` | 全局状态 |
| 会话管理 | `packages/client/src/stores/chat.ts` | 聊天会话 |

---

## 二、对标研究来源

### 2.1 WorkBuddy（腾讯云代码助手）v4.22.5
> **研究方式**：拆包 macOS Electron 应用 `app.asar`，分析 54 万行 TypeScript 编译产物

| 参考功能 | WorkBuddy 源码路径 | SuperCrzy 实现 |
|----------|-------------------|---------------|
| **CopilotIcon 动态头像** | `cb-chat-ui/.../icons/copilot-icon.tsx` | 未实现（暂缓） |
| **MetaFold 过程折叠** | `cb-chat-ui/.../meta-fold/` | ✅ ProcessFold.vue |
| **Reasoning 深度思考框** | `cb-chat-ui/.../reasoning/reasoning.tsx` | ✅ ReasoningBox.vue |
| **WriteFileRenderer 写文件卡** | `cb-chat-ui/.../write-file/write-file-renderer.tsx` | ✅ WriteFileCard.vue |
| **ReadFileRenderer 读文件卡** | `cb-chat-ui/.../read-file/read-file-renderer.tsx` | ❌ 待实现 |
| **ExecuteCommandRenderer 命令卡** | `cb-chat-ui/.../execute-command/` | ❌ 待实现 |
| **WebSearchRenderer 搜索卡** | `cb-chat-ui/.../web-search/web-search-renderer.tsx` | ❌ 待实现 |
| **WebFetchRenderer 抓取卡** | `cb-chat-ui/.../web-fetch/` | ❌ 待实现 |
| **DeleteFileRenderer 删文件卡** | `cb-chat-ui/.../delete-files/` | ❌ 待实现 |
| **ListFileRenderer 文件列表卡** | `cb-chat-ui/.../list-file/` | ❌ 待实现 |
| **CompletionRenderer 完成卡** | `cb-chat-ui/.../completion/` | ✅ delivery_summary |
| **SandboxInterceptCard 权限弹窗** | `cb-chat-ui/.../sandbox-intercept-card.tsx` | ✅ ToolCallBlock pending |
| **ToolApprovalMenu 工具审批** | `cb-chat-ui/.../tool-approval-menu.tsx` | ✅ ToolCallBlock 确认面板 |
| **MessageFeedback 消息反馈** | `cb-chat-ui/.../message-feedback/` | ❌ 待实现 |
| **CheckpointActions 回退** | `cb-chat-ui/.../checkpoint-actions.tsx` | ❌ 待实现 |
| **ChatSearch 聊天搜索** | `cb-chat-ui/.../chat-search/` | ✅ useChatSearch + ChatSearchInput |
| **ContentBlock 内容模型** | `cb-chat-ui/.../content-block.ts` | ✅ types/index.ts |
| **Clipboard 剪贴板** | `cb-chat-ui/.../clipboard.ts` | ✅ 三层剪贴板策略 |
| **三段式布局** | `agent-ui/.../detail-panel-wrapper/` | ✅ MainLayout + DetailPanel |
| **DetailPanel Tab** | artifacts/files/changes/preview | ✅ DetailPanel 4 Tab |
| **FormatRelativeTime 时间** | `agent-ui/.../formatRelativeTime` | ✅ formatRelativeTime |
| **EventSource SSE** | `main/index.js` 自定义 EventSource 类 | ✅ agent-stream.ts |
| **X-Accel-Buffering 代理** | 无（Electron 不需要） | ✅ 手动设置响应头 |

### 2.2 Hermes UI
> **研究方式**：分析 `http://localhost:8648` 运行时 JS 打包文件 + `hermes-chat.yml` 对话快照

| 参考功能 | Hermes 源码关键发现 | SuperCrzy 实现 |
|----------|-------------------|---------------|
| **Socket.IO 通信** | `socket.io-client` + transports | ✅ 改为 EventSource |
| **message.delta 逐字推送** | `socket.on("message.delta")` 增量追加 | ✅ content_chunk 事件 |
| **reasoning.delta 思考流** | `socket.on("reasoning.delta")` 逐 token | ✅ thinking_chunk 事件 |
| **思考框自动折叠** | `<think>` XML 标签 + reasoning.available | ✅ ReasoningBox 自动折叠 |
| **工具状态管理** | tool.started → completed 生命周期 | ✅ tool_call/tool_result 事件 |
| **消息流式标记** | isStreaming 标志 + noteThinkingDelta | ✅ ContentBlock completed |
| **监控日志** | 日志+用量 Tab 按钮切换 | ✅ LogsView + UsageView |
| **模型详情表** | 按模型分组统计 | ✅ UsageView 模型详情 |
| **完整提示音** | Web Audio API + 振荡器 | ❌ |
| **会话恢复** | resume 事件 + Session 缓存 | ❌ |

### 2.3 自主创新设计
> 以下为 SuperCrzy 原创，未参考对标产品

| 功能 | 说明 |
|------|------|
| **SuperCrzy Logo** | Saira Stencil One 字体 + 渐变色 SC |
| **Craft/Plan/Ask 三模式** | 比 WorkBuddy 多 Ask 只读模式 |
| **自动会话命名** | 首发用户消息自动截取 40 字标题 |
| **暗色主题系统** | CSS 变量驱动的完整暗色主题 |
| **WeChat Bot 集成** | 微信机器人直接接入 Agent Loop |
| **Scheduler 定时任务** | 自动化任务调度引擎 |
| **Terminal WebSocket** | xterm.js 终端实时交互 |

---

## 三、已完成功能 (40项)

### 3.1 基础架构
| # | 功能 | 状态 |
|---|------|------|
| 1 | Koa2 + better-sqlite3 + TypeScript 后端 | ✅ |
| 2 | Vue3 + NaiveUI + Vite 前端 | ✅ |
| 3 | pnpm monorepo 结构 | ✅ |
| 4 | 暗色主题 + CSS 变量系统 | ✅ |
| 5 | 国际化 vue-i18n | ✅ |

### 3.2 布局与导航
| # | 功能 | 状态 |
|---|------|------|
| 6 | 三段式布局 (Sidebar + Chat + DetailPanel) | ✅ |
| 7 | 侧边栏可收缩 (52px ↔ 220px) | ✅ |
| 8 | 侧边栏集成会话列表 (替代独立 Session Panel) | ✅ |
| 9 | 右侧交付面板 (可收缩 0 ↔ 320px) | ✅ |
| 10 | 交付面板 4 Tab: 产物/文件/变更/预览 | ✅ |
| 11 | SuperCrzy Logo (Saira Stencil One 字体) | ✅ |

### 3.3 聊天核心
| # | 功能 | 状态 |
|---|------|------|
| 12 | Agent 多轮思考循环 (思考→行动→观察) | ✅ |
| 13 | EventSource SSE 流式输出 | ✅ |
| 14 | ContentBlock 统一消息模型 (text/reasoning/tool-call/file/skill-match/delivery-summary) | ✅ |
| 15 | 深度思考框 ReasoningBox (打字机 + 自动折叠) | ✅ |
| 16 | 过程折叠 ProcessFold (连续 reasoning+tool-call 折叠摘要) | ✅ |
| 17 | 用户消息右对齐 + Agent 左对齐 | ✅ |
| 18 | 消息区与输入框宽度对齐 | ✅ |
| 19 | 聊天搜索 (TreeWalker DOM 高亮) | ✅ |
| 20 | 消息一键复制 | ✅ |
| 21 | 代码块 Copy 按钮 + 语法高亮 | ✅ |

### 3.4 输入栏
| # | 功能 | 状态 |
|---|------|------|
| 22 | Craft/Plan/Ask 三模式按钮 | ✅ |
| 23 | 模型选择下拉 (DeepSeek 全系列分组) | ✅ |
| 24 | 技能选择下拉 | ✅ |
| 25 | 文件上传 (点击) | ✅ |
| 26 | 发送/停止按钮 | ✅ |

### 3.5 工具系统
| # | 功能 | 状态 |
|---|------|------|
| 27 | 12个内置工具 (web_search/web_fetch/file_read/write/shell_exec/memory等) | ✅ |
| 28 | 工具调用事件 (tool_call/tool_result/tool_duration) | ✅ |
| 29 | 文件创建检测 (file_created 事件) | ✅ |
| 30 | 权限确认面板 (shell_exec/file_write/file_delete → pending 状态) | ✅ |
| 31 | 写文件卡片 WriteFileCard (文件名+状态+行数) | ✅ |
| 32 | 交付摘要卡片 (仅在有文件产出时显示) | ✅ |

### 3.6 数据管理
| # | 功能 | 状态 |
|---|------|------|
| 33 | 会话持久化 (SQLite) | ✅ |
| 34 | 自动命名会话 (取第一条用户消息前40字) | ✅ |
| 35 | 人性化时间显示 (刚刚/N分钟前) | ✅ |
| 36 | 历史消息加载 (兼容 ContentBlock 旧格式) | ✅ |
| 37 | 记忆系统 (SQLite agent_memory 表 + 自动提取) | ✅ |
| 38 | 技能系统 (SKILL.md 文件 + 关键词匹配) | ✅ |

### 3.7 监控
| # | 功能 | 状态 |
|---|------|------|
| 39 | 系统日志 (真实数据 + 搜索 + 过滤 + 自动刷新) | ✅ |
| 40 | 用量统计 (4卡片 + 7日柱状图 + 模型详情表) | ✅ |

---

## 四、待完成任务 (22项)

### 4.1 通信层 (P0 — 阻塞)
| # | 问题 | 描述 | 难度 |
|---|------|------|------|
| 1 | 🚨 **打字机效果不工作** | 消息一次性出现，不是逐字打印。已切换到 EventSource SSE，仍待最终验证。Hermes用Socket.IO逐事件dispatch。 | 🔴高 |

### 4.2 工具渲染 (P1)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 2 | **Web搜索卡片** | web_search 结果用卡片式展示（标题+摘要+链接），参考 WorkBuddy WebSearchRenderer | 中 |
| 3 | **Web抓取卡片** | web_fetch 结果展示网页标题+内容摘要 | 低 |
| 4 | **读文件卡片** | file_read 展示文件路径+内容预览，参考 ReadFileRenderer | 中 |
| 5 | **执行命令卡片** | shell_exec 展示命令+终端输出+运行时间，参考 ExecuteCommandRenderer | 中 |
| 6 | **文件列表卡片** | list_file 展示目录树+文件数，参考 ListFileRenderer | 低 |
| 7 | **未知工具卡片** | 未识别的工具也用标准化卡片展示 | 低 |

### 4.3 消息交互 (P1)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 8 | **点赞/点踩反馈** | ThumbsUp + FeedbackDialog，参考 WorkBuddy 的8种反馈选项 | 低 |
| 9 | **消息复制 RequestId** | 复制会话/消息 ID 用于调试 | 低 |
| 10 | **消息重新生成** | RevertIcon + checkpoint 回退，重新调用 API | 中 |
| 11 | **消息编辑+重发** | 点击编辑消息内容，回车重新发送 | 低 |
| 12 | **消息更多菜单** | 复制RequestId + 删除这条消息 + 重新生成 | 低 |

### 4.4 输入栏升级 (P1)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 13 | **文件引用 @补全** | @文件名 自动补全文件路径，参考 WorkBuddy 的 FileAutocomplete | 中 |
| 14 | **粘贴/拖拽上传** | 支持 Ctrl+V 粘贴图片和拖拽文件到输入框 | 低 |
| 15 | **AI润色 Prompt** | 发送前用 AI 优化提示词 | 中 |

### 4.5 交付与文件 (P1)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 16 | **代码 Diff 预览** | 文件变更用 Monaco diff 视图对比 | 高 |
| 17 | **HTML 预览 Tab** | 交付面板预览 Tab 支持 iframe 加载 HTML | 低 |
| 18 | **制品自动归类** | 自动收集任务产出文件并在交付面板展示 | 中 |

### 4.6 权限与安全 (P2)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 19 | **自动确认倒计时** | pending 工具 1.5s 后自动确认 | 低 |
| 20 | **沙箱模式** | shell_exec 在沙箱内执行，越权需确认 | 高 |

### 4.7 多平台 (P2)
| # | 功能 | 描述 | 难度 |
|---|------|------|------|
| 21 | **WeChat Bot 流式** | 微信消息也支持打字机效果 | 中 |
| 22 | **WebSocket 方向** | 生产环境需 WS 兜底 (SSE 仅 GET) | 中 |

---

## 五、技术差距分析

### 5.1 与 WorkBuddy 的差距
| 方面 | WorkBuddy | SuperCrzy | 差距 |
|------|-----------|-----------|------|
| 通信 | Electron IPC 零延迟 | EventSource/WS | 🟡 技术选型不同 |
| 流式 | React IPC 逐事件 | Vue + EventSource | 🟡 待验证 |
| 工具渲染 | 12种专用渲染器 | 1种通用+1种文件 | 🔴 差11种 |
| 权限 | 沙箱拦截 + 确认弹窗 | pending 状态 + 确认按钮 | 🟢 基本对标 |
| Checkpoint | 每步自动保存 | 无 | 🔴 |
| 反馈 | 点赞/评分/反馈 | 无 | 🔴 |

### 5.2 与 Hermes UI 的差距
| 方面 | Hermes | SuperCrzy | 差距 |
|------|--------|-----------|------|
| 通信 | Socket.IO WebSocket | EventSource | 🟢 同为浏览器原生 |
| 思考展示 | 框内打字机 + 自动折叠 | 框内打字机 + 自动折叠 | ✅ 已对标 |
| 工具展示 | 专用卡片渲染 | 部分有 | 🟡 |
| 监控日志 | 实时筛选 + 搜索 | 实时筛选 + 搜索 | ✅ 已对标 |
| 用量统计 | 趋势图 + 模型详情 | 4卡片+柱状图+详情表 | ✅ 已对标 |

### 5.3 核心架构差异
- **WorkBuddy**: Electron 桌面应用，主进程 IPC 直连渲染进程，零中间层延迟
- **Hermes**: Web 应用，Socket.IO 全双工通信，事件队列天然逐条 dispatch
- **SuperCrzy**: Web 应用，Koa SSE + EventSource，绕过 Vite 代理直连

---

## 六、推荐执行路线

### 第一步：打通打字机 (P0) 🚨
- 验证 EventSource 在浏览器中逐事件渲染
- 如果仍不工作：安装 Socket.IO，完全对标 Hermes

### 第二步：补齐 7 个工具渲染器 (P1)
1. WebSearchCard (web_search → 卡片)
2. WebFetchCard (web_fetch → 卡片)
3. ReadFileCard (file_read → 卡片)
4. ExecuteCommandCard (shell_exec → 卡片)
5. ListFileCard (list_file → 卡片)
6. UnknownToolCard (兜底)

### 第三步：补齐消息交互 (P1)
1. 点赞/点踩 + 反馈
2. 消息重新生成
3. 消息编辑+重发

### 第四步：输入栏升级 (P1)
1. @文件引用补全
2. 粘贴/拖拽上传

### 第五步：交付深化 (P1)
1. 代码 Diff 预览
2. HTML iframe 预览

---

## 七、当前运行时

| 服务 | 脚本 | 端口 | 命令 |
|------|------|------|------|
| 后端 | `npx tsx src/app.ts` | 3000 | `cd packages/server && npm run dev` |
| 前端 | `npx vite --port 5173` | 5173 | `cd packages/client && npm run dev` |
| WS(备) | 同上 | 3001 | 自动启动 |
