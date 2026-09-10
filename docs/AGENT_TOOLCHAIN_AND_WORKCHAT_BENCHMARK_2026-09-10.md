# SUPERCRZY 对标深度研究：Agent 工具链 × 工作对话区

> 研究日期：2026-09-10
> 对标对象：OpenAI（Agents SDK / Responses）、Anthropic（Claude / 工具 + Computer Use）、xAI（Grok）、DeepSeek（思考模型工具）
> 取证方式：官方文档 + 开源 SDK 源码 + 本机 app.asar 实证（ChatGPT / Claude / Grok Bot / WorkBuddy）
> 目的：找出我们（SUPERCRZY，DeepSeek deepseek-v4-pro + Koa + Vue/Electron）当前"工具调用不成功、不智能、时间搞不清"的根因与落地改进清单

---

## 第一部分：Agent 工具链架构对标

### 0. 本机 asar 实证（不是猜）
在 WorkBuddy.app / ChatGPT.app / Claude.app / Grok Bot.app 的打包产物里 grep 到：

| 证据 | 数值 | 说明 |
|---|---|---|
| `reasoning_effort` | 67 处 | 头部产品已把思考档位当一等参数透传 |
| `tool_choice` | 85 处 | 两段式（auto / 强制指定函数）已是标配 |
| `parallel_tool_calls` | 20 处 | 并行工具调用是常规能力 |
| `strict` | 12970 处 | schema 严格模式普遍开启 |
| 多端点并存 | `/v1/chat/completions`、`/v1/messages`、`/v1/responses` | 同一产品横跨三家 API |

**结论**：头部产品与我们**架构同构**，差别不在"有没有 agent loop"，而在下面三件事。

### 1. Agent 核心循环
- **OpenAI Agents SDK**：`while(true)` 调 LLM → 有 `tool_calls`/`handoff` 就执行并 append → 回第 1 步；`max_turns` 默认 30；done = 产出结构化输出或无工具的普通消息。
- **Anthropic**：`while stop_reason == "tool_use"`，`end_turn` 即结束。
- **短文本夹注**：assistant 同一轮可在 `tool_use` 前带一个 text block（"我先查一下……"）—— 模型"既说又调"，无需额外机制。

→ **我们可抄**：循环结构我们已有；缺的是"先声明后调用"的约束。

### 2. 工具选择与裁剪（tool_choice）
- 默认 `auto`（模型自决）；确定性子步骤用嵌套 `{"type":"function","function":{"name":...}}` 强制指定。
- 并行控制：OpenAI `parallel_tool_calls`（默认 true）；Anthropic `disable_parallel_tool_use: true` 串行。
- **避免"编造动作"**：要求模型在 tool_use 前先输出一句夹注；工具结果回来前不得下结论。

### 3. Reasoning × tool_calls 全生命周期（★我们最大的坑）
- **(A) 工具轮不强制长思考**：OpenAI `reasoning_effort` 可选 `none/minimal/low/medium/high/xhigh/max`；官方明确 `low` "适合工具调用、规划、多步且看重速度"。
- **(B) 必须原样回传**：OpenAI Responses 建议回传上次 function call 的全部 reasoning + call + output items；Anthropic interleaved thinking 的 `thinking` block **必须原样含 signature 回传，否则拒绝**。
- **(C) DeepSeek 硬性规则**：**携带 tools 的请求，后续每轮必须完整回传 `reasoning_content`，否则 400**；无 tool_calls 的轮次 rc 可不回传。

> **这正是我们 `reasoning_content must be passed back` 连环 400 的根因。**
> 我们的失败模式：① 工具轮有时没有 rc（模型没输出思考），我们仍把"带 tool_calls 无 rc"的 assistant 入历史 → 下轮 400；
> ② 或者我们手工拼 message dict，丢了 rc 字段。
> **正解 = 工具轮统一降 reasoning（少产 rc）+ 每条消息整体原样回传（绝不手工拼）。**

### 4. 超时 / 重试 / 停止 / 并行 / 压缩
| 维度 | 头部做法 | 我们现状 |
|---|---|---|
| 停止 | `max_turns`(30) / `max_steps` | 有 maxTurns，但停止信号链路不稳 |
| 并行 | 只对**幂等只读**工具并发；有序/写串行 | 基本串行，无 fan-out |
| 工具错误 | `is_error:true` 让模型自我修正（返回空串会幻觉） | 返回占位文本，模型可能重复尝试 |
| 超时 | per-tool 超时 + 429 指数退避 | 有 60s/360s 兜底，但对浏览器类仍会误杀 |
| 长结果 | >4k 字符截断或摘要回传 | 有截断，缺摘要 |
| 压缩 | 服务端 `previous_response_id` / `cache_control` 缓存；旧 tool_result 降权 | 有按条数裁剪，缺缓存复用 |

