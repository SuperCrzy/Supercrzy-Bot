/**
 * 工具注册表 — 自动收集 tools/ 目录下所有 ToolDef
 * 加工具 = 在 tools/ 目录加一个文件并 export 默认 ToolDef，无需改主文件。
 */
import type { ToolDef } from './types'
import getGoalTool from './get-goal'
import newsSearchTool from './news-search'
import terminalClose from './terminal-close'
import terminalList from './terminal-list'
import terminalRead from './terminal-read'
import terminalSend from './terminal-send'
import terminalSignal from './terminal-signal'
import taskCreate from './task-create'
import taskUpdate from './task-update'
import taskList from './task-list'
import memoryRecall from './memory-recall'
import memoryList from './memory-list'
import skillList from './skill-list'
import skillSearch from './skill-search'
import skillView from './skill-view'
import skillInstall from './skill-install'
import askQuestion from './ask-question'
import createPlan from './create-plan'
import computerUse from './computer-use'
import makeArticle from './make-article'
import deepResearch from './deep-research'
import browser from './browser'
import webSearch from './web-search'
import readMe from './read-me'

/** 全部工具定义（供 toolDefinitions 合并） */
export const directoryTools: ToolDef[] = [
  getGoalTool,
  newsSearchTool,
  terminalClose,
  terminalList,
  terminalRead,
  terminalSend,
  terminalSignal,
  taskCreate,
  taskUpdate,
  taskList,
  memoryRecall,
  memoryList,
  skillList,
  skillSearch,
  skillView,
  skillInstall,
  askQuestion,
  createPlan,
  computerUse,
  makeArticle,
  deepResearch,
  browser,
  webSearch,
  readMe,
]

/** 执行器映射：name → execute（供 toolExecutors 合并） */
export const directoryExecutors: Record<string, ToolDef['execute']> = Object.fromEntries(
  directoryTools.map((t) => [t.name, t.execute]),
)
