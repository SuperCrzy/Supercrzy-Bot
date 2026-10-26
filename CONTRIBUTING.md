# Contributing to SUPERCRZY BOT

Thanks for your interest in contributing! We welcome bug reports, feature ideas, documentation, and code contributions — in any language.

## Project overview

- **Monorepo**: pnpm workspaces
  - `packages/client` — Vue 3 + Pinia + Naive UI frontend
  - `packages/server` — Koa 3 + better-sqlite3 backend
- **Chat channel**: SSE streaming (`POST /api/chat/agent`)
- **Storage**: SQLite (auto-initialized, no manual schema setup)

## Getting started

```bash
# 1. Install dependencies (Node 22.x + pnpm 10.x — see package.json "engines")
pnpm install

# 2. Configure your API key
cp .env.example .env        # fill OPENAI_KEY=sk-...
# or configure it later in the Web UI → Models page

# 3. Run in dev mode
pnpm dev                   # frontend 5173 + backend 3000, hot reload
```

## Development workflow

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes, keeping them focused and well-scoped
3. Run checks before committing:

```bash
# Type checks
pnpm --filter @supercrzy/client exec vue-tsc --noEmit
pnpm --filter @supercrzy/server exec tsc --noEmit

# Tests
pnpm test

# Production build
pnpm --filter @supercrzy/client build
```

4. Commit with a clear message describing **what** and **why** (e.g. `feat: add workspace switcher to sidebar`)
5. Push and open a pull request

## Guidelines

- **i18n-first**: all user-facing UI strings must go through the i18n system (`src/i18n/index.ts`) with both `zh-CN` and `en-US` entries. No hardcoded Chinese/English in templates or scripts.
- **Security**: any new tool or endpoint must respect the existing permission model (sandbox levels, confirmation-before-execution, path whitelists). Never weaken the defaults.
- **Use mature open source**: prefer well-maintained libraries over reinventing the wheel, unless the feature is a core differentiator.
- **No emoji icons in UI**: the project keeps a clean, original visual style.
- **Tests**: add or update tests in `packages/*/tests/` for any behavior change.
- **English first**: this is an international open-source project. All new code comments (`//`, `/* */`, JSDoc, shell script comments), commit message bodies, pull request descriptions, issue reports, release notes, and documentation must be written in **English**. Existing Chinese comments may stay as they are — do not spend review time asking for them to be translated. When a file is substantially rewritten, migrate its comments to English along the way. The only places where Chinese is expected are `docs/internal/` (never published) and the `zh-CN` half of i18n strings.
- **Release notes** follow a fixed shape: an English summary on top, then the Chinese detail nested inside a `<details><summary>中文</summary>…</details>` block, so readers can stop at the English summary.

## Reporting bugs

Open an issue with:

- Environment (OS, Node version, browser)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs if available

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