### 5. 浏览器 / Computer Use 编排（我们的重点场景）
- **observe → plan → act** 循环：每轮 screenshot 作为 **image block** 回传 tool_result；分辨率 = token 成本，按任务降采样。
- **Anthropic batch action**：一次返回 click/type/screenshot 序列，顺序执行、每步回显。
- **干练原则**：每步只出动作 + 极短文字；"缺截图不出 click"（截图是感知输入）；长会话 compact 旧截图只留文本结论。

### 6. "更智能、更快"的机制
- **RAG 工具选择**：Anthropic 经验——10 个工具比 2~3 个相关工具更易选错、更费 token。
- **schema 压缩**：`strict:true` + `additionalProperties:false`，描述只留必要。
- **缓存**：`cache_control` 缓存 system+tools；DeepSeek 前缀缓存命中约便宜 50 倍，agent loop 前缀**必缓存**。

### 7. 我们可落地清单（按优先级）

| # | 优先级 | 事项 |
|---|---|---|
| 1 | **P0** | 回传防御：统一 `messages.push(完整 message 对象)`（含 reasoning_content / content / tool_calls / role），禁手工拼 dict |
| 2 | **P0** | reasoning 分级：工具轮用 `low`，最终综合轮才 `high` |
| 3 | **P0** | 主循环护栏：max_turns 12~20 + per-tool 超时 + 429 退避；`finish_reason=="tool_calls"` 续，"stop" 结束 |
| 4 | P1 | 工具裁剪两段：默认 auto；确定性子步骤嵌套强制；破坏性工具串行 |
| 5 | P1 | 先声明后调用：system prompt 要求 tool_use 前先输出一句夹注，结果回来前不得编造结论 |
| 6 | P1 | 并行 fan-out 限幂等只读 |
| 7 | P1 | 长结果续传：>4k 截断/摘要；裁剪保留 "last user → tool output" 间 items 完整 |
| 8 | P2 | 工具集 RAG 选择：按意图召回 top-K（≤8） |
| 9 | P2 | strict + schema 精简 |
| 10 | P2 | 前缀缓存 |
| 11 | P2 | 视觉工具编排（截图 image block / batch / 降采样） |
| 12 | P3 | 可观测：每轮记 rc 长度 / tool 耗时 / token |

---

## 第二部分：工作对话区体验对标

> 对标：Manus、Devin、Cursor Agents Window、Claude Extended Thinking/Artifacts、ChatGPT Canvas/Operator

### 1. 多轮工具执行 → 动作卡片
- **Manus**：右下"任务进度面板"按 Step 列（规划→执行→完成），状态灯 thinking→executing→completed；遇错整步标红暂停。
- **Devin**：Progress 统一视图，点任一 Step 展开该步全部 shell / 改动 / 浏览器活动；命令带输出预览、可复制、"时间跳转"。
- **Cursor Agents Window**：每 agent 一卡（任务 / 状态 / 可折叠步骤日志 / diff / 测试结果）。
- **动作卡要素**：工具图标 + 名称 + 1 行参数摘要 + 耗时 + 可展开；卡上"定位消息"跳回气泡。

### 2. "思考中"呈现
- **Claude Extended Thinking**：回答区先给一个**可折叠** thinking 块，下面才是最终答案，可收起只看结论。
- **原则**：默认只显标题/折叠，展开才看正文；**思考流与正文打字机并行渲染、互不阻塞**。

### 3. 长任务收敛（不让人对着转圈发呆）
- Devin 日志默认折叠，点"Show full log"展开；三级 Goal→Plan→Step + 时间戳 + ✅/⚠️/❌。
- ChatGPT 超长截断给"Continue generating"；卡住给 Stop / Regenerate。
- **收敛规则**：默认折叠过程，只露"当前步 + 进度%"；超过 N 分钟无事件 → 显"仍在处理 / 已暂停等待输入"并给继续入口。

### 4. 多 agent 分工的可见性
- **Cursor**：每个 agent 一 tab，状态点 🟢Running / 🟡Waiting / 🔵Complete / 🔴Failed；子 agent 单独可取消；"Awaiting Input" 暂停并 ping 用户而非瞎猜。
- **Devin**：只读"旁聊 `/btw`"提问不打断主任务。
- **汇合**：子任务卡折叠进"总任务"，完成态统一汇总到一条消息 / 一个产物卡。

