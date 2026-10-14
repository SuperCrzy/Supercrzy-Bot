/**
 * ToolDef — 工具标准接口（工具架构轻量包化第一步）
 * 目标：加工具 = 在 tools/ 目录加一个文件（定义 + 执行器一体），注册表自动收集。
 * 与 tools.ts 兼容：定义项并入 toolDefinitions，执行器并入 toolExecutors。
 */

/**
 * 工具执行进度（**结构化**，G5 / I13，2026-09-24）。
 *
 * 存在的理由：此前前端拿"写入了多少行"靠**正则解析工具输出的中文文案**
 * （`/写入\s*(\d+)\s*\/\s*(\d+)\s*行/`，在 `ToolCallBlock.vue` 与 `MessageFlowRenderer.vue`
 * **各写一份**）—— 后端改一个字（措辞、i18n），进度就**静默失效且不报错**。
 * 结构化回调把这条路彻底切断：前端只认数字，不认文案。
 *
 * 所有字段都是「本次工具调用内的累计值」，不是增量 —— 前端直接显示即可，不必自己累加。
 */
export interface ToolProgress {
  /** 累计新增行数 */
  added?: number
  /** 累计删除行数 */
  deleted?: number
  /** 总行数（分块写入时用于 x/total 展示） */
  total?: number
  /** 已处理处数（如 multi_edit 的"第 3 处"） */
  done?: number
  /** 待处理总处数 */
  count?: number
  /**
   * 阶段**机器标识**（不是给人看的文案！）。
   *
   * 唯一合法取值：`'create'`（新建文件）| `'edit'`（修改已有文件）。
   * 前端据此本地化「创建 / 编辑」——对齐主流实现 `tool.writeFile.{creating,create,editing,edit}`
   * 的"动词随新旧文件动态推导"（取证见 `docs/主流实现_TOOLCARD_MCP_SANDBOX_2026-09-24.md` §1.6）。
   *
   * ⚠️ **禁止塞中文/英文展示文案**：数据流里出现"给人看的字"是本项目已付过代价的老路
   *    （前端正则解析后端中文，后端改一个字即静默失效）。
   */
  phase?: 'create' | 'edit'
}

export interface ToolContext {
  /** 会话工作目录（绝对路径）；为空则用 WORKSPACE_ROOT */
  cwd?: string
  /** 会话 id（agent 注入） */
  sessionId?: string
  /** 权限级别 */
  permissionLevel?: 'workspace-only' | 'sandbox' | 'full'
  /** 产物上报回调：命令产生/修改的文件（由 agent 持久化到 artifacts 表） */
  onArtifacts?: (files: Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }>) => void
  /** 工具流式输出回调：命令执行分片实时推送 */
  onOutput?: (toolCallId: string, chunk: string) => void
  /**
   * 工具执行进度回调（结构化，见 `ToolProgress`）。
   *
   * 约定：工具内调用时**传 `''` 作 toolCallId**（与 `onOutput` 完全同构）——
   * 真实 id 由 `services/tools.ts` 的 `boundCtx` 注入，工具不需要知道自己的 toolCallId。
   * 例：`ctx?.onProgress?.('', { added: 12, deleted: 2 })`
   */
  onProgress?: (toolCallId: string, progress: ToolProgress) => void
  /** 实时预览回调：写入 .html 时触发（前端右侧边栏实时渲染） */
  onPreview?: (path: string, content: string) => void
  /** 画图回调：生成 SVG 图表时触发 */
  onDiagram?: (title: string, svg: string) => void
  /** 画图流式块回调：SVG 按标签边界切块实时推送 */
  onDiagramChunk?: (chunk: string) => void
  /** 生图回调：生成图片后推送 */
  onImage?: (data: string, isUrl: boolean, title: string) => void
  /** 文件变更回调：写入文件时触发（前端变更 tab 显示改前/改后 diff） */
  onFileChange?: (path: string, oldContent: string, newContent: string) => void
  /** 向用户提问（挂起等待答复，由 agent 注入） */
  askQuestion?: (id: string, question: string, options?: string[]) => Promise<string>
  /** 提问结果发送回调：把提问/选项推给前端展示 */
  emitQuestion?: (data: { id: string; question: string; options?: string[] }) => void
  [key: string]: unknown
}

export interface ToolDef {
  /** 工具名（唯一，如 get_goal） */
  name: string
  /** 工具描述（进模型 schema） */
  description: string
  /** 分类（memory/file/network/system/interaction/git/terminal） */
  category: 'memory' | 'file' | 'network' | 'system' | 'interaction' | 'git' | 'terminal'
  /**
   * 破坏性工具：执行前必须经用户确认（I2，2026-09-24）。
   *
   * **这是审批需求的唯一来源**。`agent.ts` 里的敏感工具集合由本字段派生
   * （见 `services/tools.ts` 的 `SENSITIVE_TOOLS`），并被
   * `scripts/validate-tools.ts` 的契约断言兜住，**不允许**再各写一份名单。
   *
   * 历史教训（就是这次要修的）：这里原本有两个互不相干的声明 ——
   * 本文件里的 `dangerous?: boolean`（6 个工具标了，但**全仓 0 引用**，纯装饰）
   * 和 `agent.ts` 里内联硬编码的 `SENSITIVE_TOOLS = new Set([...4 项])`。
   * 后果是**单向漏洞**：`computer_use` / `skill_install` / `multi_edit` 声明了危险、
   * 却因为不在那个 Set 里而**根本不走审批**（模型可静默改文件、装代码、操作本机）；
   * 反过来 `file_delete` 走了审批却没声明。
   * ⇒ 单一来源 + 契约断言，是为了让"声明了"和"真的拦了"不可能再脱钩。
   */
  requiresApproval?: boolean
  /** 参数 JSON Schema */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** 执行器：args + ctx → 返回文本结果（或结构化对象） */
  execute: (args: any, ctx?: ToolContext) => Promise<string | any> | string | any
}
