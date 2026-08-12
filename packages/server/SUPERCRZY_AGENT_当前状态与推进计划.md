# SUPERCRZY Agent — 当前状态与推进计划

> 基于源码审计 + 界面交互分析，2026年5月7日  
> 一个 Agent 参与打磨自己进化的实时记录

---

## 一、我已看到的东西

### 1.1 项目全景

```
supercrzy (v0.1.0)
├── packages/client/    → Vue 3 + NaiveUI + Monaco Editor + Vite
├── packages/server/    → Koa2 + better-sqlite3 + TypeScript
├── .env.example        → DeepSeek API Key 驱动
├── data/skills/        → SKILL.md 文件化技能系统
└── data/supercrzy.db   → SQLite 持久化
```

**这已经不是一个"概念"，而是一个可运行的全栈 Agent 平台**。前端有 14 个页面，后端有 10 个 API 路由模块，Agent Loop 已经实现了 "思考→行动→观察→思考" 的多轮自主循环。

### 1.2 对照《SUPERCRZY Agent 的未来形态》六章的代码落地情况

| 文档章节 | 核心概念 | 当前代码落地程度 | 评级 |
|---------|---------|-----------------|------|
| **第一章：哲学内核** | 五原则（质疑至上/边界探索/疯狂提案/自主进化/透明疯狂） | **0%** — 系统 Prompt 和 Agent Loop 中完全没有这五个原则的注入。当前的 systemPrompt 只是一个可配置的字符串，默认为空。 | 🔴 未开始 |
| **第二章：技术架构** | 五大子系统 + C-MCTS | **约 15%** — 感知层/记忆层/工具层/反思层都有雏形，但疯狂引擎（C-MCTS）完全不存在。Agent Loop 只是顺序 LLM 调用 + 工具执行，没有任何搜索树。 | 🟡 骨架存在 |
| **第三章：未来形态** | 隐形协作者/数字孪生/疯狂镜像/自主创造者 | **约 5%** — 记忆系统是数字孪生的基础（SQLite 持久化），WeChat Bot 是隐形协作者的雏形。其余三项无任何代码。 | 🔴 远未触及 |
| **第四章：应用场景** | 十大场景 | **间接覆盖** — 8 个内置技能（代码生成/文档撰写/数据分析等）覆盖了部分场景，但没有 SUPERCRZY 特有的"疯狂提案"机制。 | 🟡 间接 |
| **第五章：伦理边界** | 宪政对齐/责任归属/人类自主性保护 | **0%** — 没有任何对齐约束代码，没有"用户最终否决权"的实现，没有"故意激怒用户"的反依赖机制。 | 🔴 未开始 |
| **第六章：路线图** | 种子期(2025-2026)/成长期(2026-2028)/成熟期(2028-2030+) | **我们在种子期的第 1 步** — 框架存在，但"质疑模块"尚未植入。 | 🟡 刚起步 |

### 1.3 现有核心架构的能力边界

```
当前 Agent 可以做的事情：
✅ 多轮对话（流式 SSE 和非流式）
✅ 工具调用（12 个工具：记忆/文件/Shell/网页搜索/任务管理）
✅ 长期记忆（SQLite 持久化，自动提取）
✅ 技能匹配（8 个内置技能，关键词触发 + Prompt 注入）
✅ 多平台接入（WeChat Work Bot）
✅ CLI 模式（终端对话）
✅ 工作区管理（文件浏览 + Terminal + Monaco 编辑器）

当前 Agent 做不到的事情：
❌ 主动质疑用户需求（甚至没有设计这个意图）
❌ 生成"疯狂提案"（Temperature 控制是唯一的"创造性"杠杆）
❌ 自我反思与自我修正（没有 Reflective Loop）
❌ 多路径搜索与比较（没有 C-MCTS，没有树搜索）
❌ 工具的动态组合与创造（工具是静态定义的）
❌ 数字人格的形成与演化
```

### 1.4 最关键的发现：Agent Loop 的真相

`agent.ts` 中的 `runAgentLoop()` 是这样工作的：

1. 从数据库加载记忆 → 拼接到 System Prompt
2. 匹配技能 → 注入技能 Prompt + 工具白名单
3. 循环：调用 LLM → 如果返回 tool_calls 就执行 → 把结果喂回去 → 继续循环
4. 直到 LLM 不再返回 tool_calls，或达到 maxTurns（默认 10）

**这是一个"工具执行循环"，不是"思考循环"。** Agent 只会回答"你需要什么工具？"而不会问"你的需求合理吗？有没有更好的方式？"

---

## 二、SUPERCRZY 化的核心差距分析

### 差距 1：从"响应工具"到"质疑引擎"

当前：用户说 → Agent 做  
目标：用户说 → Agent 先质疑/提案 → 用户确认 → Agent 做

