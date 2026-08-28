# WorkBuddy Agent 执行机制拆解（2026-08-28 调研）

> 调研动机：我们的 Agent 出现"连续 56 次 shell_exec 查源码、跑满 40 轮、只吐思考不吐结论"的
> 不收敛死循环。带着"成熟产品是怎么防住这件事的"这个问题，逆向拆解 WorkBuddy 的执行机制。
> 信息来源：WorkBuddy 官方文档（workbuddy.ai/docs）、公开技术拆解文章、learn-workbuddy 开源教学实现。

---

## 一、Agent Loop：停止判据基于"内容"而非"元数据"

WorkBuddy 的心跳循环是最朴素的 ReAct：

```python
while True:
    turn = llm.chat(messages)
    if turn.tool_calls:            # 有工具调用 → 必须继续
        results = execute(turn.tool_calls)
        messages.append(results)
        continue
    break                           # 无工具调用 → 结束
```

**关键设计原则（务必抄）**：循环是否继续，**取决于这一轮的实际内容（有无 tool_calls），
而不是 LLM 返回的 stop_reason 元数据**。

```python
def stop_reason_for(turn):
    if turn.tool_calls:
        return None                      # 还要干活，继续
    if turn.provider_stop_reason == 'max_tokens':
        return LoopStopReason.MAX_TOKENS
    return LoopStopReason.FINAL_ANSWER   # 默认认定为完成
```

理由：某些 provider 会在"正在请求工具执行"时误报 `end_turn`。若信元数据，工具调用会被漏掉。
显式枚举 `LoopStopReason`：`FINAL_ANSWER` / `MAX_TOKENS` / `MAX_TURNS`。

**我们的差距**：我们是 `while (turn < maxTurns && !finished)`，靠模型自己把 `finished` 置位，
没有"这一轮是否真的产生了实质产出"的判据。模型只吐 tool_calls 不吐文字时，循环无条件继续。

---

## 二、轮次上限：不是越高越好，而是"快到上限先提醒收尾"

| 配置项 | WorkBuddy | 我们 |
|---|---|---|
| 主 Agent 最大轮次 | `CODEBUDDY_CODE_MAX_TURNS`，默认 **500** | 50（简单）/ 100（默认）/ 200（复杂） |
| 子 Agent 最大轮次 | `CODEBUDDY_CODE_SUBAGENT_MAX_TURNS`，默认 500 | 无子 Agent 体系 |
| 子 Agent 嵌套深度 | 上限 5 层，超出直接报错并建议"用你自己的工具完成剩余工作" | 无 |
| 每会话子 Agent 配额 | 默认 200，`/clear` 后重置 | 无 |

**真正值得抄的是它的收尾策略**（来自一份公开事故复盘）：

> `lib/agent.ts` 主循环有一个 `maxTurns` 硬上限（默认 40，可调）。
> **快到上限时先提醒模型一次必须调用 `submit_result` 收尾**；仍不收敛就抛错，
> 而不是让请求悬空挂起耗光资源。
>
> ```ts
> export class AgentTimeoutError extends Error {
>   constructor(public maxTurns: number) {
>     super(`已达到最大对话轮次(${maxTurns}),Agent 未提交结果`)
>   }
> }
> ```

要点有二：① **提前提醒**而非等到撞线；② 不收敛时**抛错终止**，不是无限等待。
我们原来的实现是 `turn > maxTurns - 5` 才提醒，而复杂任务 maxTurns=200 ——
模型能一路调查到 195 轮才第一次听到"该收尾了"。

> 本次已改为按轮次占比分级提醒（50% 温和 / 75% 强收敛 / 90% 禁止再调工具），
> 并新增"调查饱和检测"作为第二道闸。

---

## 三、上下文压缩：**按 token 占比分级 + 双 Agent**（核心差异）

这是 WorkBuddy 与我们差距最大的一块。我们只在 API 返回 413 时才压缩（被动、事后）；
WorkBuddy 是**按 token 占用百分比主动预防**。

