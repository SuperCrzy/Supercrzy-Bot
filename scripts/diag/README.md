# DeepSeek `reasoning_content` 400 —— 诊断与验证脚本

> 结论先行（2026-09-20 实测确立，别再重新推一遍）：

## 规则

**请求带 `tools` 时，若"最后一条 `user` 消息之后"的尾部里存在缺 `reasoning_content` 字段的 assistant
消息，DeepSeek 返回：**

```
400 The `reasoning_content` in the thinking mode must be passed back to the API.
```

三条关键事实（都是对照实验得出的，不是文档抄的）：

| # | 事实 | 实验 |
|---|---|---|
| ① | **同一个序列不带 `tools` → 200。`tools` 才是触发开关** | `confirm-rc-rule.ts` |
| ② | 字段值为**空串 `""` 也满足**。API 要的是"字段存在"，不是"必须原样传回" | `confirm-rc-rule.ts` |
| ③ | 更早的历史回合缺 rc **无害**；带 `tool_calls` 的 assistant 缺 rc **也不受影响** | `replay-checkpoints.ts` 抽样回放 |

## 为什么以前三次都没修住

旧诊断把范围搞错了（以为"任何带 tool_calls 缺 rc 的轮次"都要处理），于是：

- `sanitizeToolCallSequence` 的降级分支返回 `{ role:'assistant', content: text }` —— **把 rc 丢掉了**
- 每 3 轮的裁剪循环还会**主动删除**纯文本 assistant 的 rc

两者都会把一条**有 rc 的尾部 assistant 变成"无 rc 纯文本"**——恰好是这条规则唯一禁止的形状。
**修复动作自己造出了它想修的那个 400**，所以 08-28 修完、09-04 反而单日爆 10 次。

## 修复位置

`packages/server/src/services/agent.ts`

1. 降级分支**保留 `reasoning_content`**
2. 新增反向孤立清理（tool 消息找不到发起者 → 移除）
3. 新增 `ensureReasoningEcho()`：发送前把尾部缺 rc 的 assistant 补空串（仅"带 tools + DeepSeek 系"）
4. 裁剪循环**不碰尾部**
5. 发请求咽喉点串起两道闸门

## 怎么重跑验证

```bash
# 1. 钉规则：12 组最小序列，逐条打出 200/400
node node_modules/tsx/dist/cli.mjs scripts/diag/confirm-rc-rule.ts

# 2. 各自对比：证明 A=保留 rc / B=补空串 两条修复方向都有效
node node_modules/tsx/dist/cli.mjs scripts/diag/verify-fixes.ts

# 3. 回放真实失败检查点：看当前实现是否还 400
node node_modules/tsx/dist/cli.mjs scripts/diag/replay-checkpoints.ts

# 4. 验收：修复前 / 旧管线 / 新管线 三联对比
node node_modules/tsx/dist/cli.mjs scripts/diag/acceptance-rc-fix.ts
```

2026-09-20 的验收结果：

| 对象 | 结果 |
|---|---|
| 修复前（原样发出） | 3/6 报 `400 RC` |
| 旧管线（只有 `sanitizeToolCallSequence`） | **仍 3/6 报 `400 RC`** ← 证实旧修复无效 |
| 新管线（`sanitize` + `ensureReasoningEcho`） | **6/6 全部 200** |

## 端到端压测（真跑 Agent 循环，不只看最小序列）

```bash
# 先起服务（必须后台常驻，会话结束会被清理 → 502）
node ../../node_modules/tsx/dist/cli.mjs src/app.ts        # 在 packages/server 下
# 端口 3000；/api/health 返回 200 即可跑

node scripts/diag/e2e-multitool-stability.mjs 20
```

跑 20 次真实多工具任务（独立 sessionId，走 `POST /api/chat/agent`），用**只读工具**构造多轮依赖任务，
避开 `SENSITIVE_TOOLS`（`shell_exec` / `file_write` / `file_delete` / `memory_consolidate`）以免卡在授权等待。

