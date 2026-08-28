# SUPERCRZY BOT

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[中文版](README.zh-CN.md)

A ready-to-run **AI Agent platform** — unified brain + Agent Loop + multi-tool + multi-platform gateway, natively wired to DeepSeek V4 with support for 200+ models via OpenAI-compatible providers.

## ✨ Highlights

- **Agent Loop**: multi-turn reasoning + tool execution (file ops, shell, web search, web fetch, memory, skills)
- **Execution timeline**: every step of reasoning/tool calls visualized live, replayable, **branchable and resumable**
- **Playbook (experience base)**: auto retrospective after each task; similar tasks reuse past experience — the agent gets smarter over time
- **Ghost mode**: watches workspace file changes and proactively suggests low-intrusion code interventions
- **Skill system**: built-in skills + automatic matching + install third-party skills from GitHub
- **Long-term memory**: auto-extracts and persists important facts across sessions
- **Workspace**: file browser + terminal + code editor in one place
- **Multi-platform gateway**: Web / WeChat / QQ share the same memory, sessions and skill library
- **Full model catalog**: DeepSeek V1~V4 / R1 series, 18+ models
- **Secure by default**: sensitive tools require confirmation before execution, dangerous command blacklist, CORS whitelist, optional API token

## 🌍 Model Providers

The Models page (`/models`) ships with 10 provider presets supporting the OpenAI-compatible protocol:

| Provider | Notes |
|------|------|
| **OpenRouter** (recommended) | **One key for 200+ models** — Claude, GPT, Gemini, Grok, Mistral and more. `https://openrouter.ai/api/v1` |
| **OpenAI** | GPT-4o etc. `https://api.openai.com/v1` |
| **xAI Grok** | Grok series. `https://api.x.ai/v1` |
| **Mistral** | Mistral series. `https://api.mistral.ai/v1` |
| **Meta Llama** | Llama series via Groq free tier. `https://api.groq.com/openai/v1` |
| **NVIDIA NIM** | NVIDIA official inference endpoints. `https://integrate.api.nvidia.com/v1` |
| **Alibaba Qwen** | Qwen official compatible endpoint. `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Anthropic / Gemini | Native APIs differ; use them through OpenRouter |

Usage: open the Models page → click a provider → paste your API key (baseUrl editable) → click "Discover models" to list models available for that key → pick one. Keys from multiple providers can coexist and you can switch anytime.

### Local models (Ollama)

A built-in **Ollama (local)** provider is included: install [Ollama](https://ollama.com), `ollama pull llama3.1`, then on the Models page pick Ollama → "Discover models" → the locally pulled models (`llama3.1:8b` etc.) are listed automatically. Leave the API key empty (no auth needed locally).

## 🚀 Quick Start (3 minutes)

### Option 1: double-click launcher (easiest)

> **macOS**:
> 1. Double-click **`scripts/install.command`** — a "SUPERCRZY BOT" icon appears on your Desktop
> 2. Double-click the desktop icon → the UI opens in your browser
> 3. Or double-click **`SUPERCRZY BOT.app`** (branded icon) or **`SUPERCRZY BOT.command`** inside the project
> If blocked on first run: right-click → Open.
> (Keep the app at the project root, next to start.sh; re-run the installer after moving the project)
>
> **Windows**: double-click **`start.bat`** — the UI opens in your browser.
>
> Linux/terminal: run `./start.sh`.

### Option 2: one-liner script

```bash
git clone <your-repo-url>
cd supercrzy-agent
./start.sh          # checks env → installs deps → builds frontend → starts → opens browser
```

### Option 3: manual (development)

```bash
# 1. Install dependencies (Node >= 20 and pnpm required)
pnpm install

# 2. Configure (choose one)
cp .env.example .env        # edit .env, fill DEEPSEEK_API_KEY=sk-...
# or skip this — after startup, configure your key in Web UI → Models (/models) page (recommended, no restart)

# 3. Start (production single process: http://localhost:3000)
pnpm --filter @supercrzy/server start
# or dev mode (hot reload): pnpm dev → http://localhost:5173
```

Open **http://localhost:3000** (one port serves both the page and the API — no extra frontend process):
- On first launch, the home page prompts you to **configure an API key**; click through to the Models page (`/models`)
- The database initializes automatically — no manual table setup

### Other commands

| Command | Description |
|------|------|
| `SUPERCRZY BOT.app` | double-click launch (macOS desktop app, branded icon) |
| `SUPERCRZY BOT.command` | double-click launch (macOS terminal entry) |
| `start.bat` | double-click launch (Windows one-click script) |
| `./start.sh` | one-click start (production mode, opens browser) |
| `pnpm dev` | dev mode (hot reload, frontend 5173 + backend 3000) |
| `pnpm cli` | terminal chat mode (CLI-first!) |
| `pnpm build` | production build (outputs to client/dist, served statically by backend) |
| `./scripts/install.command` | installer: creates a launch icon on the Desktop |
| `./scripts/make-app.sh` | regenerate the macOS desktop app (run after updating the logo) |
| `pnpm test` | run tests (server 37 + client 9) |

## 🎮 CLI Mode

```bash
pnpm cli
```
Chat with the agent directly in the terminal — streaming output and tool calls supported. Great for server/SSH environments.

## ⚙️ Environment Variables (.env)

| Variable | Description | Default |
|------|------|------|
| `PORT` | backend port | `3000` |
| `DEEPSEEK_API_KEY` | DeepSeek API key (fallback; takes precedence when configured in the UI Models page) | - |
| `DEEPSEEK_BASE_URL` | API base URL | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | default model | `deepseek-v4-pro` |
| `CORS_ORIGINS` | CORS whitelist (comma-separated) | localhost only |
| `API_TOKEN` | optional Bearer token for non-local API requests | empty (disabled) |
| `TUNNEL_ENABLED` | enable tunneling (default off, fully local) | `false` |

## 🏗️ Architecture

```
supercrzy-agent/
├── packages/
│   ├── client/          # Vue3 + NaiveUI + Monaco frontend
│   │   └── src/views/   # chat / workspace / skills / memory / models / usage pages
│   └── server/          # Koa + better-sqlite3 backend
│       └── src/
│           ├── routes/  # API routes (chat/settings/session/memory/gateway...)
│           ├── services/ # agent loop, tools, terminal, gateway
│           └── gateway/  # WeChat / QQ platform adapters
└── start.sh             # one-click start
```

- **Chat channel**: SSE streaming (`POST /api/chat/agent`)
- **Terminal**: WebSocket (`/ws/terminal`)
- **Storage**: SQLite (better-sqlite3, auto-initialized)

## 🔒 Security

- Sensitive tools (shell commands, file write/delete) require **confirmation before execution** in the UI; auto-denied after 120 seconds
- Dangerous shell commands (rm -rf /, sudo, dd, fork bombs, download-and-execute, ...) are **blocked unconditionally**
- File preview is limited to the workspace whitelist; credential/database files cannot be read
- CORS is localhost-only by default; set `API_TOKEN` and `CORS_ORIGINS` when deploying publicly

## 🤝 Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## 📄 License

MIT License — see [LICENSE](LICENSE).
