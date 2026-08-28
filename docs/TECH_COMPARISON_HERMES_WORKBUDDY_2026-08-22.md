# SUPERCRZY vs Hermes Agent vs WorkBuddy 底层技术全面拆解对比

> 分析日期：2026-08-22
> 依据：Hermes Agent 0.17.0（~/.hermes/hermes-agent 源码实证）+ WorkBuddy 5.3.14（app.asar 拆包实证）+ SUPERCRZY 源码

## 一、三方案底层技术画像

### Hermes Agent 0.17.0（NOUS Research，Python 实现）
- **形态**：Python 包（venv 可编辑安装）+ TUI + Web UI（npm hermes-web-ui）
- **Agent 编排**：agent/ 101 模块——**多模型适配器**（anthropic / azure / bedrock / gemini / codex / copilot / openai）+ **codex_runtime**（OpenAI Codex app server 流式执行）+ **上下文压缩器**（context_compressor）
- **模型**：openrouter / anthropic / zai(GLM) / arcee / azure / bedrock / gemini / codex / 自定义 ollama/proxy
- **搜索**：**插件化 WebProvider 架构**——8 个 provider：parallel / firecrawl / tavily / exa（语义搜索）/ searxng（自建元搜索）/ brave-free / ddgs（DuckDuckGo 包）/ xai；**search 与 extract 后端独立配置** + 自动探测可用性降级（`_get_backend()`：TAVILY_API_KEY → SEARXNG_URL → 默认）
- **记忆**：**插件化 MemoryProvider 抽象基类**——每轮 turn 前 `prefetch`（语义预取注入系统提示）+ turn 后 `sync_turn` + 会话生命周期钩子 + **bound curated memory 注入系统提示**（char_limit 2200 ≈ 800 tokens）
- **技能**：skills/ 主题目录（apple / computer-use / data-science / github / mlops / research...）+ 三层技能（bundled / agent-managed / hub）+ skill_manage 工具（自创技能）
- **代码执行**：codex_runtime + code_execution_tool + computer_use（CUA 桌面控制，带 permissions 审批）
- **调度**：cron/（croniter）
- **网关**：gateway/（MCP + ACP 适配 + 渠道分发）+ plugins/（web provider 插件化）

### WorkBuddy 5.3.14（腾讯）
- **形态**：Electron 桌面壳（@genie/workbuddy-desktop）+ @openai/agents + @modelcontextprotocol/sdk
- **Agent 编排**：@openai/agents（Agent / handoff）+ 自研 ACP 适配
- **模型**：腾讯元宝/混元（bot.yuanbao.tencent.com）+ deepseek-r1 + gemini-3.1-flash-lite（技能推荐）
- **搜索**：web_search 模型端内置（腾讯服务端执行，搜狗/微信搜一搜索引）；agentic_search（SSE 代理，金融深度搜索）
- **记忆/对话搜索**：**embedding 余弦 + BM25 混合检索**（Bm25Index 类 + embedding LRU 缓存 + daemon 预热）
- **知识库**：IMA/乐享（向量+关键词混合，top_k/threshold 可调）
- **沙箱**：e2b 云沙箱（e2b.dev + 腾讯内网端点）
- **技能**：skillhub.cn 云端市场 + 轻量模型推荐
- **自动化**：RunCoordinator（并发 3、超时 90min、只读/外部动作工具分类治理）

### SUPERCRZY BOT（现状）
- **形态**：Web(PWA) + Electron 桌面 + Koa 后端
- **Agent 编排**：自研 agent.ts（1625 行）+ SSE 流式
- **模型**：DeepSeek 系列 + 自定义 providers
- **搜索**：Tavily → Serper → Bing RSS → DDG（四层降级，刚修复）
- **抓取**：jina(key) → jina(免费) → fetch → Chrome headless（刚加固）
- **记忆/对话搜索**：LIKE '%q%' 全表扫描（差距最大）
- **沙箱**：本地 sandbox-exec 三层
- **技能**：内置 32 + browse.sh + GitHub 官方仓库
- **上下文**：无压缩（长对话靠滚动窗口）

