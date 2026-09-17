/**
 * task_update — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'task_update',
    description: 'Update task status, progress, or subject. Status: pending/in_progress/completed.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status' },
        progress: { type: 'number', description: 'Progress 0-100' },
        subject: { type: 'string', description: 'New subject' },
      },
      required: ['id'],
    },
  async execute(args) {
    const db = getDB()
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as any
    if (!task) return `Task not found: ${args.id}`

    const updates: string[] = []
    if (args.status) { db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.status, args.id); updates.push(`status → ${args.status}`) }
    if (args.progress !== undefined) { db.prepare('UPDATE tasks SET progress = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.progress, args.id); updates.push(`progress → ${args.progress}%`) }
    if (args.subject) { db.prepare('UPDATE tasks SET subject = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.subject, args.id); updates.push(`subject updated`) }

    return updates.length > 0 ? `Task updated: ${updates.join(', ')}` : 'No changes made. Use status/pending, status/in_progress, status/completed, progress/0-100.'
  },
}

export default tool
