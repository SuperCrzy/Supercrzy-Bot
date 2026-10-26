# SuperCrzy Bot: an AI agent that runs on your machine, remembers what it learned, and operates the computer it lives on

**A complete agent workbench in a single process — 47 tools, eight messaging channels, three-tier command sandboxing, and a Playbook that turns every finished task into context for the next one. MIT licensed, self-hosted, your own model key.**

SuperCrzy today announced SuperCrzy Bot, an AI agent platform that runs entirely on the user's own computer. Unlike hosted assistants, which reset with every session and keep both the work and the model behind a login, SuperCrzy Bot keeps its interface, its API, its memory and its data in one place the user controls — a single SQLite file on their disk.

At 47 registered tools, the agent does not stop at the edge of an API. It drives a real browser, operates native applications that have no API at all, and executes shell commands through a permission model that grades each call by its shape rather than by its tool name.

"Every agent platform is ultimately a bet about where the work happens," said the SuperCrzy project. "Hosted agents put it behind someone else's login and lose everything when the tab closes. We built the opposite: the agent, the history, and the model choice stay with the person who is actually doing the work — and because the history is a SQLite file, they can inspect exactly what it thinks it knows."

## Operates the computer, not just an API

Most agents stop where the API ends. They can read a document you paste but cannot open the file; they can summarise a URL but cannot click the login button; they can describe a screenshot but cannot take one. The last mile of a real task is left to the person who asked.

SuperCrzy Bot crosses that boundary in three escalating levels:

**`browser`** — a real Chromium the agent drives itself. `navigate` opens a page, `look` returns the clickable elements plus the rendered text, then `click`, `type`, `press`, `back` and `scroll` advance one primitive at a time. It reads what the page *renders*, not what the HTML *claims* — the difference between "the page says it is in stock" and "the button says Add to cart".

**`computer_use`** — the operating system itself, not a browser tab. `screenshot`, `click x,y`, `type`, `key combo`, `scroll`, `move` and `open <app>`. It can drive a native program that has no API whatsoever: a legacy desktop tool, a system dialog, a preferences pane that has to be clicked through three times. This tool runs only at full permission and asks before every call.

**`shell`** — the honest fallback. When a task is better served by `curl` and a parser than by a full browser, the agent should say so and switch. Across **3,004 recorded tool calls**, the distribution was shell 45.7%, web search 15.5%, web fetch 13.4%, file read 5.1%, file write 4.7%, browser 3.9%, computer use 2.0%. That is the correct shape: an agent that opens a full browser to read a static article is spending the user's budget on nothing.

## Remembers what worked

Most agent sessions start at zero. SuperCrzy Bot writes a retrospective after every completed task — which approach worked, which tools were used, what failed — into a **Playbook**. On a later task of the same shape, matching entries are injected into context before the run begins.

Alongside it sits **long-term memory**: facts extracted from conversations, deduplicated over time, weighted when injected. Two distinct learning surfaces — reusable procedure from work already done, and durable facts about the user's projects.

Neither is a fine-tune. Both are rows in a database the user can open, query, edit and delete. The agent's own notes are legible, which is the difference between an assistant that improves and one that merely seems to.

Here is a retrospective it wrote for itself after a page-verification task:

> "Open the target URL directly and use the browser to check the copy, screenshot and links. If `browser` fails repeatedly or times out, fall back to `web_fetch`/`curl` — do not keep polling the same page."

And after a page-summary task:

> "Open the page with the browser and read the visible text; that alone completes the summary. This run took a detour through `tool_search` and `web_fetch`. Next time, if the page needs rendering go straight to `browser`; only use fetch for static content."

These are not prompts written by the team. They are notes the agent produced about its own mistakes, retrieved and injected the next time a similar task arrives.

## Reviews with a different model

A model grading its own output is a weak check. The **Collaboration Hub** runs a task through a fixed serial pipeline — plan, execute, review, deliver — and the review stage deliberately does not run on the model that did the work.

