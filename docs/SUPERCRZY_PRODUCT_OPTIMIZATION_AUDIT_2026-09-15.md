# SUPERCRZY BOT 产品问题发现与优化方案报告

> 审查版本：`supercrzy-bot 0.3.0`
>
> 审查对象：`/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent`
>
> 开发架构：Vite 前端 `5173` → Koa API `3000`
>
> 审查日期：2026-09-15
>
> 说明：本报告针对旧版 5173 开发架构编写。项目手册、历史审计文档属于项目背景和既有决策，不等同于本报告的用户需求；本报告结论以当前旧版源码、配置和可执行校验结果为准。

---

## 1. 结论摘要

SUPERCRZY BOT 已经不是一个简单的聊天 Demo，而是一个具备以下能力的 Agent 工作台：

- Agent 多轮循环、工具调用、SSE 流式输出；
- 工作区文件浏览、文件变更、Diff、HTML 预览；
- 任务计划、检查点、恢复和错误分类；
- Playbook 经验复用、长期记忆、技能系统；
- 沙箱、工具审批、MCP、浏览器自动化；
- 多模型、协作平台、自动化和多平台网关；
- Web/PWA + Electron 双形态。

项目当前最大的短板不是能力数量，而是三件事：

1. **开发交付基线不够干净**：客户端 `lint` 当前失败，测试和构建在当前目录受到 `EPERM` 写入权限影响；
2. **产品入口过于复杂**：能力很多，但普通用户不容易理解“从哪里开始、Agent 会做什么、结果在哪里”；
3. **核心任务闭环仍需产品化**：从任务输入、计划确认、执行、等待用户、失败恢复到交付物复用，还需要更统一的任务状态模型。

总体建议：暂时停止继续堆叠新能力，先围绕“用户安全地完成一次任务并拿到可复用结果”做一次产品收敛。

---

## 2. 当前状态与校验结果

### 2.1 已确认的架构事实

旧版开发链路是正确的：

```text
浏览器 http://localhost:5173
        │
        │ Vite proxy: /api、/ws
        ▼
Koa API http://localhost:3000
        │
        ├── /api/chat/agent  SSE Agent 流
        ├── /api/workspace  工作区文件服务
        ├── /api/checkpoints 检查点
        └── /ws/terminal    终端 WebSocket
```

证据：

- [packages/client/vite.config.mjs](/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/client/vite.config.mjs:10)
- [packages/client/src/views/ChatView.vue](/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/client/src/views/ChatView.vue:3419)
- [packages/server/src/routes/chat.ts](/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/src/routes/chat.ts:1)

### 2.2 校验结果

| 校验项 | 结果 | 说明 |
|---|---|---|
| 服务端 TypeScript lint | 通过 | `pnpm --filter @supercrzy/server lint` 通过 |
| 客户端 TypeScript lint | 失败 | `DetailPanel.vue` 的 tabs 类型缺少 `icon`、`label` |
| 全量 `pnpm lint` | 失败 | 被客户端 lint 阻断 |
| 客户端 build | 失败 | 同一处类型问题，同时当前环境写入 `tsbuildinfo` 受到 EPERM 影响 |
| 服务端 build | 类型检查未发现同类错误 | 输出 `dist` 时受到 Downloads 目录 EPERM 影响 |
| 全量测试 | 未完成 | Vitest 在生成 `.vite-temp` 配置文件时受到 EPERM 影响 |
| 测试资产 | 已存在 | 服务端和客户端均已有测试文件，基础优于早期版本 |

### 2.3 工作区状态风险

当前旧版仓库存在未提交修改和新增文件。建议将当前版本先做一次基线提交或打包备份，再开始优化，避免产品重构过程中无法区分既有改动和新改动。

### 2.4 本轮复核结论

本报告中的问题并不都属于同一种“问题”。复核后应这样理解：

