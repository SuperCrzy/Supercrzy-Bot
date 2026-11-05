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
import deviceControl from './device-control'
import mobileBrowser from './mobile-browser'
import { deviceBridgeReady } from '../services/device-bridge'

/**
 * Desktop-only tools, gated by host capability instead of being registered and
 * failing at call time. Android is the case that matters: computer-use drives a
 * GUI through nut.js, which does not exist there (the phone's own screen control
 * is the accessibility service, a different mechanism).
 */
/**
 * Tools that only make sense on the phone (they ride the device bridge).
 *
 * 🔴 Names must be the tool's real `name` field (snake_case). This set once held
 * camelCase identifiers — `deviceControl`, `mobileBrowser` — which matched nothing,
 * so the gate silently did nothing at all. `registry-gate.test.ts` now fails if any
 * name in either set is absent from the tool array, so a rename cannot quietly
 * disconnect a gate again.
 */
const MOBILE_ONLY_TOOLS = new Set(['device_control', 'mobile_browser'])

/**
 * Are we running on the phone?
 *
 * 🔴 `process.platform === 'android'` alone is wrong and was a silent, total failure:
 * the phone runs a stock aarch64 Node inside proot, so it reports `'linux'`. Gating on
 * `'android'` therefore never fired — the mobile-only tools were skipped as
 * "desktop" and the desktop-only ones stayed registered, which is the exact opposite
 * of the intent. Both gates were dead code on the only device they were written for.
 *
 * The truthful signal is the device bridge: only the app creates that directory.
 * (`'android'` is kept for a future nodejs-mobile style build.)
 */
function isMobileRuntime(): boolean {
  return process.platform === 'android' || deviceBridgeReady()
}

const DESKTOP_ONLY_TOOLS = new Set([
  // nut.js GUI automation — macOS/Windows only.
  'computer_use',
  // Drive a *second* Android device over adb. On the phone itself this is the L2
  // virtual-display feature's job, with its own transport — not this tool pair.
  'android_screen',
  'android_action',
  // Drives a desktop Chromium through playwright-core; pruned from the mobile payload.
  'browser',
])
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
import bgTask from './bg-task'

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
  // ---- 后台任务控制（启动走 shell_exec 的 run_in_background，本工具只管 list/output/cancel）----
  bgTask,
  deviceControl,
  mobileBrowser,
].filter((tool) => {
  if (isMobileRuntime() && DESKTOP_ONLY_TOOLS.has(tool.name)) {
    console.warn(`[registry] tool "${tool.name}" unavailable on mobile, skipped`)
    return false
  }
  if (!isMobileRuntime() && MOBILE_ONLY_TOOLS.has(tool.name)) {
    console.warn(`[registry] tool "${tool.name}" is mobile-only, skipped`)
    return false
  }
  return true
})

/** 执行器映射：name → execute（供 toolExecutors 合并） */
export const directoryExecutors: Record<string, ToolDef['execute']> = Object.fromEntries(
  directoryTools.map((t) => [t.name, t.execute]),
)
