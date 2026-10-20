/**
 * 工具注册表 — 自动收集 tools/ 目录下所有 ToolDef
 * 加工具 = 在 tools/ 目录加一个文件并 export 默认 ToolDef，无需改主文件。
 *
 * 2026-09-18（P1-03 收尾）：原 services/tools.ts 里双写的 18 个工具已全部迁入本目录，
 * tools.ts 只保留类型、执行入口与调度（屏障/授权/常驻契约），不再持有工具定义。
 */
import type { ToolDef } from './types'
// ---- 原有注册表工具 ----
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
import memoryConsolidate from './memory-consolidate'
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
// ---- 2026-09-18 从 services/tools.ts 迁入（P1-03 残余清零）----
import toolSearch from './tool-search'
import memoryStore from './memory-store'
import fileRead from './file-read'
import lintFile from './lint-file'
import fileWrite from './file-write'
import multiEdit from './multi-edit'
import fileExists from './file-exists'
import fileDelete from './file-delete'
import terminalOpen from './terminal-open'
import shellExec from './shell-exec'
import drawDiagram from './draw-diagram'
import videoEdit from './video-edit'
import generateImage from './generate-image'
import webFetch from './web-fetch'
import gitStatus from './git-status'
import gitDiff from './git-diff'
import gitCommit from './git-commit'
import askUser from './ask-user'
// ---- 手机端专用（2026-10-20）：Android 侧「眼睛 + 手」 ----
import androidScreen from './android-screen'
import androidAction from './android-action'

/**
 * 全部工具定义（供 toolDefinitions 合并）。
 *
 * 顺序 = 模型看到的工具顺序，**不要随意调整**：这里刻意保持"迁移前 services/tools.ts
 * 里 toolDefinitions 数组的原始顺序"（18 个原内联工具在前，24 个原注册表工具在后），
 * 使 P1-03 迁移对最终 schema 的影响只剩"补上 dangerous 字段"，顺序与文案零漂移。
 */
export const directoryTools: ToolDef[] = [
  // ---- 原 services/tools.ts 内联的 18 个（保持原序）----
  toolSearch,
  memoryStore,
  fileRead,
  lintFile,
  fileWrite,
  multiEdit,
  drawDiagram,
  fileExists,
  fileDelete,
  terminalOpen,
  shellExec,
  videoEdit,
  generateImage,
  webFetch,
  gitStatus,
  gitDiff,
  gitCommit,
  askUser,
  // ---- 原注册表工具（保持原序）----
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
  // 2026-09-18（#147）：补上 app.ts 里早有中文名、却一直没有实现的 `合并记忆`
  memoryConsolidate,
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
  // ---- 手机端专用：Android 原生截屏/界面操作（桌面端调用会明确报不可用）----
  androidScreen,
  androidAction,
]

/** 执行器映射：name → execute（供 toolExecutors 合并） */
export const directoryExecutors: Record<string, ToolDef['execute']> = Object.fromEntries(
  directoryTools.map((t) => [t.name, t.execute]),
)