> ⚠️ **判定指标必须只认错误通道。**
> 本脚本第一版把整个 SSE 原始文本丢进正则 `reasoning_content|tool_sequence`，结果**满屏假警报**——
> 因为提示词让模型去读 `error-classifier.ts` / `tool-sequence.test.ts`，**工具结果把源码里的
> `reasoning_content` / `tool_sequence` 字样原样回显**，正则被打中。
> 正确做法：只认 `event: error` 与带 `error: true` 的 `content` 事件；
> 最终判据用服务端日志的 `[Agent] Error (…)` 与 `task_runs.failure_code`（产品自己记的），
> 不要用扫原文这类代理指标。

## `dist/app.js` 起不来（独立问题，与本次修复无关）

```
ERR_UNSUPPORTED_DIR_IMPORT: url 'file:///…/packages/server/dist/config'
```

`dist/config/index.js` 存在，但编译产物里 `import … from './config'` 没带扩展名 → ESM 解析失败。
本地跑服务请用 `tsx src/app.ts`；如果生产/Electron 依赖 `dist`，这个要单独修。

## 注意

- 脚本会读 `~/.supercrzy/data/supercrzy.db` 取 API key（**只读**打开），并**真实调用** DeepSeek API。
  单次开销极小（`max_tokens: 24`），但会消耗额度。
- 密钥不会打印。
- 检查点目录：`packages/server/data/checkpoints/`。若该目录不存在，`replay-checkpoints.ts` 与
  `acceptance-rc-fix.ts` 会跳过缺失文件，`confirm-rc-rule.ts` / `verify-fixes.ts` 仍可独立运行（它们自己造序列）。
- 遇到 `Service is too busy` 是限流，不是规则不成立——脚本会标成 `RATE_LIMIT(忽略)`。

## 2026-09-20 端到端验收结果（20 次真实多工具任务）

| 指标 | 结果 |
|---|---|
| 干净完成 | **20 / 20 = 100%** |
| 命中 400（`reasoning_content` / API） | **0** |
| 命中 `tool_sequence` | **0** |
| 每个任务工具调用次数 | 5 ~ 10（均值 7.3） |
| 每个任务思考轮次 | 4 ~ 10 |
| 平均耗时 | 80.6s（最长 178.9s） |

**交叉核对（不信脚本自述，信产品自己记的）**：

- `task_runs`：新增 20 条**全部 `completed` 且 `failure_code` 为空**；
  历史遗留的 `tool_sequence` 仍是 3 条（修复前的旧账，未被覆盖）
- `messages`：含 `API error` 的条数**没有增长**（仍 17 条，全是修复前的）
- 服务端日志：**整场零 `[Agent] Error`**

**两道闸门确实在真实任务里干活**（日志逐轮可见，不是"没触发所以没问题"）：

```
[Sanitize] turn 5: 清洗 11→10 条消息（移除孤立/反向孤立工具消息）
[ReasoningEcho] 补齐 1 条尾部 assistant 的 reasoning_content（空串），规避 DeepSeek 400
[Sanitize] turn 7: 清洗 16→11 条消息
[ReasoningEcho] 补齐 3 条尾部 assistant 的 reasoning_content（空串），规避 DeepSeek 400
```

`清洗 11→7`、`19→18`、`16→11` 这些是修复前**会直接发出去并导致 ORPHAN 400** 的脏数据；
`补齐 1~3 条` 是修复前**会直接导致 RC 400** 的尾部形状。也就是说：闸门不是在空转，是在真实地拦。

> 跑完记得停服务：`pkill -f "tsx/dist/cli.mjs src/app.ts"`。
> 压测只往 `task_runs` 写（本次 +20 条），**未写 sessions / messages**；
> 若要清理测试数据：`delete from task_runs where label like '先%' or label like '用 web_search%';`（先备份 DB）。


---

## 三、video_edit 死链验收（2026-09-20）

`scripts/diag/verify-video-edit.ts` —— 让 `video_edit` 真跑一遍 ffmpeg，而不是"单测绿就算修好"。

```bash
cd packages/server
node ../../node_modules/tsx/dist/cli.mjs ../../scripts/diag/verify-video-edit.ts
```

验收标准：**产物必须有真实帧**，不是"文件存在就算过"（空壳 mp4 也存在）。

