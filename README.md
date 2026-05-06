# DeepSeek Agent

AI Agent Platform with Web UI, natively integrated with DeepSeek V4.

## Architecture

- **Frontend**: Vue 3 + NaiveUI + Vite + TypeScript
- **Backend**: Koa2 + better-sqlite3 + TypeScript
- **Package Manager**: pnpm workspace (monorepo)

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env and add your DEEPSEEK_API_KEY

# Start dev server
pnpm dev
```

## Project Structure

```
deepseek-agent/
├── packages/
│   ├── client/          # Vue3 frontend
│   └── server/          # Koa2 backend
├── .env.example
├── package.json
└── pnpm-workspace.yaml
```

## License

MIT © SuperCrzy