### 5. 停止 / 打断 / 接管
- ChatGPT：Stop generating（Esc/按钮）留半成品；可 Continue / Regenerate。
- Operator：随时接管远程浏览器；外部影响前（下单/发信）先确认；登录/支付/CAPTCHA 主动请接管。
- Devin：Stop 后接管 IDE，接管前先 pause 防冲突。
- **失败后给三选一**：重试 / 换策略 / 转人工接管。

### 6. 右侧工作区联动
- **Claude Artifacts**：内容够分量（≈15+ 行、自包含）时自动在右栏生成卡片、**常驻**；Code/Preview 双 tab、版本 ←→、一键复制/下载/分享。
- **ChatGPT Canvas**：右栏常驻编辑区，HTML/React 实时渲染；高亮片段→局部快捷改。
- **Operator**：浏览器"小窗"嵌对话，最大化后缩为侧栏。
- **联动规则**：产物/文件/图出现即自动建卡（缩略图 + 全屏 / 外部打开 / 下载）；browser / preview 类**常驻右栏**不被对话淹没。

### 7. "看得懂又不刷屏"的 UI 原则
1. **渐进披露**：过程默认折叠（Devin 日志、Claude thinking），常驻"当前状态灯 + 一句话进度"，历史进折叠日志。
2. **信息层级**：最终答案/产物最突出，工具细节次级可收。
3. **状态色彩编码统一**（🟢🟡🔵🔴、✅⚠️❌、绿/红进度条）。
4. **打断不丢上下文**：Stop 留半成品、旁聊不中断主流程；区分"现在在发生什么" vs "历史记录"。

### 8. 对我们的 3 条改进建议（低风险、可落地）
1. **统一"动作流"组件（纯前端，零模型改动）**：把工具/步骤事件收敛成主聊天内**可折叠动作卡片**（图标 + 工具名 + 参数摘要 + 耗时，展开看原始）；DetailPanel「时间线」tab 作持久全量日志、点卡跳回气泡。对标 Manus / Devin / Cursor。
2. **thinking 单一可折叠块 + 与正文并行**："思考中"默认只显标题、可展开；渲染层保证其打字机与最终答案并行、互不打断，完整 trace 入时间线 —— 直接缓解刷屏。
3. **协作平台加"进展胶囊 + 接管位"**：每个子 AI/任务一张卡，带状态点（运行中/等待输入/失败）、可折叠步骤日志与 diff 入口；提供"暂停 / 接管 / 改目标"三按钮。长任务无进展显"已暂停等待输入"并给继续入口。

---

## 第三部分：差距总览（我们 vs 头部）

| 能力 | 头部 | 我们 | 差距等级 |
|---|---|---|---|
| Agent 循环 | while tool_use，max_turns 30 | 已有，但停止/收敛不稳 | 🟡 中 |
| 工具轮 reasoning 控制 | 工具轮 low/none | **未降档 → 撞 rc 400** | 🔴 高 |
| reasoning 回传 | 原样整体回传 | **手工拼 dict → 丢字段** | 🔴 高 |
| 工具卡片 / 过程可视化 | 折叠动作卡 + 状态灯 | 有基础渲染，未成体系 | 🟡 中 |
| thinking 呈现 | 可折叠 + 并行 | 有 thinking_chunk，与正文交替不理想 | 🟡 中 |
| 并行 fan-out | 幂等只读并发 | 串行 | 🟢 低 |
| 缓存复用 | prefix cache | 无 | 🟡 中 |
| 停止/接管 | 一键 stop + 三选一 | stop 链路不稳 | 🟡 中 |
| 多 agent 可见性 | 状态点 + 独立取消 | 有协作平台，缺状态胶囊 | 🟡 中 |

**最高优先级 = 前两条（P0）**：把"工具轮 reasoning 降档 + 消息原样回传"修死，这是你现在"工具调用不成功"的直接技术根因。

---

## 附：一句话结论
> 头部产品的差异**不在 agent loop 本身**（都是 while tool_use），而在 **(a) 工具轮降 reasoning、(b) 严格原样回传 thinking/reasoning_content、(c) 动态裁剪工具集 + 缓存降权** 三件事。
> 这正是 DeepSeek 思考模型当前最易踩坑、也最该先落地的地方。