修复前后：

| 项 | 修复前 | 修复后 |
|---|---|---|
| ffmpeg 解析 | 硬编码 `bin/ffmpeg`（x86_64，本机 EBADARCH -86） | 解析链 + 逐个真跑 `-version` 探测 → `~/.supercrzy/bin/ffmpeg`（arm64） |
| 沙箱 | 把可执行文件本身判「路径越权」，修好 ffmpeg 后反而被自己拦死 | 只扫参数，不扫可执行文件路径 |
| trim 产物 | 261 字节、**零流**、退出码 0（看着像成功） | 9063 字节、**12 帧** |
| ESM | `require('fs')` → concat 分支 ReferenceError；onArtifacts 被 try{} 吞掉 | 顶层 import；产物正常上报 |
| 兜底 | 无 | 退出码 0 但产物 0 字节 → 判失败 |

**教训（可复用）**：`退出码 0` 不等于成功。ffmpeg 完全可能在参数顺序错时生成一个没有任何流的空容器。
涉及"产出文件"的工具，验收必须落到**产物内容的断言**（帧数 / 字节数 / 可解析），而不是进程退出码。

---

## 四、AI 浏览器（右栏实时画面 + 任务结束清理）验收（2026-09-23）

`scripts/diag/verify-ai-browser.mts` —— 真起一个 Chrome，让 **AI 工具侧**和**右栏 HTTP 侧**走同一个实例。

```bash
# 用独立 DB/工作区，不碰 ~/.supercrzy 的真实库（脚本自带内嵌路由，不需要另起后端）
cd packages/server
DB_PATH=/tmp/supercrzy-diag.db WORKSPACE_DIR=/tmp/supercrzy-diag-ws \
  node node_modules/tsx/dist/cli.mjs ../../scripts/diag/verify-ai-browser.mts
```

⚠️ 扩展名必须是 **`.mts`**，不能是 `.ts`：根 `package.json` 没有 `"type"`（= CommonJS），
而 `packages/server` 是 `"type": "module"`。用 `.ts` 时 tsx 把脚本当 CJS 转译，
`import` 退化成 `require` → **同一个 `ai-browser.ts` 被加载成两份**，
工具写的实例和路由读的实例不是同一张表，测试会假失败（也可能假通过）。
`.mts` 保证全链 ESM，才真正验证得到"工具与路由共用一张实例表"。

脚本断言四条不变量（11 项检查）：

| 不变量 | 修复前 | 修复后 |
|---|---|---|
| A 工具侧写进**会话 key** | 写死 `'default'`（右栏读的是 `wb:<sid>`，永不可见） | 写 `wb:<sid>`；且 `default` 桶保持空 |
| B 右栏长轮询读到 AI 的帧 | 读不到（两个实例） | `latest` 返回 AI 刚打开页面的帧（ts + 截图 + url 全对） |
| C 显式释放 | 只有 10 分钟闲置兜底，且 default 桶不回收 | `POST /browser/close` 即时消失；多会话互不串台 |
| D 闲置回收含 default | `auditIdle` 直接 `continue` 跳过 default → 实测残留无头 Chrome **34 分钟**不退 | 会话桶 10 分钟、default 桶 30 分钟，可注入时间断言（`__auditIdleAt`） |

> 为什么 default 桶要留 30 分钟而不是一起 10 分钟：它只服务后台任务
> （`video-transcript` / `content-factory`），这些任务可能在**等 LLM 返回**时长时间不碰浏览器，
> 阈值太短会在中途把它的页面回收掉。会话桶（正常聊天路径）才是"任务结束即时清"。
>
> 任务结束清理由 `runAgentLoop` 收尾（覆盖聊天/会诊/自动化所有入口）+ `chat.ts` 的 `finally` 兜异常路径，
> 两处都幂等（`closeKey` 可重复调用）。
>
> 排查用：`GET /api/collab/browser/sessions` 列出当前持有实例的 key
> —— 怀疑"任务跑完 Chrome 不退"时先看这里，再看 `pgrep -f playwright_chromiumdev_profile`。