| 项目 | 复核结论 | 证据强度 | 备注 |
|---|---|---|---|
| 客户端 lint 失败 | **已确认** | 直接命令输出 + 源码 | `DetailPanel.vue` 的 tabs 类型缺少字段 |
| 构建/测试 EPERM | **已确认发生，但不等于业务 bug** | 直接命令输出 | 当前 Downloads 目录和 `node_modules/.vite-temp` 不可写；需用 CI/可写目录复验 |
| 5173 → 3000 代理链路 | **已确认设计正确** | Vite 配置 + 调用路径 | 不能把旧版误判成 Socket.IO 链路问题 |
| 权限审批 | **已确认已有后端实现** | `agent.ts` 执行分流逻辑 | 当前主要问题是权限选项复杂、运行时场景需要验收，不是“前端假确认” |
| 文件路径安全 | **已确认已有防护** | `filesystem.ts`、`workspace.ts`、`sandbox.ts` | 仍需补充越界、符号链接、远程访问场景测试 |
| 任务状态统一性 | **部分确认** | 多处状态实现 | 已有 plan/checkpoint/collab 状态，但跨模块仍未统一为一个状态机；属于架构优化，不是已证明的单一 bug |
| 导航和功能过载 | **产品判断已确认** | 路由和主布局 | 属于可用性问题，需要新用户任务测试进一步量化 |
| reasoning/工具过程过密 | **产品判断已确认** | ChatView/Timeline/ToolCall UI | 不代表功能错误，重点是默认信息层级需要优化 |
| 工具 schema 与执行器不一致 | **本轮未确认当前版仍存在** | 静态数量核对 | 当前源码简单核对得到工具执行器和定义数量均为 40；仍需做运行时注册覆盖测试 |
| ChatView/DetailPanel 体量过大 | **已确认** | 文件行数 | 属于维护性风险，不等于当前功能故障 |

因此，后续实施时应优先修复“已确认硬问题”，对其余项目采用用户场景测试和运行时测试验证，不应把所有建议都当成紧急 bug 修复。

---

## 3. 问题分级总表

| 编号 | 问题 | 优先级 | 影响范围 | 推荐动作 |
|---|---|---:|---|---|
| P0-01 | 客户端 lint 失败 | P0 | 发布、CI、Electron 打包 | 先修复 DetailPanel 类型定义 |
| P0-02 | 测试/构建依赖不可写目录 | P0 | 新用户安装、CI、开发体验 | 调整缓存和输出目录，增加 CI 验证 |
| P0-03 | 任务状态模型分散 | P0 | 停止、恢复、失败、自动化、协作 | 统一 Task State Machine |
| P0-04 | 权限概念过多且用户不可理解 | P0 | 安全感、首次使用、远程访问 | 收敛成三档用户权限 |
| P1-01 | 首页和导航功能过载 | P1 | 普通用户学习成本 | 默认只突出任务、历史、产物、设置 |
| P1-02 | Agent 过程信息密度过高 | P1 | 可读性、移动端体验 | 默认展示阶段摘要，详情按需展开 |
| P1-03 | 工具 schema 与执行器长期维护成本高 | P1 | 模型可靠性、上下文成本 | 工具注册中心 + 动态工具集 |
| P1-04 | ChatView 与 DetailPanel 体量过大 | P1 | 迭代速度、回归风险 | 按消息、输入、任务、产物拆分 |
| P1-05 | 结果交付能力强但叙事不统一 | P1 | 用户是否觉得“任务完成” | 统一交付摘要与产物中心 |
| P2-01 | 自动化、多平台、MCP 等入口过早暴露 | P2 | 产品聚焦度 | 放入高级能力/设置区域 |
| P2-02 | 观测指标还应进一步产品化 | P2 | 定位慢、贵、失败问题 | 建立任务级可观测性 |

---

## 4. 详细问题与最佳修复方案

### P0-01：客户端类型检查失败

问题位置：

- [DetailPanel.vue](/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/client/src/components/layout/DetailPanel.vue:12)
- [DetailPanel.vue](/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/client/src/components/layout/DetailPanel.vue:767)

当前 `tabs` 数组被 TypeScript 推断成只有 `{ key: string }`，但模板读取了 `tab.icon` 和 `tab.label`，导致客户端 lint 和 build 失败。

最佳修复：

```ts
interface DetailTab {
  key: 'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser'
  label: string
  icon: string
}

const tabs: DetailTab[] = [...]
```

验收标准：

- `pnpm --filter @supercrzy/client lint` 通过；
- `pnpm --filter @supercrzy/client build` 通过；
- 产物、文件、变更、预览、时间线、浏览器 Tab 都能正常切换。

### P0-02：构建和测试不能稳定写入输出目录

当前命令在 `Downloads` 目录执行时，Vitest 无法写入 `node_modules/.vite-temp`，TypeScript 无法写入 `tsconfig.tsbuildinfo` 和 `server/dist`。

这不完全是业务代码问题，但对大众产品一样是问题：用户安装、CI、Electron 打包都不能依赖某个特殊目录权限。

最佳修复：

