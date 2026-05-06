# DeepSeek Agent

AI Agent Platform with Web UI, natively integrated with DeepSeek V4.

## Features

- **Agent Loop**: Multi-turn thinking with tool execution (memory, file ops, shell, web search)
- **Monaco Editor**: Full code editing with syntax highlighting, auto-complete, and save
- **Skills System**: 8 builtin skills with auto-matching, custom skill creation support
- **CLI Mode**: Terminal-based chat with streaming and agent mode
- **Workspace**: File browser + terminal + code editor in one view
- **Channel Gateway**: Multi-platform messaging (WeChat Work, DingTalk, Feishu, QQ)
- **Memory System**: Long-term persistent memory with auto-extraction
- **18 DeepSeek Models**: Full model catalog from V4 Pro to R1 Distill

## Architecture

- **Frontend**: Vue 3 + NaiveUI + Monaco Editor + Vite + TypeScript
- **Backend**: Koa2 + better-sqlite3 + TypeScript + SSE streaming
- **Terminal**: xterm.js + WebSocket
- **Package Manager**: pnpm workspace (monorepo)

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env and add your DEEPSEEK_API_KEY

# Start Web UI + API server
pnpm dev

# Or start CLI mode
pnpm cli
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Web UI + API server |
| `pnpm dev:server` | Start backend only |
| `pnpm dev:client` | Start frontend only |
| `pnpm cli` | Terminal chat mode |
| `pnpm build` | Production build |

## Project Structure

```
deepseek-agent/
├── packages/
│   ├── client/          # Vue3 frontend + Monaco Editor
│   │   └── src/views/   # 14 pages (chat, workspace, skills, etc.)
│   └── server/          # Koa2 backend
│       └── src/
│           ├── routes/  # 10 API route modules
│           ├── services/ # Agent loop, tools, terminal
│           └── cli.ts   # Terminal CLI mode
├── .env.example
├── LICENSE
├── package.json
└── pnpm-workspace.yaml
```

## License

MIT © SuperCrzy