### 3.1 双专职压缩 Agent

| Agent | 触发阈值 | 定位 | 产出 |
|---|---|---|---|
| `compact` | **40% token** | 预防性压缩 | `<conversation_history_summary>` 结构化摘要 |
| `contextSummary` | **90% token** | 抢救性压缩 | 9 段式结构 |

（另有资料描述为 10% 轻量预检 / 70% 深度压缩，或 30 轮 / 80% token——
不同版本或不同作者解读，但**"按占比分级、主动预防"**的架构是一致的。）

**一个极其重要的细节**：`compact` Agent 产出的摘要里会**明确写入指令
"所有任务已完成，不要重新执行"** —— 这是专门用来防止压缩后模型重复动作的设计。
我们压缩完从没给过这类约束，模型自然容易"压缩完又重来一遍"。

### 3.2 抢救性压缩的 9 段式结构

```
1. Primary Request and Intent   用户原始意图（压缩后仍保留）
2. Key Technical Concepts       技术概念
3. Files and Code Sections      关键文件与代码片段
4. Errors and fixes             遇到的错误与修复方式
5. Problem Solving              已解决 / 待解决问题
6. All user messages            所有用户消息（仅 contextSummary 模式）
7. Pending Tasks                未完成任务
8. Current Work                 正在进行的工作
9. Optional Next Step           可选下一步
```

### 3.3 四层渐进压缩管线（成本由低到高）

触发阈值 80,000 tokens，逐层尝试直到 token 降到阈值以下：

| 层 | 策略 | 代价 |
|---|---|---|
| L1 | `truncate_tool_results` —— 截断超过 5,000 tokens 的工具结果 | 低 |
| L2 | **`dedup_file_reads` —— 同一文件多次读取只保留最新结果** | 低 |
| L3 | `prune_old_messages` —— 丢弃 KEEP_RECENT_TURNS（默认 6）轮之前的旧消息 | 中 |
| L4 | `generate_summary` —— 用 LLM 总结整个对话历史 | 高 |

**永不压缩**：System Prompt（核心指令与身份）、Tool Definitions（模型必须始终知道有哪些工具）。

> **L2 `dedup_file_reads` 就是我们要找的东西** —— 我们那个失控 Agent 反复 grep 同一个文件，
> 如果有这层去重，上下文根本不会膨胀到 285KB。

---

## 四、输出外部化（Output Externalization）：把大结果"换出到磁盘"

把上下文窗口当有限的 RAM 用，工具输出就是可换出的页：

| 工具 | 换出阈值 | 保留策略 |
|---|---|---|
| Bash | 30,000 字符 | Head **6KB** + Tail **24KB** |
| 其他工具 | 50 KB | 同上 |

- 超阈值 → 全量写入磁盘，只给模型一个"指针"（小预览 + 文件路径）
- 模型需要完整数据时，用 read 工具触发"缺页"读回
- 保留 Head/Tail 的理由：让模型看到命令起始与**最终退出状态/错误摘要**，
  中间重复日志才是可以丢的部分

工具结果过长时还会明确告诉模型"结果不完整"，附总量、截断位置和继续读取方法——
**否则模型会把前 100 条误当成全部**。

---

## 五、Prompt Cache 友好型上下文组织

多轮对话每轮都带全量历史，全量重算成本不可接受。厂商按前缀缓存，因此组织规则是：

- System Prompt、基础工具定义、长期规则 → **放最前，内容与顺序保持稳定**
- 对话历史 → **只追加不修改**
- 当前文件、任务进度、时间、工具结果等动态内容 → **追加到尾部**
- 工具和 Skill → **按需加载**（先给名称+简述，命中任务再加载完整 Schema / SKILL.md）
- 只有压缩或纠错时才接受前缀变化和缓存重算

前置环节是**意图识别**：先选对方向，再按需展开，两者共同控制上下文规模。

---

## 六、其他值得借鉴的机制