1. 将 Vite/Vitest 临时目录移到可写的项目内 `.cache/` 或系统临时目录；
2. 将 `tsbuildinfo` 放到明确的 `.cache/typescript/`；
3. build 前检查 `dist`、缓存目录是否可写，并给出清晰错误；
4. 在 CI 使用普通用户执行完整命令；
5. 增加一个 `pnpm verify`：

```bash
pnpm lint
pnpm test
pnpm build
```

验收标准：在新目录 clone、普通权限、无全局配置的情况下，三条命令都能通过。

### P0-03：任务状态不是统一的状态机

目前任务状态分散在：

- Agent loop；
- SSE 事件；
- 前端 `aiStatus`；
- 工具卡片状态；
- Plan Capsule；
- Checkpoint；
- 协作平台状态；
- 自动化任务状态。

这会导致“前端显示完成，但后端仍在执行”“流断了但任务不知道是否可恢复”“用户点击停止后工具仍可能继续”等问题难以统一处理。

最佳修复是建立统一状态机：

```text
created
  ↓
planning
  ↓
awaiting_approval
  ↓
running
  ├── waiting_user
  ├── paused
  ├── failed
  ├── cancelled
  └── completed
```

每个任务统一记录：

- `task_id`
- `session_id`
- `status`
- `current_step`
- `checkpoint_id`
- `cancel_requested_at`
- `failure_code`
- `started_at`
- `completed_at`

所有前端进度、通知、历史恢复、自动化触发都从这个状态机派生，不再各自维护一份状态。

### P0-04：权限系统强大，但对普通用户过于复杂

旧版已经有 API Token、CORS 白名单、工具审批、沙箱和路径校验，这是优点。但用户侧同时接触到 `prompt`、`auto`、`deny`、`accept-edits`、`full` 等概念时，理解成本很高。

最佳产品化方案是把内部权限映射成三档：

| 用户模式 | 允许能力 |
|---|---|
| 仅查看 | 读取、搜索、分析，不修改文件、不执行命令 |
| 执行前询问 | 写文件、执行命令、安装技能前询问 |
| 自动执行 | 在指定工作区内自动执行，删除和越权操作仍需确认 |

设置页应明确说明：

- Agent 能访问哪个目录；
- 哪些操作会修改文件；
- 哪些操作会联网；
- API Key 是否只保存在本机；
- 远程访问是否开启。

### P1-01：首页和导航功能过载

当前路由数量和能力很多，适合高级用户，不适合大众用户。

推荐的默认信息架构：

```text
核心区
├── 新建任务
├── 我的任务
├── 历史记录
└── 文件与产物

高级区
├── 超级协作
├── 自动化
├── 技能
├── 模型
├── MCP
├── 频道
└── 系统日志
```

首次打开时只展示核心区。用户完成第一次任务后，再通过“高级功能”进入其他模块。

### P1-02：过程展示应从“模型内部过程”转向“任务进展”

旧版已经有 thinking、tool call、tool output、timeline、plan 等丰富过程信息，但信息太密集时，用户很难抓住重点。

推荐默认展示：

```text
正在分析任务
正在读取 3 个文件
正在生成报告
正在运行验证
```

详细 reasoning、工具参数、原始输出放进展开面板。

这样可以同时满足：

- 普通用户想知道“做到哪了”；
- 高级用户想检查 Agent 做了什么；
- 移动端不被大量日志淹没。

### P1-03：工具注册应统一，并按任务动态注入

历史审计已经指出，执行器数量、工具 schema 和系统提示词之间存在维护不一致风险。

最佳修复方案：建立一个工具注册中心，每个工具只定义一次：

```ts
registerTool({
  name,
  description,
  schema,
  category,
  permission,
  timeout,
  supportsStreaming,
  deferred,
  execute,
})
```

然后按任务类型加载：

- 写代码：文件、Shell、测试、Git；
- 资料研究：搜索、抓取、摘要、引用；
- 生成网页：文件、预览、浏览器；
- 多媒体：图片、音频、视频；
- 自动化：计划、调度、通知。

默认工具集控制在 8～12 个，特殊工具通过 `tool_search` 或任务分类动态启用。

### P1-04：ChatView 和 DetailPanel 需要拆分

当前 ChatView 已经包含大量状态、事件解析、上传、渲染、流式处理、工具卡片、分享、历史和移动端逻辑。

建议拆分为：

```text
ChatView
├── ChatHeader
├── MessageTimeline
├── MessageRenderer
├── AgentStatusBar
├── Composer
├── AttachmentTray
├── ChatSearchOverlay
└── ChatSessionActions
```

