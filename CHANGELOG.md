# CHANGELOG

> SUPERCRZY BOT 版本更新记录。最新版本在顶部，历史版本完整保留。
> 此文件为官网更新日志页的数据母版；应用内弹窗仅展示当前版本。
>
> **发布节奏（2026-10-18 起）：每周发布一版。**
> 周期内累积的修复与新功能统一进本文件对应版本；版本号按 `MAJOR.MINOR.PATCH` 递增，
> 补丁类修复走 PATCH，含新能力走 MINOR。

---

## v1.2.2 (2026-10-23) — 朗读不再中途断掉

### 修复

**朗读读到一半停住（本次重点）**
- 根因四处，全部修掉：① 切句正则不认英文句号 —— 真库 2724 字英文语料实测 **65% 的切点落在句子中间**，
  Edge 念到半句被掐；② 客户端 `push`/`end` 都是「发出即忘」，`end` 抢在最后一段之前到达时
  服务端直接丢弃（实测音频只有前半 62784 字节）；③ 服务端重试不判「这一轮是否已经写过音频」，
  断流重发把同一段念两遍（实测 8192 → 16384 字节）；④ 客户端暂停超过 30s 被当成上游断流误杀。
- **攒批控制量从「字数」换成「未播音频秒数」**：旧机制按 40~120 字切，仿真（4 条真实回复 ×
  快/慢生成）显示固定字数在慢速生成下**断粮 46.6 秒**；新机制未播 ≥ 6s 就继续合并、
  < 6s 才把已成句的整串推走 —— 快链路 7 个接缝 / 断粮 0.6s，且切点永远落在句末。
- 首段改为**三级取最早**：第一句完 / 攒满 30 字后的第一个逗号 / 60 字兜底 —— 第一句再长也能尽快出声，
  又不会把首段切碎。
- 断粮救急**不再推碎片**：不足 24 字或没有软停顿就继续攒（推 5 个字换 1 秒音频是净亏，语调还最生硬）。
- 实测口径（`scripts/diag/measure-speech-chunks.mts`）：中英样本 5 段 / 4 段、**句中硬切 0**、
  断粮 0.0s、首段 13 / 52 字。

**朗读中断后无声无息**
- 服务端合成中途失败时会给客户端一个「和正常结束一模一样」的 ended —— 用户只能感觉"读一半停了"。
  现在服务端记 `failed` 并提供 `GET /api/tts/live/status`，客户端据此在朗读条上显示
  **「朗读中断：部分内容没能播出」+「续读」**：从最后一次推送起点之后的第一个句末继续读，
  绝不从词中间开口（宁重复半句，不丢内容）。

**中继地址下发**
- 中继服务一直在 VPS 上运行，但装机 App 的环境变量里从来没下发过地址 —— 等于白建。
  现在服务端启动时从 `updates.supercrzy.com/releases/tts-relays.json` 拉取清单
  （10 分钟缓存、3 秒超时、拉不到非致命），环境变量配置仍然优先；换中继地址不必重新打包。

### 变更
- 英文回复的句末补标点按语种选（英文 `.` / 中文 `。`），不再给英文段落补中文句号。

### 新增

**后台任务浮条（跑长任务不再干等）**
- 命令进后台后，输入框上方出现常驻浮条：`N 个后台任务运行中`，点开原地向上铺开列表（把消息顶上去，不遮盖内容），
  鼠标悬停行尾才出现删除按钮，删除有二次确认。
- 任务跑完**自动回报并接着做**：SSE 推 `running → 终态` 的跳变，前端把这轮的结论（退出码 + 末尾 2000 字输出）
  作为一条注入消息续跑，不需要用户手动催。刷页面不影响（状态在服务端，已处理记录在 `sessionStorage`）。
- 右栏可看单个任务的命令与**增量输出**（`?from=cursor` 轮询，跑完自动停），可取消。

**过程折叠改成自适应（短任务不再"证据消失"）**
- 以前完成态无条件把所有过程合成一条顶到消息最上面 —— 只跑了 3 步的任务也被收成一行摘要，
  而且打乱了「旁白 → 过程 → 结论」的阅读顺序。
- 现在按规模判断：工具 ≤3 且过程节点 ≤8 的**短任务平铺展示**，让用户看见做过什么；
  超过阈值的长任务仍合成一条，但**插在过程第一次出现的位置**（保持时间顺序）。
- 阈值抽成 `utils/process-fold.ts` 的纯函数，有 4 条断言钉住（这是产品规则，不是样式）。

**工具召回换成 BM25（"能搜到调不到"的根因）**
- 旧的召回是一行 `name.includes(query)` —— 纯子串、无排序、无 top-k；中文 query 必然 0 命中
  （工具名全英文，`query="图像"` 查不到 `generate_image`），无命中时还把 34 条按需工具**全量倒给模型**。
- 现在手写 BM25（零新依赖，k1=1.2 / b=0.75）：字段权重 名称×3 + 别名×2 + 描述×1，
  中文按 bigram 切；相对截断（低于最高分 30% 丢弃），无命中只给换词建议 + 5 个常用示例。

**能力清单收敛（`tool_search` 激活不再靠正则）**
- 白名单从**手抄 39 条**改成由注册表全量派生 —— 手抄版曾漏掉 `file_delete` / `memory_consolidate` /
  `make_article` / `browser`，一旦哪个从按需转常驻就会被静默丢掉。
