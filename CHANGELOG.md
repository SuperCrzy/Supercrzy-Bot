# CHANGELOG

> SUPERCRZY BOT 版本更新记录。最新版本在顶部，历史版本完整保留。
> 此文件为官网更新日志页的数据母版；应用内弹窗仅展示当前版本。
>
> **发布节奏（2026-10-18 起）：每周发布一版。**
> 周期内累积的修复与新功能统一进本文件对应版本；版本号按 `MAJOR.MINOR.PATCH` 递增，
> 补丁类修复走 PATCH，含新能力走 MINOR。

---

## v0.4.1 (2026-10-18) — 启动器可靠性 + AI NEWS 图片 + 模型选择器

### 修复

**启动器（桌面快捷方式 / `start.sh`）**
- 修复 macOS 报错「"SUPERCRZY BOT.command" 无法打开，因为不允许在"终端"中打开文稿」：
  根因是 `do script` 命令串里出现 `./start.sh` 相对引用，被 Automation 推断成"要打开的文稿"。
  改为绝对路径 + `bash -lc`，不再触发 TCC 拦截
- 修复新用户双击桌面图标后**没有终端窗口、看不到任何启动过程**（此前为绕 TCC 把 Terminal 整个移除）
- 修复浏览器打开时机：此前把 `open` 放在 `/api/health` 就绪之后，而 `app.listen()`
  在所有初始化完成（实测 40–55s）才执行 ⇒ 点完近一分钟才弹浏览器。
  现在依赖检查完即刻打开（实测 **4.3s**），健康检查降级为终端提示、不阻塞
- 修复**点击一次打开两个浏览器窗口**：`start.sh` 的两条路径（正常启动 / 服务已在运行复用）
  与 applet 兜底各自都会 `open`。改为标记文件 + 轮询协调，三条路径均只打开一次
- 修复服务已在运行时**误把别的副本当成自己**：判活增加「监听者 cwd 是否属于本仓库」校验，
  不再出现 B 副本显示 A 副本界面的情况
- 修复孤儿进程（父进程退出、子进程仍占端口）导致「拒绝启动」，改为识别真实监听者
- 新增：启动成功后自动关闭终端窗口（按 tty 精确匹配，不误关其他窗口；服务未就绪时保留窗口）
- 新增：新用户跑一次 `./start.sh` 即自动生成桌面 App 与桌面图标，无需另跑安装器
- 修复 `install.command` 输出乱码（`$LINK_NAME` 紧贴全角括号被吞字符）
- 桌面图标统一为安装版 App 同一张图（`build/icon.icns`，1024 源、十档齐全），不再由 512 图放大

**AI NEWS 图片**
- 修复图片频繁加载失败、且加载缓慢。实测外网串行拉同一张 772 KB 图 6 次，
  其中 2 次返回 `HTTP 200` 但字节不足（620 KB / 751 KB）并超时；
  而服务器本机 8 次全部字节一致 ⇒ 抖动发生在公网链路，但后端三项防护全缺
- 新增磁盘缓存（`~/.supercrzy/cache/news-images/`，URL+宽度 哈希，TTL 7 天）+ 进程内 LRU。
  实测第二次起 **0.003s**（原 5.86s，约 2000 倍）
- 新增重试：单次超时 8s × 最多 3 次，指数退避，4xx 不重试
- 新增完整性校验：比对 `Content-Length`，短读视为失败并重试，且不写入缓存
  （此前 `arrayBuffer()` 在连接提前关闭时返回不完整缓冲且不抛错，半张图会被当成功返回）
- 失败降级为 1×1 透明 PNG 占位图，不再返回 502 裂图

**模型选择器**
- 修复欢迎页下拉框选中短模型名（如 `V4 Flash (DeepSeek)`）时，文字后出现 60–70px 大空隙。
  根因：原生 `<select>` 宽度由最长 option 决定，叠加 `max-width: 180px`。
  新增 `ModelSelect` 组件，宽度随当前文字自适应、右侧间距固定，下拉面板按内容自适应宽度

### Features
- Weekly release cadence starting 2026-10-18

### 修复（英文摘要）
- Launcher: fixed macOS TCC "cannot open document in Terminal" error; restored terminal window;
  browser now opens at 4.3s instead of waiting for full init; eliminated double browser launch;
  detects when port 3000 is held by another clone; auto-closes the terminal window after startup;
  new users get a desktop icon from a single `./start.sh` run
- AI NEWS images: added disk+memory cache, retry with exponential backoff, `Content-Length`
  integrity check, and placeholder fallback (cache hit: 0.003s vs 5.86s)
