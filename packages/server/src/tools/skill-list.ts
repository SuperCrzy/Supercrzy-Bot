/**
 * skill_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { randomUUID } from 'crypto'
import { join, basename } from 'path'
import { readFile, writeFile, access, appendFile, stat, readdir, rm, rmdir } from 'fs/promises'
import { exec, execFile, spawn } from 'child_process'
import { constants, readdirSync, statSync } from 'fs'
import { runSearchChain, runExhaustiveSearch } from '../services/search-providers'
import { memoryRankedSearch, memoryRankedSearchHybrid } from '../services/memory-search'
import { installSkillFromGitHub, initSkillsDirectory } from '../services/skill-loader'
import { terminalOpen, terminalList, terminalSend, terminalRead, terminalSignal, terminalClose } from '../services/terminal-manager'
import { scanDangerousPath, sandboxify, WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'

const tool: ToolDef = {
    // get_goal 已迁至 tools/ 目录（ToolDef 注册表，2026-08-25 工具架构轻量包化）——此处不再内联定义，避免工具名重复
    name: 'skill_list',
    description: '列出所有已安装的技能模块。查看 agent 当前具备哪些能力。',
    category: 'system',
    parameters: { type: 'object', properties: {} },
  async execute(_args) {
    const db = getDB()
    const rows = db.prepare(
      'SELECT name, description, category, enabled, is_builtin, trigger_keywords FROM skills ORDER BY sort_order ASC, created_at DESC'
    ).all() as any[]
    if (rows.length === 0) return 'No skills installed.'
    return rows.map((r: any) => {
      const status = r.enabled ? 'ON' : 'OFF'
      const source = r.is_builtin ? 'builtin' : 'installed'
      return `[${status}] ${r.name} (${r.category}, ${source}) - ${r.description}`
    }).join('\n')
  },
}

export default tool
