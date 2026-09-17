/**
 * memory_recall — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'memory_recall',
    description: '搜索已存储的记忆。在需要回忆用户信息时使用。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数量，默认5' },
      },
      required: ['query'],
    },
  async execute(args) {
    const db = getDB()
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。'
    // 混合检索：配置了 embedding key 时 FTS5 + 语义余弦融合（α=0.8），否则退化纯 FTS5 ranking
    const rows = await memoryRankedSearchHybrid(String(args.query || ''), args.limit || 5)
    if (rows.length === 0) return '未找到相关记忆。'
    return rows.map((r) => `[${r.key}] (${r.category}, importance:${r.importance}, score:${r.score.toFixed(2)}) ${r.content}`).join('\n')
  },
}

export default tool
