# SUPERCRZY vs WorkBuddy 底层技术对比与增强路线

> 分析日期：2026-08-22 ｜ 依据：WorkBuddy 5.3.14（/Applications/WorkBuddy.app 拆包 app.asar 实证）+ SUPERCRZY 源码
> 目的：找可增强点，解决"技术偏老、内容输出不准确"两个痛点

## 一、技术栈全景对比

| 层 | WorkBuddy 5.3.14 | SUPERCRZY BOT | 差距 |
|---|---|---|---|
| 应用形态 | Electron 桌面壳（@genie/workbuddy-desktop） | Web(PWA) + Electron 桌面 | 无 |
| Agent 编排 | @openai/agents（Agent / handoff / Runner） | 自研 agent.ts（1625 行）+ SSE 流 | 自研是差异化核心，保留 |
| 模型 | 腾讯元宝/混元（bot.yuanbao.tencent.com）+ deepseek-r1 + gemini-3.1-flash-lite（技能推荐） | DeepSeek 系列（v4-pro/flash + 自定义 providers） | 缺**轻量模型做辅助任务**（技能推荐/分类/摘要） |
| 网络搜索 | **模型服务端内置**（客户端零配置零成本） | Tavily(key) → **Bing RSS 手写正则** | 免费层质量差、无 AI 摘要 → 内容不准 |
| 网页抓取 | WebFetch 模型端内置 | jina(key) → jina(免费) → fetch → Chrome headless（已加固） | 已对齐 ✅ |
| 深度搜索 | agentic_search（/agenttool SSE 代理，金融专用） | 幽灵多 Agent（规划中） | 差距大 |
| 对话历史搜索 | **embedding 余弦 + BM25 混合检索**（Bm25Index 类 + embedding cache） | **LIKE '%q%' 全表扫描**（history.ts） | **最大差距之一 → 记忆不准确** |
| 知识库 | IMA/乐享（向量+关键词混合，重排+裁剪） | 无 | 无 RAG 能力 |
| 记忆系统 | memory/search（语义），LRU embedding 缓存，daemon 预热 | 记忆管理页（LIKE 检索） | 语义化缺失 |
| 代码沙箱 | **e2b 云沙箱**（e2b.dev + 腾讯内网端点） | 本地 sandbox-exec 三层沙箱 | 本地方案够用，云端是开源后选项 |
| 技能市场 | skillhub.cn 云端（api/v1/search + 推荐） | browse.sh + GitHub 官方仓库 + 内置 32 | 缺**技能推荐**（WorkBuddy 用 gemini flash-lite 做） |
| 自动化 | RunCoordinator（并发 3、超时 90min、只读/外部动作工具识别） | automations 表 + 定时 | 并发/超时治理可借鉴 |
| 工具标准 | @openai/agents tools + MCP SDK | 自研 tools.ts（1552 行） | 自研保留；**MCP 接入是增量** |

## 二、WorkBuddy 值得学的 5 个机制

1. **混合检索（BM25 + embedding 余弦）** —— 记忆/对话搜索的核心。BM25 是 SQLite **FTS5 内置的 bm25() 函数**，零成本可拿；embedding 可选接入。这直接解决"上下文召回不准 → 输出不准"。
2. **技能推荐** —— 用 gemini-3.1-flash-lite（轻量模型）做技能推荐/分类，成本可忽略。我们有 DeepSeek 系列可替代，无需新增供应商。
3. **内容溯源** —— agentic_search/搜索工具强调"每条结论拖着 URL 走"。我们搜索结果已带 URL，但 agent 提示词未强制引用，需在系统提示里加"引用溯源"约束。
4. **e2b 云沙箱** —— 代码执行上云（本地只做文件同步）。本地 sandbox-exec 已够用，开源/多用户时再考虑。
5. **工具结果结构化** —— WorkBuddy 工具结果走 schema（zod）校验，避免解析脏数据。我们 tools.ts 返回 JSON 字符串，可加统一结果 schema。

## 三、两个痛点的根因诊断

### "技术有点老"（对应项）
- Bing RSS + **手写正则解析 XML**（tools.ts web_search）→ 脆弱、结果质量低、无日期去重
- 对话搜索 `LIKE '%q%'` 全表扫描 → 无相关性排序、无法语义召回
- 无 embedding / 向量能力 → 记忆、知识库、技能推荐全部缺位
- 工具结果 maxLen 截断（8000 字符）→ 长文内容不完整

### "内容输出不准确"（对应项）
- **搜索质量**：Bing RSS 免费源无 AI 摘要、结果陈旧 → 喂给模型的上下文就歪
- **上下文召回**：对话历史靠 LIKE，查不到语义相关的旧结论 → 模型重复犯错
- **无知识库/RAG**：不能引用本地资料（报告、数据）→ 答非所问
- **无引用溯源约束**：模型可能编造来源

## 四、增强优先级清单

### P0（立即可做，直击"不准确"）
| # | 动作 | 改动量 | 效果 |
|---|---|---|---|
| 1 | **对话搜索升级 FTS5（BM25）**：messages 建 FTS5 虚拟表，搜索改 bm25 排序 + 高亮 | 1 天 | 关键词搜索从"全表扫"→"相关性排序"，准度质变 |
| 2 | **搜索多源降级 + AI 摘要**：Tavily key 启用（已有代码）→ Bing → DuckDuckGo；结果按日期去重 | 0.5 天 | 搜索质量提升，陈旧/重复结果减少 |
| 3 | **系统提示加引用溯源约束**：所有 web_search/web_fetch 结论必须带 URL 引用 | 0.5 天 | 减少编造来源 |

### P1（中期，语义化升级）
| # | 动作 | 改动量 | 效果 |
|---|---|---|---|
| 4 | **记忆混合检索**：FTS5 BM25 + embedding 余弦融合（对齐 WorkBuddy），记忆管理页语义搜索 | 2-3 天 | 记忆召回准 → 长期上下文不丢 |
| 5 | **技能推荐**：轻量模型（DeepSeek flash）按用户输入推荐技能（对齐 WorkBuddy gemini flash-lite 思路） | 1 天 | 技能市场智能引导 |
| 6 | **知识库 RAG**：上传文档 → 分块 → FTS5/向量 → 检索增强（复用技能包体系） | 3-5 天 | 本地资料可被引用，输出有据 |

### P2（远期/开源后）
| # | 动作 | 备注 |
|---|---|---|
| 7 | agentic 深度搜索（幽灵多 Agent 落地） | 已有规划 |
| 8 | e2b 云沙箱 | 开源/多用户时 |
| 9 | MCP 工具标准接入 | 已有 connector 生态可借 |

## 五、结论

- **最大杠杆 = 检索升级**：WorkBuddy 的"准"主要来自 **BM25+embedding 混合检索**，我们只要用 SQLite 内置 FTS5 把对话搜索/记忆搜索语义化，就能在**不引第三方服务**的情况下追平大半差距。
- **搜索质量 = 内容准度的上游**：Tavily key 已是现成代码，启用 + 多源降级 + 引用溯源，成本极低。
- **自研 agent 循环保留**：这是差异化核心（幽灵多 Agent、记忆工作流），不换成 @openai/agents；要学的是 WorkBuddy 的**辅助机制**（混合检索、技能推荐、溯源约束）。
