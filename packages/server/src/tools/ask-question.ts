/**
 * ask_question — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'ask_question',
    description: '向用户提出结构化问题（带选项或开放输入），挂起等待答复。当任务需要关键决策、缺少必要信息或需要用户确认时使用。',
    category: 'interaction',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题（清晰具体）' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表（2-4 个，可为空表示自由输入）' },
      },
      required: ['question'],
    },
  async execute(args, ctx) {
    if (!ctx?.askQuestion || !ctx?.emitQuestion) {
      return '⛔ 当前环境不支持提问交互，请基于现有信息合理假设后继续。'
    }
    const id = `q_${randomUUID()}`
    const question = String(args.question || '').trim()
    if (!question) return '❌ ask_question 需要提供 question 参数'
    // 2026-08-27 修复：options 可能是对象数组（{label/description}/{text} 等），String(对象)=[object Object]
    // → 归一化为字符串数组（与 ask_user 一致）
    const options: string[] = Array.isArray(args.options)
      ? args.options.map((o: any) => {
          if (typeof o === 'string') return o
          if (o == null) return ''
          if (typeof o === 'object') return String(o.label ?? o.text ?? o.value ?? '')
          return String(o)
        }).filter(Boolean)
      : []
    // 推送前端展示
    ctx.emitQuestion({ id, question, options })
    // 挂起等待答复
    const answer = await ctx.askQuestion(id, question, options)
    if (answer === '__timeout__') return '⏰ 用户未在时限内答复，请基于现有信息合理假设后继续。'
    return `用户答复: ${answer}`
  },
}

export default tool
