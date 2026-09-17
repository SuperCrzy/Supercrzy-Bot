/**
 * terminal_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'terminal_list',
    description: '列出当前所有终端会话（id/运行状态/shell/cwd）。',
    category: 'terminal',
    parameters: { type: 'object', properties: {} },
  async execute() {
    const list = terminalList()
    if (list.length === 0) return '当前没有终端会话。用 terminal_open 打开一个。'
    return '终端会话：\n' + list.map((s) => `- ${s.id} [${s.running ? '运行中' : '已退出'}] shell=${s.shell} cwd=${s.cwd}`).join('\n')
  },
}

export default tool
