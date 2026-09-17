/**
 * skill_view — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'skill_view',
    description: '查看指定技能的完整详情，包括 prompt template 和可用工具。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（模糊匹配）' },
        id: { type: 'string', description: '技能 UUID' },
      },
    },
  async execute(args) {
    const db = getDB()
    const name = args.name || args.id || ''
    if (!name) return 'Usage: skill_view(name="skill-name") or skill_view(id="uuid")'

    const skill = name.length > 20
      ? db.prepare('SELECT * FROM skills WHERE id = ?').get(name) as any
      : db.prepare('SELECT * FROM skills WHERE name LIKE ?').get(`%${name}%`) as any

    if (!skill) return `Skill not found: ${name}. Use skill_list() to see available skills.`

    let tools = ''
    try { tools = JSON.parse(skill.tools || '[]').join(', ') || 'none' } catch { tools = skill.tools || 'none' }

    return [
      `=== ${skill.name} ===`,
      `Description: ${skill.description}`,
      `Category: ${skill.category}`,
      `Status: ${skill.enabled ? 'Active' : 'Disabled'}`,
      `Source: ${skill.is_builtin ? 'builtin' : 'installed'}`,
      `Keywords: ${skill.trigger_keywords || 'none'}`,
      `Tools: ${tools}`,
      skill.source_file ? `File: ${skill.source_file}` : '',
      skill.prompt_template ? `\n--- Prompt Template ---\n${skill.prompt_template}` : '',
    ].filter(Boolean).join('\n')
  },
}

export default tool