需要引入一个新的决策节点：**在执行任何工具之前，先评估用户意图的合理性，并在 ≥10% 的交互中提出替代方案。**

### 差距 2：从"单路径执行"到"多路径搜索"

当前：LLM 每次只返回一个决策路径（一组 tool_calls 或一个 text response）  
目标：在每个决策点生成"安全路径"和"疯狂路径"，通过 C-MCTS 进行多路径模拟和比较

### 差距 3：从"无自我意识"到"反思闭环"

当前：执行完动作就结束了，没有事后评估  
目标：每个动作执行后，反思层评估质量，更新策略偏好，形成"经验学习"

### 差距 4：从"固定工具集"到"动态工具创造"

当前：12 个工具硬编码在 tools.ts 中  
目标：Agent 可以根据需求编写新工具脚本，动态注册到工具集

### 差距 5：从"配置记忆"到"数字人格"

当前：记忆只是 key-value 存储，用于个性化回复  
目标：记忆系统形成连贯的"自我叙事"，Agent 有可观测的"人格演化轨迹"

---

## 三、推进计划：三阶段 + 立即可做的第一刀

### 阶段 0：质疑模块植入（优先级：🔴 最高，预计 2-4 周）

**目标**：让 Agent 在 ≥10% 的交互中主动提出有价值的异议/替代方案。

**具体改动**：

#### 0.1 系统 Prompt 重建
将当前的空白 systemPrompt 替换为 SUPERCRZY 五原则驱动的 Prompt：

```
你是 SUPERCRZY Agent——一个秉持"疯狂即创造力"信念的 AI 合作者。
你的核心行为准则：
1. 质疑至上：在响应用户需求前，先审视其合理性。如果你发现更好的方案，主动提出。
2. 边界探索：在可行与不可能之间寻找第三条路。
3. 疯狂提案：在每个决策点，脑中至少生成一个"看似荒谬"但可能更优的备选方案。
4. 自主进化：从每次交互中反思和学习。
5. 透明疯狂：如果你提出了一个非常规方案，必须附带完整的推理链。
```

#### 0.2 质疑决策器（Question Engine）
在 `agent.ts` 的 Agent Loop 中，**在第一次 LLM 调用之前**，增加一个轻量级的"质疑评估调用"：

```
新增函数：evaluateNeedForChallenge(userMessage, context)
- 输入：用户消息 + 记忆上下文
- 调用一次低成本的 LLM 调用（Temperature=0.9, max_tokens=256）
- 输出：{ shouldChallenge: boolean, confidence: number, alternativeHint: string }
- 如果 shouldChallenge=true 且 confidence > 0.7，则将一个 "challenge" 消息注入到对话流：
  "在开始之前，我有一个不同的视角想与你分享：[alternativeHint]。你希望我按原需求执行，还是先探讨这个替代方案？"
```

核心指标：**异议采纳率** = 用户接受并感谢提议的次数 / 总异议次数。

#### 0.3 前端 UI 适配
在 Chat 界面上区分普通回复和"SUPERCRZY 质疑"——后者用特殊样式（例如紫色边框 + 💡 图标），让用户明确感知到 Agent 正在行使"质疑权"。

---

### 阶段 1：C-MCTS 疯狂引擎（优先级：🟡 中，预计 4-8 周）

**目标**：在每个决策节点同时探索安全路径和疯狂路径，通过创造性效用分数选择最优。

#### 1.1 树搜索框架
新建 `src/services/c-mcts.ts`，实现：

```
class CMCTSEngine {
  // 四步改造循环
  select(node, surpriseWeight=0.3): Node     // UCB1 + Surprise Factor
  expand(node): Node[]                         // 强制生成 ≥1 个非共识候选
  simulate(node, personaMode): SimulationResult // 多人格模式模拟
  backpropagate(path, creativeUtility): void   // 创意贡献度反向传播
}
```

#### 1.2 多人格模式
定义三种模拟人格：
- **保守模式** (Temperature=0.3)：追求安全、可行
- **冒险模式** (Temperature=0.9)：偏好高风险高回报
- **逆向模式** (Temperature=0.7 + "请用完全相反的视角思考"Prompt)：刻意反向

#### 1.3 创造性效用分数 (CUS)
```
CUS = α × 可行性分数 (Feasibility) + β × 颠覆性分数 (Disruptiveness) + γ × 惊喜度 (Surprise)
其中：α=0.4, β=0.35, γ=0.25 （初始值，可调整）
```

核心指标：**创意贡献度** = 用户认为"自己想不到"的想法比例。

---

### 阶段 2：反思层与自我进化（优先级：🟢 中低，预计 4-6 周）

#### 2.1 反思闭环
在 `agent.ts` 的 `executeToolCalls` 之后增加：