- `tool_search` 发现工具后的激活，以前是**对返回文案做正则**（`已加载，可直接调用` + 抠行首工具名）——
  文案改一个字，按需工具就永久调不到且不报错。现在用本次调用的实参重放同一份检索，文案与激活彻底解耦。
- 会话能力清单带来源（builtin / skill / mcp）与稳定哈希，可回答"这个工具是谁带来的""关掉某 skill 后谁消失了"。

**闲置能力建议**
- 43 个注册工具里有 16 个从未被真实调用过，系统自己不知道。现在按天记账：闲置 ≥14 天在用量页列出，
  给出闲置天数与最近使用；当天新装的不推（刚装 ≠ 闲置）；"本版本不再提醒"带版本号，能力描述变了会重新出现。

**工具专属视图补齐 3 个**
- `tool_search`：搜索词 + 激活名单（一眼看出搜了什么、真激活了哪几个）。
- `browser` / `computer_use`：动作徽标 + 目标 + 结论三层，取代把参数 JSON 整坨贴出来的通用卡。
- 至此 top10 调用里已无工具落在兜底渲染。

### 工程

- **CSS 门禁**：删掉 16 个零引用的僵尸 token，44 处历史别名用法映射到真 token
  （`--danger*` → `--error`、`--code-bg` → `--bg-code` 等）；`check-css-vars` 新增僵尸守门
  （声明了没人用即失败），接入 stylelint。CSS 变量与样式的违规从此在 `pnpm verify` 阶段拦下。
- **权限契约**：新增 `validate:permission`，钉住前端显示层与服务端决策层的档位清单逐项一致、
  `TIER_META` 覆盖全档、desktop 部署拷贝与源头逐字相等。
- **能力清单契约**：`validate:tools` 新增 4 条断言（白名单必须派生、激活必须走数据、检索确定性、按需名录文案必须真实存在）。

---

## v1.2.1 (2026-10-22) — 版本号统一 + 用量口径可信化

### 变更

**版本号只留一个（本次重点）**
- 此前同一个产品有四个手写版本号：根 `0.4.1`、client/server `0.4.1`、desktop `1.2.1`，
  git tag 是 `v1.2.0`，装机产物 `1.1.3`，而 `/api/system/version` 兜底写着 `0.3.0`。
  结果是「设置-关于显示 0.3.0」与「更新横幅提示发现新版本」并排出现，用户无法判断自己在哪个版本。
- 现在 **唯一源 = 根 `package.json` 的 `version`**，由 `scripts/version.mjs` 派生到各子包；
  `pnpm verify` 第一步跑 `version.mjs --check`，桌面 `pack`/`dist` 前置自动同步（漂移即失败）。
- 桌面主进程启动后端时注入 `APP_VERSION = app.getVersion()`，`/api/system/version` 与
  `app:info`／设置-关于 从此同源；后端不再用任何写死的假版本号做兜底。
- ⚠️ 版本线由 `0.4.1` 并到 `1.2.1`：`1.x` 是用户实际安装的线（1.1.3 → 1.2.0 → 1.2.1），
  `0.x` 只存在于 CHANGELOG 与仓库，从未对外发布。

### 修复

**用量与费用（数据可信度）**
- 上下文窗口写死 128K，而官方 V4 全系是 **1M**：顶部圆环分母错 8 倍，且压缩阈值
  （`window × 0.55`）让长任务在 **70.4K** 就被压缩（应为 576.7K）。现按模型解析，存量数据自动抬到 1M
- 用量页模型名错配：实际调用 `deepseek-v4-flash`，却全部记在 `deepseek-v4-pro` 名下。
  根因是统计按「建会话时的模型」分组；现在逐条消息记录真实模型（含 fallback 切换后的），
  老数据标记为「归因不可靠」
- 费用低估约 4.7 倍：旧价格表 `¥2/1M` 对官方 `$1.32/1M`，且不分缓存命中与峰谷时段。
  现按官方 USD 定价计算（缓存命中/未命中分档 + UTC 峰谷），并修正英文界面把人民币金额
  显示成 `$` 的问题（等于把费用缩小 7.2 倍）
- 切换会话后顶部上下文用量不重置，新会话开局显示上一会话的占用

**新增**
- 用量页可直接查看 API 余额（服务端代理，密钥不下发前端），低于 ¥5 时启动时提示充值
- 授权收敛为两档（只读 / 询问）：`prompt`、`accept-edits`、`auto` 行为本已完全一致；
  不可逆操作（删除、高风险命令）不再受「超时自动放行」影响，永远需要确认

**安全与数据保护**
- 修掉一条**审批旁路**：同样一句 `rm -rf ~/x`，走 `shell_exec` 会被拦，走终端工具的
  `terminal_send` 却直接执行。现在两条通道共用同一套命令分级；顺带补上四个真实绕过写法
  （全路径 `/bin/rm`、`\rm`、`sh -c '...'` 包裹、`find -delete`）
- 「整理记忆」在删行前先整表落盘快照（默认留在数据库旁的 `memory-snapshots/`，保留最近 20 份）；
  快照写不进去就一条都不删。误整理后可用 `node scripts/diag/restore-memory.mjs --restore <快照>`
  按 id 补回，只补不覆盖
- 权限档位的判定只留在服务端：此前前后端各写一份，漂移会让界面显示「仅查看」而实际按
  「执行前询问」跑；同时修掉 `permissionTier` 列里残留的 `deny` 被另一列顶掉（等于悄悄解锁）的问题

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
