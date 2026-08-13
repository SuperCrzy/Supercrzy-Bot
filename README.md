# SUPERCRZY BOT

一个开箱即用的 **AI Agent 平台** —— 统一大脑 + Agent Loop + 多工具 + 多平台网关,原生对接 DeepSeek V4。

## ✨ 功能亮点

- **Agent Loop**:多轮思考 + 工具执行(文件操作、Shell、网络搜索、网页抓取、记忆、技能)
- **Agent 执行时间线**:每一步思考/工具调用实时可视化,历史可回放、**可分支续跑**
- **经验库(Playbook)**:任务结束自动复盘,同类任务自动注入历史经验,越用越聪明
- **幽灵模式**:感知工作区文件变化,低打扰地给出代码介入建议
- **技能系统**:内置技能 + 自动匹配 + 支持从 GitHub 安装第三方技能
- **长期记忆**:自动提取并持久化重要信息,跨会话生效
- **工作台**:文件浏览器 + 终端 + 代码编辑器一站式
- **多平台网关**:Web / 微信 / QQ 共享同一记忆、会话、技能库
- **完整模型库**:DeepSeek V1~V4 / R1 全系列 18+ 模型目录
- **安全默认**:敏感工具"先确认后执行"、危险命令黑名单、CORS 白名单、可选 API 令牌

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

## 🚀 快速开始(3 分钟)

### 方式一:一键脚本(推荐)

```bash
git clone <你的仓库地址>
cd supercrzy-agent
./start.sh          # 自动检查环境 → 装依赖 → 生成 .env → 启动
```

### 方式二:手动

```bash
# 1. 安装依赖(需 Node >= 20 与 pnpm)
pnpm install

# 2. 配置(二选一)
cp .env.example .env        # 然后编辑 .env 填 DEEPSEEK_API_KEY=sk-...
# 或跳过此步,启动后在 Web UI → 模型 (/models) 页配置 API Key(推荐,免重启)

# 3. 启动
pnpm dev
```

启动后打开 **http://localhost:5173**:
- 首次使用,**首页会提示"配置 API Key"**,点击跳转到 **模型页 (/models)** 配置提供商与 Key,即可开聊
- 数据库自动初始化,无需手动建表

### 其他命令

| 命令 | 说明 |
|------|------|
| `./start.sh` | 一键启动(Web UI + API) |
| `pnpm dev` | 启动 Web UI + API |
| `pnpm cli` | 终端对话模式(CLI 优先!) |
| `pnpm build` | 生产构建(输出到 client/dist,由后端静态托管) |
| `pnpm test` | 运行测试(服务端 37 + 客户端 9) |

## 🎮 CLI 模式

```bash
pnpm cli
```
直接在终端与 Agent 对话,支持流式输出与工具调用,适合服务器/SSH 环境。

## ⚙️ 环境变量(.env)

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 后端端口 | `3000` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key(兜底;UI 模型页配置后优先) | - |
| `DEEPSEEK_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `CORS_ORIGINS` | CORS 白名单(逗号分隔) | 仅 localhost |
| `API_TOKEN` | 可选:非本地 API 请求的 Bearer 令牌 | 空(不启用) |
| `TUNNEL_ENABLED` | 开启内网穿透(默认关闭,纯本地) | `false` |

## 🏗️ 架构

```
supercrzy-agent/
├── packages/
│   ├── client/          # Vue3 + NaiveUI + Monaco 前端
│   │   └── src/views/   # 聊天/工作台/技能/记忆/模型/用量等页面
│   └── server/          # Koa + better-sqlite3 后端
│       └── src/
│           ├── routes/  # API 路由(chat/settings/session/memory/gateway...)
│           ├── services/ # Agent 循环、工具、终端、网关
│           └── gateway/  # 微信/QQ 平台适配
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

MIT License