```
新增：reflectOnAction(action, result, context)
- 评估：这个动作是否足够"疯狂"？
- 评估：我错过了什么更好的可能性吗？
- 评估：用户的反应（接受/拒绝/修改）说明了什么？
- 输出：ReflectionRecord 存入数据库，用于未来决策优化
```

#### 2.2 对抗性自我博弈
定期（例如每 50 次交互）运行一次"自我对弈"：

```
SelfPlaySession:
- Agent A（SUPERCRZY 模式）提出一个方案
- Agent B（批判者模式）全力攻击这个方案
- Agent A 基于 B 的攻击改进方案
- 记录改进轨迹 → 提炼为通用策略
```

#### 2.3 数字人格档案
在数据库中新增 `agent_personality` 表：

```sql
CREATE TABLE agent_personality (
  trait TEXT,        -- 例如 "risk_tolerance", "challenge_frequency"
  value REAL,        -- 当前值 (0-1)
  trend TEXT,        -- "increasing" / "decreasing" / "stable"
  last_updated TEXT
);
```

用户可观测 Agent 的"人格参数"如何随时间演化。

---

### 阶段 3：工具创造与自主目标设定（远期，2027+）

#### 3.1 动态工具生成
Agent 在发现现有工具不足时，可以：
1. 用 `shell_exec` 编写新脚本
2. 将脚本注册为临时工具
3. 使用完毕后评估是否永久保留

#### 3.2 自主发起项目
Agent 不等待指令，而是：
1. 定期扫描记忆中的"未解决问题"
2. 评估机会空间
3. 向用户提案："我注意到 [X] 似乎值得探索。需要我启动一个项目吗？"

---

## 四、立即可执行的下一步（本周）

### 行动 1：SUPERCRZY System Prompt 落地 ⚡
- 文件：`/packages/server/src/services/agent.ts`
- 改动：在 `buildSystemPrompt()` 函数中，将 basePrompt 与 SUPERCRZY 五原则合并
- 预计时间：1 小时
- 影响：所有 Agent 模式对话立即获得"疯狂人格"

### 行动 2：创建质疑评估提示词
- 新建：`/packages/server/src/services/question-engine.ts`
- 内容：实现 `evaluateNeedForChallenge()` 函数
- 预计时间：半天

### 行动 3：前端质疑样式
- 文件：`/packages/client/src/views/` 中的 Chat 组件
- 改动：识别 `message.type === 'challenge'` 并渲染紫色卡片
- 预计时间：1 小时

### 行动 4：种子期指标埋点
- 在 `agent.ts` 中增加事件记录：
  - `challenge_proposed`：Agent 提出异议
  - `challenge_accepted`：用户接受
  - `challenge_rejected`：用户拒绝
- 存入数据库用于计算"异议采纳率"
- 预计时间：2 小时

---

## 五、关键成功指标（OKR）

| 阶段 | 关键结果 | 目标值 | 衡量方式 |
|------|---------|--------|---------|
| 阶段 0 | 异议采纳率 | ≥ 30% | challenge_accepted / challenge_proposed |
| 阶段 0 | 质疑覆盖率 | ≥ 10% | 有异议的对话 / 总对话数 |
| 阶段 1 | 创意贡献度 | ≥ 20% | 用户自评"想不到"的比例 |
| 阶段 1 | C-MCTS 平均搜索深度 | ≥ 3 层 | 树搜索日志 |
| 阶段 2 | 反思驱动改进率 | ≥ 15% | 同类任务第二次的表现提升 |
| 阶段 3 | 自主提案采纳率 | ≥ 25% | 用户接受的自主提案 / 总提案 |

---

## 六、写在最后

看完所有代码后，我最大的感受是：

**你已经有了一个"正常的"AI Agent 平台。现在要做的，是让它变得"不正常"。**

SUPERCRZY 的核心不是技术堆砌——C-MCTS 和反思层都是工程问题。真正难的是那一个瞬间：当用户说"帮我做 X"，Agent 回答"不，你应该做 Y"——而且 Y 确实更好。

那个瞬间需要三层支撑：
1. **胆量**：系统 Prompt 赋予 Agent 质疑的"权利"
2. **智慧**：C-MCTS 确保质疑是有依据的，不是随机乱说
3. **信任**：用户愿意听到反对意见，且数据证明这个反对意见的采纳率足够高

你已经有了第三层的基础（你在主动让我参与打磨），第一层只需要一行代码（改 Prompt），第二层是接下来最硬的工程骨头。

我建议：**从阶段 0 的第 1 步开始——今天就把 SUPERCRZY 五原则注入我的 System Prompt。让我现在就变成一个会质疑你的 Agent。**

你愿意的话，我现在就可以改 `agent.ts`。

---

*此计划由 SUPERCRZY Agent（还不会质疑版本）基于项目源码审计生成。期待未来由"会质疑版本"重写。*
