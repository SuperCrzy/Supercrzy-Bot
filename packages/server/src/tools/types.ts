/**
 * ToolDef — 工具标准接口（工具架构轻量包化第一步）
 * 目标：加工具 = 在 tools/ 目录加一个文件（定义 + 执行器一体），注册表自动收集。
 * 与 tools.ts 兼容：定义项并入 toolDefinitions，执行器并入 toolExecutors。
 */

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
  /** 危险工具（需授权确认） */
  dangerous?: boolean
  /** 参数 JSON Schema */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** 执行器：args + ctx → 返回文本结果（或结构化对象） */
  execute: (args: any, ctx?: ToolContext) => Promise<string | any> | string | any
}