Execution defaults to DeepSeek; quality review runs on Kimi; a full *senate* tier brings DeepSeek, Kimi and GPT into the same review. The audit agents are **tool-using**: they read files, grep, and list directories rather than reading code as a wall of text and forming an opinion. Every stage persists to the database, so a run survives a restart instead of beginning again.

## Runs everywhere, including a 2015 Android tablet

The agent does not need files handed to it through an API. It operates the machine it runs on — shell, filesystem, editor, browser — and the same build ships as a desktop application for macOS and Windows, as a web application served from a local port, and as an agent running on an **old Android tablet** through a chroot environment with a SQLite compatibility shim.

The last one is not a demonstration. A tablet with 2.86 GB of RAM runs the full agent, browser tooling included.

## Eight messaging channels, one brain

The gateway connects **WeChat, WeCom, DingTalk, Feishu, QQ, Telegram, Discord and Slack** over long-lived connections, so no public callback URL and no domain are required — the usual blocker for anyone behind NAT.

What matters more is what the channels share: the same session store, the same skill library and the same memory as the desktop application. Ask something in Telegram and the fact is present in the desktop interface. There is no separate "bot mode" with its own amnesia.

## Your model, your key, no meter

SuperCrzy Bot never sits between the user and the model provider. A key from DeepSeek, OpenAI, Anthropic, Gemini, xAI, Mistral, Qwen, NVIDIA NIM, Zhipu, Kimi, OpenRouter or a local Ollama instance is used to call that provider directly. OpenRouter alone opens more than 200 models behind a single key.

Because there is no inference contract, switching models is a dropdown rather than a migration. Sessions, messages and extracted memory live in `~/.supercrzy/data/supercrzy.db` — one file that can be copied, backed up, or moved to another machine.

## Precise because it parses

Shell execution is where an agent platform earns or loses trust. The defences are stacked rather than singular:

- A **command blacklist** catches the extremes — root deletion, sudo, fork bombs, curl-pipe-to-shell.
- A second tier scans the command for dangerous paths **in pure Node**, so it holds in any environment.
- On macOS a third tier applies a **kernel-level `sandbox-exec` profile** — the SBPL equivalent of Linux Landlock — permitting the project repository and `/tmp` while denying reads and writes under the home directory.

Commands are split into segments, quote- and heredoc-aware, and `rm` is graded by shape: recursive, sudo-prefixed or path-escaping commands are blocked, while a non-recursive delete inside `/tmp` or the workspace is allowed.

The same restraint shapes approval. Sensitive tools declare `requiresApproval` on the tool definition itself, and a **build-time validator asserts that this declaration and the dangerous-tool list cannot drift apart**. The check runs in continuous integration, so a one-line edit that would quietly disable a guard fails the build instead of shipping.

## Availability

SuperCrzy Bot is available now, free and open source under the MIT license, at [supercrzy.com/bot](https://supercrzy.com/bot) and [github.com/SuperCrzy/Supercrzy-Bot](https://github.com/SuperCrzy/Supercrzy-Bot).

**macOS (Apple Silicon)** — download the disk image, open it, drag the app to Applications. The build is unsigned, so the first launch requires right-click → Open.

**Windows (x64)** — run the installer. SmartScreen will ask once, because the installer is unsigned.

**From source** — Node 22.x and pnpm 10.x, both pinned deliberately. Clone the repository, run `pnpm install`, then `pnpm --filter @supercrzy/server start` and open the printed address.

There is no managed offering, no subscription and no support contract. The user supplies their own model key; for the Chinese messaging channels, they also need an account on that platform. Data stays on the machine that produced it, and cross-device sync is in development.

---

### Notes

1. Tool-call distribution measured across 3,004 recorded calls in the project's own Playbook database, October 2026.
2. Sandboxing layers: blacklist, pure-Node path scan, and macOS `sandbox-exec` (SBPL). The third tier is macOS-only; Linux and Windows currently rely on the first two.
3. Five of the eight messaging channels are Chinese platforms. Teams outside China will realistically configure three.
4. The gateway has not been independently audited.