DetailPanel 可拆成：

```text
DetailPanel
├── DeliverablesTab
├── FilesTab
├── ChangesTab
├── PreviewTab
├── TimelineTab
└── BrowserTab
```

收益：

- 单个模块更容易测试；
- 工具事件不会直接耦合 UI；
- 移动端布局可以独立演进；
- 后续增加新工具渲染器不再继续扩大 ChatView。

### P1-05：交付结果需要统一成“任务交付页”

DetailPanel 是当前项目最有潜力的产品设计之一，已经具备产物、文件、变更、预览、时间线和浏览器能力。

建议任务完成时统一生成：

1. 任务摘要；
2. 已完成步骤；
3. 修改/新增文件；
4. 验证结果；
5. 失败或未完成项目；
6. 下载、预览、回滚、继续修改按钮。

用户最终看到的应该是“任务交付结果”，而不是一大段模型文本和几十张工具卡片。

---

## 5. 推荐产品定位

建议将对外定位收敛为：

> SUPERCRZY BOT 是一个可以帮用户完成复杂任务、操作工作区并交付文件结果的 AI 工作台。

核心价值顺序应是：

1. 完成任务；
2. 交付结果；
3. 可控和安全；
4. 可恢复和可追踪；
5. 高级扩展能力。

不要把“多 Agent、技能、MCP、浏览器、频道、记忆”作为第一层卖点。它们是实现核心价值的能力，不是用户的第一购买理由。

---

## 6. 分阶段实施路线

### 阶段一：恢复可交付基线

1. 修复 `DetailPanel.vue` 类型错误；
2. 解决 Vite/Vitest/TypeScript 输出目录权限问题；
3. 新增 `pnpm verify`；
4. 固定 Node、pnpm、浏览器和系统要求；
5. 将当前工作区整理成一个可回滚基线提交；
6. 验证 5173 开发、3000 生产、Electron 打包三种模式。

完成标准：新环境可以安装、启动、构建、测试，且首个聊天任务能完成。

### 阶段二：统一任务体验

1. 建立任务状态机；
2. 统一停止、取消、暂停、恢复；
3. 统一检查点和错误码；
4. 统一权限模式；
5. 改造进度胶囊和任务摘要；
6. 确保流断开后可以明确恢复或重试。

完成标准：一个执行 5～10 分钟、包含文件修改和验证的任务，可以被观察、暂停、恢复、取消和交付。

### 阶段三：产品入口收敛

1. 首页只突出新建任务；
2. 导航分核心区和高级区；
3. 增加首次使用引导；
4. 提供任务模板；
5. 默认折叠 reasoning 和原始工具输出；
6. 完善移动端任务流。

完成标准：新用户不看文档也能完成第一个任务，并知道文件改了什么、结果在哪里。

### 阶段四：能力优化

1. 动态工具集；
2. 工具 schema 和执行器统一注册；
3. 工具结果摘要；
4. 任务级 token、耗时、失败率和成本统计；
5. Playbook 与记忆按工作区隔离；
6. 多 Agent 协作只在复杂任务中出现。

完成标准：复杂任务成功率提高，同时普通任务的响应速度和界面复杂度不恶化。

---

## 7. 每阶段必须追踪的指标

| 指标 | 建议目标 |
|---|---:|
| 首次启动到发出第一个任务 | ≤ 2 分钟 |
| 首个任务完成率 | ≥ 80% |
| 任务中途需要人工解释的比例 | ≤ 25% |
| 工具调用失败后可恢复比例 | ≥ 90% |
| 流断开后重复执行副作用工具次数 | 0 |
| 用户找到最终产物的时间 | ≤ 10 秒 |
| 普通任务默认注入工具数 | ≤ 12 个 |
| `pnpm verify` 通过率 | 100% |
| 未处理的客户端 TypeScript 错误 | 0 |

---

## 8. 最终建议

当前最优策略不是继续扩大功能面，而是完成一次“从 Agent 平台到大众产品”的收敛：

```text
稳定启动
  ↓
清晰输入
  ↓
可理解计划
  ↓
明确授权
  ↓
可观察执行
  ↓
可恢复失败
  ↓
清晰交付
```

如果这条主链路做扎实，现有的浏览器、协作、技能、记忆、MCP、多平台网关都会成为真正的竞争力；如果主链路没有稳定，即使继续增加能力，用户仍然会把产品理解成“功能很多但不容易用的 Agent 实验室”。
