/**
 * 工具注册表 — 自动收集 tools/ 目录下所有 ToolDef
 * 加工具 = 在 tools/ 目录加一个文件并 export 默认 ToolDef，无需改主文件。
 */
import type { ToolDef } from './types'
import getGoalTool from './get-goal'

/** 全部工具定义（供 toolDefinitions 合并） */
export const directoryTools: ToolDef[] = [getGoalTool]

/** 执行器映射：name → execute（供 toolExecutors 合并） */
export const directoryExecutors: Record<string, ToolDef['execute']> = Object.fromEntries(
  directoryTools.map((t) => [t.name, t.execute]),
)
