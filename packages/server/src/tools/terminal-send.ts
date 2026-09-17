/**
 * terminal_send — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'terminal_send',
    description: '向终端会话发送命令（追加换行执行）。适合长任务后台运行（如启动 dev server）、交互式程序。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id（terminal_open 返回）' },
        command: { type: 'string', description: '要执行的命令' },
      },
      required: ['id', 'command'],
    },
  async execute(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalSend(String(args.id), String(args.command ?? ''))
    return res.ok ? `✅ 已发送到 ${args.id}（用 terminal_read 读取输出）` : `❌ ${res.error}`
  },
}

export default tool
