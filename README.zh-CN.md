<p align="center">
  <img src="docs/images/banner.png" alt="Introducing SuperCrzy Bot — 自部署 AI Agent 平台" width="100%">
</p>

# SUPERCRZY BOT

<p align="center">
  <a href="https://supercrzy.com/bot"><img src="https://img.shields.io/badge/官网-supercrzy.com-5b6dff?style=for-the-badge" alt="官网"></a>
  <a href="https://github.com/SuperCrzy/Supercrzy-Bot/releases/latest"><img src="https://img.shields.io/badge/下载-macOS%20%7C%20Windows-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载"></a>
  <a href="https://github.com/SuperCrzy/Supercrzy-Bot/blob/main/LICENSE"><img src="https://img.shields.io/badge/许可证-MIT-green?style=for-the-badge" alt="许可证"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-English-blue?style=for-the-badge" alt="English"></a>
</p>

一个开箱即用的 **AI Agent 平台** —— 统一大脑 + Agent Loop + 多工具 + 多平台网关,原生对接 DeepSeek V4。

**自己的 key，自己的磁盘。** 没有订阅、不赚推理差价、不用注册账号 —— 应用直接连你已经在付费的模型厂商，整套代码 MIT 开源。

三样大多数自部署 agent 凑不齐的东西：**完整 Web UI**（15 个页面，不是终端）、**跨厂商交叉质检**（不让一个模型给自己打分）、**无需 API key 的内容源**。

<p align="center">
  <img src="docs/images/demo.gif" alt="SuperCrzy Bot 实际运行 —— App 内真实录屏（一段真实会话的最后 8 秒）" width="860" />
</p>

<p align="center">
  <em>App 内真实录屏 —— 不是示意图。</em>
</p>

<p align="center">
  <img src="docs/images/app-models.png" alt="模型管理：13 个厂商预设 + 本地 Ollama" width="46%" />
  <img src="docs/images/app-news.png" alt="应用内置的 AI 资讯看板，读取自有内容源" width="46%" />
</p>

## 快速安装

