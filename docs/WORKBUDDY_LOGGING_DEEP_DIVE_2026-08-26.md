# WorkBuddy 日志/记录机制深度研究（2026-08-26）

> 目的：老板问「AI 写日志看 WorkBuddy 的逻辑，何时激发、结构、内容」，作为我们 appendTaskLog（自动写 .md）的改造参照。
> 研究对象：WorkBuddy 5.3.14 app.asar 解包，main/logger*.js + cli/dist/codebuddy.js（引擎）。
> 核心结论：**WorkBuddy 并不写自动 .md 日记**，它的"记录"是两套独立机制——①结构化系统日志 ②Agent 会话结构化记录。它们的组织方式极值得借鉴，但形态不是我们做的 appendTaskLog。

---

## 一、总览：WorkBuddy 的“记录”其实是三件不同的事

| 机制 | 形态 | 何时激发 | 谁写 | 服务对象 |
|---|---|---|---|---|
| ① 结构化系统日志 | `main.log`+`renderer.log` 双文件，**JSON 每行** | 代码在关键事件点显式 `logger.scope("...").info(...)` | Electron 主进程 | 开发者诊断 |
| ② Agent 会话记录 | `.jsonl` 文件 + `serializeTranscript` | 每轮对话/工具调用 | Sidecar Agent 引擎 | 喂回模型上下文 |
| ③ 记忆/复盘 | `agent_memory` / memory_store 工具 | `syncTurnMemories` + 任务完成反思 | 引擎自动 | 长期记忆复用 |

**WorkBuddy 没有「自动写成 .md 日记给人看」这个概念**——它把记录做成机读的结构化数据。

---

## 二、① 结构化系统日志（main/logger*.js）——最值得抄的工程

```js
// main/logger2.js 核心
formatJsonLine: 每条 = { timestamp, level, scope, message }   // 一行一个 JSON
main.log scope: main / session / handler / window / sidecar / rpc
renderer.log: 渲染进程 console.* 转发
各自 5MB 轮转（满 → 重命名 *.old.log）
路径: macOS ~/Library/Logs/workbuddy/ · Win %LOCALAPPDATA%/... · Linux ~/.config/.../logs/
```

**何时激发**：不是"任务结束才写"，而是**所有关键事件点都写**，靠 scope 区分归属：
- `session` scope：会话生命周期事件
- `handler` scope：IPC/请求处理
- `sidecar` scope：引擎通信
- `rpc` scope：进程间调用

**降噪（LogSampler）** —— 这是亮点：
- 按 `scope+level+首参数` 做指纹
- **1 秒窗口内同指纹最多 5 条**，超过开始抑制并追加 `{suppressed: N}`
- 防止高频日志（如轮询）刷爆文件

**内容结构**：JSON 单行，字段固定（timestamp/level/scope/message），机读可 grep，配索引工具。

---

## 三、② Agent 会话记录（cli/dist/codebuddy.js）

- **存储**：`sessionStore.getSessionFilePath()` → `.jsonl` 文件（JSON Lines，每行一个事件）
- **转文字给模型**：`serializeTranscript()` —— 把结构化会话序列化成文本，注入上下文让模型"记得"本轮之前发生了什么
- **turnCounter recoder**：`{ turnCounter, recordFilePath, modelQueues, totalResponseCount }`——有轮次/模型队列/响应计数的结构化记录

**何时激发**：每轮 turn / 每次工具调用 / 每次模型响应，都 append 到 jsonl。

**本质**：这是**给模型吃的上下文**，不是给人读的文档。我们的 flow + content 持久化到 SQLite，角色等同。

---

## 四、③ 记忆/复盘（引擎 buildMemoryLines + memory_store）

```js
buildMemoryLines() 返回：
  ["## How to save memories",
   "Saving a memory is useful when...", ...]   // 注入 system prompt 的保存指令
```
- 引擎在 system prompt 注入 **"怎么保存记忆"的说明**
- 配 `memory_store` 工具——模型判断"这条值得存"时主动调它保存
- 类似我们已实现的 `syncTurnMemories` + `memory_store` 工具（agent.ts）

**何时激发**：**模型自主决定**（有值得记的信息时调 memory_store）+ 任务完成后自动反思存 experience。

---

## 五、与我们 appendTaskLog（自动写 .md）的对照与建议

### 现状（我们已实现的）
- 后端 runAgentLoop 唯一收尾点，任务结束追加写 `logs/YYYY-MM-DD.md`：
  ```
  ## HH:MM:SS · 模型
  - 请求：...
  - 摘要：...
  - 统计：N 次工具调用 · M 轮
  ```

### WorkBuddy 方式 vs 我们：
| 维度 | WorkBuddy | 我们 appendTaskLog | 建议 |
|---|---|---|---|
| 形态 | 机读 JSON/jsonl | 人读 .md | **保留 .md（老板要人读）、内容升级** |
| 何时写 | 关键节点都写 | 仅任务结束 | 可加"每轮"级细节（可选） |
| 结构化 | timestamp/level/scope | 时间+请求+摘要+统计 | **可加 工具明细/变更文件** |
| 降噪 | 采样器抑制高频 | 无 | 无需（低频） |

### 具体优化建议（对照 WorkBuddy 结构升级我们的 .md）
1. **摘要字段保留**（WorkBuddy 用 transcript，我们用人话摘要，更友好）
2. **加"工具明细"**：像 WorkBuddy scope 区分，我们列出本次用到的工具名清单（`- 工具：web_search, file_write`）
3. **加"变更文件"**：ListFileCard/产物里生成的路径（如 `- 产物：src/foo.html`）
4. **路径优化**：从 `packages/server/logs/` → 项目根 `logs/`（WorkBuddy 放系统 Logs 目录，但我们是自部署，放项目可随产物一起管理）
5. **补充记忆关系**：日志和 agent_memory 是两回事，可提示"可回顾的长期记忆见记忆面板"

---

## 六、一句话总结

**WorkBuddy 的"日志"是给机器和开发者读的结构化数据（JSON jsonl + scope），不是给老板读的 .md 总结。** 我们的 appendTaskLog 走的是"人读 .md 任务总结"路线，方向不同但更有价值（老板要看）。**真正应从 WorkBuddy 学的**是它的结构完整度：scope 分级 + 关键字段齐全 + 降噪。建议我们保留 .md 形态，但内容补上"工具明细 + 产物文件"两个字段，路径挪到项目根 logs/。
```
