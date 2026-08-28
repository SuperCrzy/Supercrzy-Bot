/**
 * ToolDef — 工具标准接口（工具架构轻量包化第一步）
 * 目标：加工具 = 在 tools/ 目录加一个文件（定义 + 执行器一体），注册表自动收集。
 * 与 tools.ts 兼容：定义项并入 toolDefinitions，执行器并入 toolExecutors。
 */

export interface ToolContext {
  /** 当前会话 id（agent 注入） */
  sessionId?: string
  /** 工作目录 */
  cwd?: string
  /** 权限级别 */
  permissionLevel?: 'workspace-only' | 'sandbox' | 'full'
  /** 向用户提问（ask_question 用） */
  askQuestion?: (id: string, question: string, options?: string[]) => Promise<string>
  emitQuestion?: (q: { id: string; question: string; options?: string[] }) => void
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