**macOS（Apple Silicon）** —— [下载 .dmg](https://github.com/SuperCrzy/Supercrzy-Bot/releases/latest)，打开后把应用拖进「应用程序」。首次启动：右键 → 打开（构建未签名）。

**Windows（x64）** —— [下载 .exe 安装包](https://github.com/SuperCrzy/Supercrzy-Bot/releases/latest)，直接运行。安装包未签名，SmartScreen 会拦一次，选「仍要运行」即可。

**从源码** —— macOS / Linux / WSL2（需要 Node 22.x + pnpm 10.x）：

```bash
git clone https://github.com/SuperCrzy/Supercrzy-Bot.git
cd Supercrzy-Bot
./start.sh          # 首次会装依赖 + 构建（3-8 分钟），然后启动并打开浏览器
```

> `start.sh` 不需要任何配置：自动校验 Node 与 pnpm、缺 `.env` 时自动创建、构建前端并打开应用。停止用 `./start.sh stop`。
> 想让 `supercrzy` 命令在任意目录可用？之后跑 `npm link`。

然后到应用里[填模型 key](#-海外模型渠道) —— DeepSeek、OpenRouter、OpenAI、Anthropic、Gemini、xAI、Mistral、通义千问，或本地 Ollama。

## ✨ 功能亮点

**它把活干完，还让你看见过程。** 下面标 ★ 的三条，是同行很少同时做到的。

- **Agent Loop（Agent 循环）** —— 多轮推理 + 44 个工具：文件、Shell、网络、记忆、技能。每一步都在时间线上实时渲染，可回放、**可从检查点分支续跑**。
- ★ **完整 Web UI，不是终端** —— 15 个页面：带执行时间线的对话、含编辑器与文件浏览的工作台、模型、记忆、技能、网关、日志、用量。同一个 server 也提供 CLI，**用界面是选择，不是强制**。
- **真终端，不是一次性 Shell** —— 六个终端工具让会话保持存活：后台跑 dev server、运行交互式程序、增量读输出、发 SIGINT 中断。和「执行完就结束」的 `shell_exec` 是两回事。
- **它造的东西你能直接看见** —— `draw_diagram` 输出 SVG 在对话里直接渲染；`generate_image` 生成图片；`make_article` 丢一个 URL 或 YouTube 链接进去，返回一篇配好图的成品；`video_edit` 裁剪与拼接音视频。
- ★ **带出处的深度研究** —— `deep_research` 递归搜索、逐层加深度，输出多页报告并附 Sources 来源列表。`news_search` 读本项目自己的 RSS 源，**无 API key、无限流**。
- **能看见的计划，而且会自查** —— `create_plan` 先拆步骤再动手，前端以计划卡片跟踪进度；`get_goal` 让 Agent 在中途发现自己跑偏了原始需求。
- **它知道自己刚写的代码有问题** —— `lint_file` 在写完文件后跑一遍静态检查：危险模式、凭据泄露、括号不配对。
- ★ **不让一个模型给自己打分** —— 超级协作平台让执行、质检、会诊跑在**不同厂商的模型**上（DeepSeek 执行、Kimi 质检、GPT 进议院）。各阶段进度落 SQLite，进程重启不丢。
- **Playbook 经验库** —— 任务结束写一份复盘；下一个类似任务开始前，把经验注入进去。
- **技能是一条供应链** —— 32 个内置技能在市场里按需安装，另有 browse.sh 的 461 个浏览器自动化技能，以及 OpenAI / Anthropic / Hugging Face / NVIDIA 的官方技能仓库。**技能还会自己写、自己修**。
- **长期记忆** —— 跨会话提取事实，注入时按权重排序，定期去重合并。提取走单一串行 worker，忙一天也不会变成限流事故。
- **电脑操作（Computer Use）** —— 截屏、点击、输入、组合键、滚动、打开应用。截屏以图片回传给模型，**所以它看得见自己点击后的结果**。三道门：每次调用确认、仅「完全访问」会话可用、macOS 需授予录屏与辅助功能。
- **八个渠道，同一份记忆** —— 微信、企微、钉钉、飞书、QQ、Telegram、Discord、Slack，与桌面端共享同一套会话、技能与记忆。
- **默认安全** —— 敏感工具先确认、危险命令由命令级分类器拦截、Shell 访问三层沙箱、文件读写限定在工作区白名单内。

## 🔧 工程说明

下面这些是"真在自己机器上跑 agent"才会碰到的问题。每条都标注了所在文件。

**Shell 权限做在三层里。** 命令黑名单兜住极端情况 —— 删根、`sudo`、fork 炸弹、下载即执行。第二层用纯 Node 扫描命令里的危险路径，任何环境都能用。macOS 上再加第三层：内核级 `sandbox-exec`（SBPL，等价 Linux Landlock），只放行项目仓库与 `/tmp`，**禁止用户主目录下一切读写**：

```
(deny file-read*  (subpath "$HOME"))
(deny file-write* (subpath "$HOME"))
(allow file-read*  (subpath "$PROJECT_ROOT"))
```

仓库内的凭据文件另有字面量兜底；`sandbox-exec` 不可用（CI、嵌套容器）时**自动降级而不是拒绝服务**。*`services/sandbox.ts`*

**流式输出有背压控制和断连保护。** 直觉写法 `res.write(chunk)` 有两个坑，现象都是"后端没事，界面不动"：缓冲满时返回 `false`，慢客户端会让事件堆在服务端内存里，而后端以为自己很健康；断开后继续写会抛错，而因为响应是从 Koa 摘出来的，这个错会变成**未捕获异常，把整个后端带下去**。两件事收口在一条受保护的写路径上，计数暴露在健康检查接口 —— **"卡不卡"有数字，不靠猜**。*`services/sse-health.ts`*

**卡顿用客观指标判定，不靠肉眼。** 此前两次排查对同一现象给出相反结论，就是因为没有指标能定案。现在每秒采样事件循环延迟并重置，保留 60 秒滚动窗口 —— 因为 `perf_hooks.monitorEventLoopDelay` 给的是**累计**直方图，长 uptime 下尖峰会被摊平。延迟正常而客户端不动，说明问题在传输层，**不必再翻后端**。*`services/event-loop-lag.ts`*

**技能会自己写、自己修。** 复杂任务完成后自动提炼成标准 `SKILL.md`；被用过但失败的技能会自动打补丁。Playbook 和技能库是**刻意分开的两套学习面**：一个存注入提示词的一句话经验，一个存按需加载的可复用步骤工作流。*`services/skill-evolve.ts`*

**记忆提取刻意串行。** 单一后台 worker + FIFO 队列，**最大并发 1**。每个会话每一轮都开一个 LLM 提取调用，就是被限流和账单吓一跳的路径；串行天然节流。读写构成闭环：turn 前语义预取，turn 后同步。*`services/memory-worker.ts`*

**搜索是插件链，不是条件分支梯子。** `web_search` 原本是 5 层 `if` 嵌套。现在按优先级遍历 provider 接口 —— Tavily、Serper、SearXNG、DeepSeek、Bing —— 取第一个非空结果。新增引擎 = 实现接口 + push 进数组。*`services/search-providers.ts`*

**内容源不需要 API key。** 资讯检索直接读 `supercrzy.com/feed.xml` —— 标准 RSS 2.0、实时、无 key、零成本、无限流。Agent 消化的是项目自己的编辑产出，这就是本产品的闭环所在。*`services/supercrzy-feed.ts`*

## 🌍 海外模型渠道

模型页 (/models) 内置 10 个 provider 预设,支持 OpenAI 兼容协议:

| 渠道 | 说明 |
|------|------|
| **OpenRouter**(推荐) | **一个 Key 聚合所有海外模型**——Claude、GPT、Gemini、Grok、Mistral 等 200+ 模型,OpenAI 兼容,`https://openrouter.ai/api/v1` |
| **OpenAI** | GPT-4o 等,`https://api.openai.com/v1` |
| **xAI Grok** | Grok 系列,`https://api.x.ai/v1` |
| **Mistral** | Mistral 系列,`https://api.mistral.ai/v1` |
| **Meta Llama** | Llama 系列,经 Groq 免费托管,`https://api.groq.com/openai/v1` |
| **NVIDIA NIM** | NVIDIA 官方推理端点,`https://integrate.api.nvidia.com/v1` |
| **阿里 Qwen** | 通义千问官方兼容端点,`https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Anthropic / Gemini | 原生 API 协议不同,建议经 OpenRouter 使用 Claude / Gemini 模型 |

用法:模型页点击渠道 → 填 API Key(可改 baseUrl)→ 点「识别可用模型」自动列出该 Key 可用模型 → 点选使用。API Key 支持多 provider 并存,随时切换。

### 本地模型(Ollama)

内置 **Ollama (本地)** 渠道:安装 [Ollama](https://ollama.com) 并 `ollama pull llama3.1` 后,模型页选 Ollama → 点「识别可用模型」→ 自动列出本地已拉取的模型(`llama3.1:8b` 等),点选即用。API Key 留空即可(本地无需鉴权)。

## 🚀 安装细节

### 方式一:终端一行命令(首次使用,无需任何配置)

```bash
git clone https://github.com/SuperCrzy/Supercrzy-Bot.git
cd Supercrzy-Bot
./start.sh          # 自动检查环境 → 装依赖 → 构建前端 → 启动 → 自动打开浏览器
```


> `./start.sh` **无需任何配置** —— 自动校验 Node/pnpm、缺 `.env` 时自动创建、构建前端、启动服务并打开浏览器。停止：`./start.sh stop`

### 方式二:双击启动(不碰终端,最简单)

> **macOS**:
> 1. 双击 **`scripts/install.command`**（安装器）→ 生成 `SUPERCRZY BOT.app`,并在桌面创建「SUPERCRZY BOT」图标
> 2. 双击桌面图标 → 浏览器自动打开 UI
> 3. 也可不安装,直接双击项目里的 **`SUPERCRZY BOT.command`**
> 首次若被系统拦截,右键 → 打开即可。
> (`SUPERCRZY BOT.app` 是**生成物**,不随仓库分发;需放在项目根目录与 start.sh 同级,移动项目后重新运行安装器)
>
> **Windows**:双击 **`start.bat`**,浏览器会自动打开 UI。
>
> **Linux**:先跑一次 **`./scripts/install-linux.sh`** —— 它会写一个 `.desktop` 条目到应用菜单和桌面。之后像普通应用一样启动「SUPERCRZY BOT」。
>
> Linux/终端:执行 `./start.sh`。

### 方式三(可选):装成全局命令

clone 之后（任意方式均可），可以让 `supercrzy` 在**任意目录**使用：

```bash
npm link                   # 或：pnpm setup && pnpm link --global

supercrzy                  # 启动（等价 ./start.sh）
supercrzy dev              # 开发模式（server + client，5173 热更新）
supercrzy cli              # 终端对话
supercrzy stop             # 停止后台服务
supercrzy status           # 查看版本与服务状态
supercrzy install          # 在桌面创建启动图标（macOS）
```

> 这是**便利选项，不是必需** —— `./start.sh` 本身已经做完所有事。
> `supercrzy web` / `stop` / `install` 一律转发到同一套 `start.sh` / `install.command`，
> 两种方式行为完全一致。

### 方式四:手动(开发模式)

```bash
# 1. 安装依赖(需 Node 22.x 与 pnpm 10.x,详见 package.json 的 engines)
pnpm install

# 2. 配置(二选一)
cp .env.example .env        # 然后编辑 .env 填 OPENAI_KEY=sk-...
# 或跳过此步,启动后在 Web UI → 模型 (/models) 页配置 API Key(推荐,免重启)

# 3. 启动(生产单进程: http://localhost:3000)
pnpm --filter @supercrzy/server start
# 或开发模式(热更新): pnpm dev → http://localhost:5173
```

启动后浏览器打开 **http://localhost:3000**(一个端口同时服务页面 + API,无需额外前端进程):
- 首次使用,**首页会提示"配置 API Key"**,点击跳转到 **模型页 (/models)** 配置提供商与 Key,即可开聊
- 数据库自动初始化,无需手动建表

### 其他命令

| 命令 | 说明 |
|------|------|
| `SUPERCRZY BOT.app` | 双击启动(macOS 桌面 App)——**生成物**,由安装器生成,不随仓库分发 |
| `SUPERCRZY BOT.command` | 双击启动(macOS 终端入口) |
| `start.bat` | 双击启动(Windows 一键脚本) |
| `./start.sh` | 一键启动(生产模式,自动开浏览器) |
| `pnpm dev` | 开发模式(热更新,前端 5173 + 后端 3000) |
| `pnpm cli` | 终端对话模式(CLI 优先!) |
| `pnpm build` | 生产构建(输出到 client/dist,由后端静态托管) |
| `./scripts/install.command` | 安装器:在桌面创建启动图标 |
| `./scripts/make-app.sh` | 重新生成 macOS 桌面 App(更新 logo 后执行) |
| `pnpm test` | 运行全部测试(服务端 + 客户端) |

## 🎮 CLI 模式

```bash
pnpm cli
```
直接在终端与 Agent 对话,支持流式输出与工具调用,适合服务器/SSH 环境。

## ⚙️ 环境变量(.env)

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 后端端口 | `3000` |
| `OPENAI_KEY` | 提供商 API Key(**服务端实际读取的变量**) | - |
| `DEEPSEEK_API_KEY` | 遗留别名 —— 仅被搜索/工具层当作最后兜底读取 | - |
| `DEEPSEEK_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `CORS_ORIGINS` | CORS 白名单(逗号分隔) | 仅 localhost |
| `API_TOKEN` | 可选:非本地 API 请求的 Bearer 令牌 | 空(不启用) |
| `TUNNEL_ENABLED` | 开启内网穿透(默认关闭,纯本地) | `false` |
| `SUPERCRZY_TELEMETRY` | 匿名使用统计 — 设 `0` 关闭 | `1`(启用) |

### 匿名使用统计

服务启动时发**一次**极小请求,用于了解安装量与版本分布。只含四个字段,别无其他:

```json
{ "iid": "<随机 UUID>", "version": "<应用版本>", "platform": "darwin 27.0.0", "firstRun": true }
```

- `iid` 是**随机生成的 UUID**,存在本地数据库。不基于硬件、网卡 MAC、主机名或账号,
  无法反推到个人。
- **绝不上报**:对话内容、提示词、文件路径、API Key、模型名、记忆内容。
- **永久关闭**:`.env` 里设 `SUPERCRZY_TELEMETRY=0`,或执行:
  ```bash
  sqlite3 ~/.supercrzy/data/supercrzy.db \
    "INSERT INTO settings(key,value,updated_at) VALUES('telemetry.enabled','false',datetime('now')) \
     ON CONFLICT(key) DO UPDATE SET value='false'"
  ```
- 失败静默且单次运行内不重试 —— 离线对使用零影响。

## 🏗️ 架构

```
Supercrzy-Bot/
├── packages/
│   ├── client/          # Vue3 + NaiveUI + Monaco 前端
│   │   └── src/views/   # 聊天/工作台/技能/记忆/模型/用量等页面
│   └── server/          # Koa + better-sqlite3 后端
│       └── src/
│           ├── routes/  # API 路由(chat/settings/session/memory/gateway...)
│           ├── services/ # Agent 循环、工具、终端、网关
│           └── gateway/  # 微信/QQ 平台适配
├── docs/                # 公开文档目录(docs/internal/ 仅本地工作区,不随仓库分发)
└── start.sh             # 一键启动
```

- **聊天主通道**:SSE 流式(`POST /api/chat/agent`)
- **终端**:WebSocket(`/ws/terminal`)
- **存储**:SQLite(better-sqlite3,自动初始化)

## 🔒 安全说明

- 敏感工具(执行命令/写删文件)在 UI **先确认后执行**,120 秒未确认自动拒绝
- Shell 危险命令(删根目录、sudo、dd、fork 炸弹、下载即执行等)**无条件拦截**
- 文件预览仅限工作区白名单,凭据/数据库类文件禁止读取
- CORS 默认仅本地;部署到公网请配置 `API_TOKEN` 与 `CORS_ORIGINS`

## 📄 License

MIT License — 详见 [LICENSE](LICENSE)。第三方组件(随附二进制、技能库、字体)适用各自的
许可条款,详见 [NOTICE](NOTICE)。

## 🔐 安全披露

漏洞请走私下渠道报告,详见 [SECURITY.md](SECURITY.md)。