## 二、三方核心能力对比

| 维度 | Hermes | WorkBuddy | SUPERCRZY | 结论 |
|---|---|---|---|---|
| 搜索架构 | 插件化 provider + 自动降级 | 模型端内置（云端） | if-else 降级链 | **Hermes 架构最可学** |
| 搜索质量 | 取决于配的 provider | 搜狗/微信索引（最强） | 免费源为主 | 需配 Serper/Tavily key |
| 记忆检索 | prefetch 语义预取注入 | BM25+embedding 混合 | LIKE 全表扫 | **三方都领先我们** |
| 记忆机制 | 插件化 provider + 系统提示注入 | turn 前语义召回 | 记忆页手动 | Hermes 的 prefetch 模式最佳 |
| 上下文管理 | 压缩器（compressor） | 模型原生 256K | 滚动窗口 | 缺压缩器 |
| 代码执行 | Codex runtime + CUA | e2b 云沙箱 | 本地 sandbox-exec | 都够用，云端是远期 |
| 技能系统 | 三层 + skill_manage 自创 | skillhub 云端 | 内置+开源市场 | Hermes 的"自创技能"值得学 |
| 模型支持 | 8+ 提供商 | 腾讯系 | 自研 providers | 我们够用 |
| 工具标准 | Python 装饰器 + MCP/ACP | @openai/agents + MCP | 自研 tools.ts | 渐进接 MCP |

## 三、最值得学的 5 个机制（按杠杆）

1. **Hermes 记忆 prefetch 模式**（最大差距）——每轮 turn 前从记忆语义预取相关条目注入系统提示。我们记忆页有数据但**从不自动注入**，等于记忆白存。落地：每轮对话前从记忆表检索相关条目 → 拼进系统提示。
2. **混合检索 BM25 + embedding**（WorkBuddy）——SQLite FTS5 的 bm25() 零成本可得，是"记忆搜索语义化"第一步。
3. **Hermes 插件化 provider 架构**（web/memory 抽象基类 + 自动探测降级）——我们搜索是 if-else，可渐进抽象成 provider 注册表。
4. **Hermes skill_manage 自创技能**（程序性记忆）——复杂任务完成后自动沉淀技能。我们技能市场已就绪，缺"自动沉淀"环节。
5. **上下文压缩器**（Hermes context_compressor）——长对话摘要压缩，避免滚动窗口丢上下文。

## 四、落地优先级（建议）

| 优先级 | 动作 | 对齐谁 | 改动量 |
|---|---|---|---|
| P0 | **记忆 prefetch 注入**：每轮 turn 前检索记忆/历史相关条目注入系统提示 | Hermes | 1-2 天 |
| P0 | **对话搜索 FTS5(BM25)**：messages 建 FTS5，bm25 排序 | WorkBuddy | 1 天 |
| P1 | 搜索 provider 抽象（注册表 + 自动探测降级） | Hermes | 1-2 天 |
| P1 | 技能自动沉淀（skill_manage 类似物，任务完成后写 SKILL.md） | Hermes | 2-3 天 |
| P1 | 上下文压缩（长对话滚动摘要） | Hermes | 2-3 天 |
| P2 | 知识库 RAG（复用 FTS5/embedding） | WorkBuddy | 3-5 天 |

## 五、一句话结论

- **记忆/检索是三方共同的最优路径**：Hermes 用"prefetch 注入"，WorkBuddy 用"BM25+embedding"，我们两步都缺——**先做 FTS5（1 天），再做 prefetch 注入（1-2 天）**，就能从"记忆形同虚设"追到"记忆主动参与生成"。
- **架构上最该学 Hermes 的插件化 provider**：搜索/记忆/抓取都抽象成"基类 + 多实现 + 自动降级"，以后加新引擎零改动。
- **WorkBuddy 的云端化（搜狗索引/云沙箱）复制不了，但思路可平移**：服务端 API（Serper/Tavily）+ 云端执行。
