/**
 * memory_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'memory_list',
    description: '列出所有已存储的记忆。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {},
    },
  async execute(_args) {
    const db = getDB()
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。'
    const rows = db.prepare(
      'SELECT key, content, category, importance FROM agent_memory ORDER BY importance DESC LIMIT 20'
    ).all() as any[]
    if (rows.length === 0) return 'No memories stored.'
    return rows.map((r: any) => `[${r.key}] (${r.category}, importance:${r.importance}) ${r.content}`).join('\n')
  },
}

export default tool