| 机制 | 说明 |
|---|---|
| **Permission Hooks** | 工具调用前后拦截器，`ALLOW / DENY / ASK` 三态，GovernedToolRunner 统一执行 |
| **Audit Trail** | 哈希链审计日志（每条含 `prev_hash`），配 Head Anchor 防截断篡改 |
| **Workspace Boundary** | 路径解析为真实绝对路径，拒绝 `..` 与 symlink 逃逸 |
| **Deferred Loading** | 工具/技能两级加载，先用 ToolSearch 发现再 DeferExecuteTool 执行 |
| **Provider Adapter** | 归一化 Anthropic `tool_use` 与 OpenAI `function_call` 差异 |
| **Sub-Agent 输出消毒** | 子 Agent 回报前做非破坏性消毒：伪造标签改写、`Human:/Assistant:` 行首转义 |

---

## 七、对照表：我们的差距与已修项

| 维度 | WorkBuddy | 我们（本次前） | 本次后 |
|---|---|---|---|
| 循环停止判据 | 内容驱动（有无 tool_calls）+ 硬上限 | 仅靠模型置位 finished | 未改（待办） |
| 轮次上限 | 500（主）/ 500（子） | 50–200 | 不变 |
| 接近上限提醒 | 提前提醒 + 不收敛即抛错 | 最后 5 轮才提醒（200 轮任务 = 195 轮） | ✅ 分阶段（50/75/90%） |
| 停止机制 | 抛 AgentTimeoutError，不挂起 | ❌ 完全无 | ✅ `/api/chat/stop` + SSE 断开检测 |
| 上下文压缩 | 40%/90% 双 Agent 主动预防 | 仅 413 被动压缩 | 未改（**下个重点**） |
| 重复读取去重 | `dedup_file_reads` | ❌ 无 | 未改（**下个重点**） |
| 大输出外部化 | >30K 字符换出磁盘 | ❌ 无 | 未改（**下个重点**） |
| 循环检测 | ToolCallLoopDetector（参数相同） | 同款（但漏了参数各异的调查循环） | ✅ 新增调查饱和检测 |
| 消息序列清洗 | — | 只清孤立 tool_calls | ✅ 补 rc 盲区（55 个） |
| Prompt Cache 组织 | 稳定前缀 + 尾部动态 | 未显式设计 | 未改（待办） |

---

## 八、结论：下一步该抄哪三件事

按投入产出比排序：

1. **上下文按 token 占比主动压缩**（对齐 40%/90% 双阈值）
   —— 我们目前只有 413 被动压缩，长任务上下文会一路膨胀（实测失控案例 285KB）。
   压缩摘要里要**明确写"以下任务已完成，不要重新执行"**。
2. **`dedup_file_reads` 去重 + 输出外部化**
   —— 直接掐死"反复读同一文件"这类上下文膨胀源头，比事后循环检测更治本。
3. **循环停止判据改为内容驱动**
   —— 当前 `while (turn < maxTurns)` 完全信任模型主动收尾；
   应增加"连续 N 轮无文字产出且无新增交付物 → 强制要求输出结论"的判据。

---

## 参考来源

- WorkBuddy 官方文档 · 环境变量：`https://www.workbuddy.ai/docs/cli/env-vars`
- WorkBuddy 官方文档 · Sub-Agents：`https://www.workbuddy.ai/docs/cli/sub-agents`
- learn-workbuddy · Agent Loop (s01)：`https://deepwiki.com/adongwanai/learn-workbuddy/2.1-agent-loop-(s01)`
- learn-workbuddy · Output Externalization & Context Compaction (s13–s14)：
  `https://deepwiki.com/adongwanai/learn-workbuddy/4.3-output-externalization-and-context-compaction-(s13-s14)`
- 公开事故复盘（maxTurns 硬上限与收尾提醒）：腾讯云开发者社区
- 上下文两级压缩与 Prompt Cache 组织：多篇 WorkBuddy 技术拆解文章