- Model picker: new `ModelSelect` component, width adapts to the selected label instead of the
  longest option

---

## v0.3.0 (2026-08-13) — 多平台网关 + 角色化 Agent

### 新功能
- 接入 8 个消息渠道：微信 / QQ / 企业微信 / 钉钉 / 飞书 / Telegram / Discord / Slack，全部支持长连接免公网回调
- 角色化 Agent：任务按类型自动分发到设计 / 开发 / 数据分析 / 文案专家，各角色独立系统提示与记忆
- 任务结果主动推送：定时任务完成后推送到指定渠道（含全部渠道选项）
- 渠道感知输出：同一回复按平台能力自适应格式化（Markdown / 纯文本）
- 网关功能区完善：凭据脱敏、错误原因持久化、状态轮询、开发中渠道诚实标注
- 聊天区改为气泡布局：用户消息右侧品牌色气泡、AI 消息左侧浅色气泡
- 统一品牌视觉：官方 LOGO 全站应用（欢迎区 / 消息头像），浅色纯白、深色纯黑主题背景
- 版本更新：更新日志弹窗 + 一键更新（提交改动 → 拉取 → 装依赖 → 构建）
- 一键启动产品化：macOS 桌面 App（品牌图标）/ Windows start.bat / 双击即用 + 自动开浏览器

### 修复
- 修复 vite 开发代理缓冲 SSE 导致流式输出一次性到达的问题
- 修复历史对话 Markdown 表格不渲染（双重 JSON 序列化兼容）
- 修复 Agent 收尾空转（推理模型纯思考轮误判为空回复）

### Features
- 8 messaging channels: WeChat / QQ / WeCom / DingTalk / Feishu / Telegram / Discord / Slack, all via long-connection without public webhooks
- Role-based agents: tasks auto-routed to design / dev / data / copywriting experts, each with dedicated system prompt and memory
- Proactive result push: scheduled task results delivered to chosen channels (including "all channels")
- Channel-aware output: replies auto-formatted per platform capability (Markdown / plain text)
- Gateway improvements: credential masking, error persistence, status polling, honest "in development" labels
- Chat UI switched to bubble layout: user messages as brand-colored bubbles on the right, AI on the left
- Unified branding: official logo across the app, pure-white / pure-black theme backgrounds
- Version updates: changelog modal + one-click update (commit → pull → install → build)
- One-click launch: macOS desktop app (branded icon) / Windows start.bat / double-click to run + auto-open browser

### Fixes
- Fixed vite dev proxy buffering SSE, causing streamed output to arrive all at once
- Fixed history chat Markdown tables not rendering (double JSON serialization compatibility)
- Fixed agent tail-spinning (reasoning-only rounds misread as empty replies)

---

## v0.2.0 (2026-08-12) — 开源准备 + 安全加固

### 新功能
- 全仓库敏感信息清除，git 历史重写，开源审计通过
- 引入技能系统：技能库管理、GitHub 技能安装、触发词自动匹配
- Agent 经验复盘（Playbook）：同类任务自动注入历史经验
- 幽灵模式：工作区文件变化自动监控

### 修复
- shell_exec 危险命令黑名单（删根 / sudo / fork 炸弹 / 下载即执行）
- 文件预览路径穿越防护、CORS 白名单、可选 API Token 鉴权
- xlsx 安全漏洞修复（升级 exceljs）

### Features
- Cleared sensitive info repo-wide, rewrote git history, open-source audit passed
- Skills system: skill library, GitHub skill install, keyword auto-matching
- Agent playbook: auto-injects lessons from similar past tasks
- Ghost mode: automatic workspace file-change monitoring

### Fixes
- shell_exec dangerous command blacklist (rm -rf /, sudo, fork bombs, download-and-execute)
- File preview path traversal protection, CORS allowlist, optional API token auth
- xlsx vulnerability fix (upgraded to exceljs)

---

## v0.1.0 (2026-05) — 初始版本

### 新功能
- SUPERCRZY BOT 核心对话能力（Web / 微信 / QQ 三通道统一大脑）
- Agent 循环：8+ 工具（文件 / Shell / 网页 / 记忆 / 技能）
- 会话历史、记忆管理、模型多提供商配置
- 任务系统、自动化定时任务、用量统计

### Features
- SUPERCRZY BOT core chat (unified brain across Web / WeChat / QQ)
- Agent loop with 8+ tools (files / shell / web / memory / skills)
- Chat history, memory management, multi-provider model config
- Tasks, scheduled automations, usage stats
