/**
 * deep_research — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
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
    name: 'deep_research',
    description: '深度研究：多轮递归搜索+AI 提炼，生成 3 页以上的详细研究报告（含 Sources 来源列表）。适用于需要全面深入调研的问题（公司分析/产品对比/技术解读/新闻事件背景）。参数 query 为研究主题，breadth 每轮搜索数量(2-6，默认4)，depth 递归深度(1-3，默认2)。耗时 1-3 分钟，请等待完成。',
    category: 'network',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '研究主题（清晰具体，如"对比 OpenAI GPT-5 与 Google Gemini 3 的推理能力"）' },
        breadth: { type: 'number', description: '每轮搜索数量，2-6，默认 4' },
        depth: { type: 'number', description: '递归下钻深度，1-3，默认 2' },
      },
      required: ['query'],
    },
  async execute(args, ctx) {
    const query = String(args.query || '').trim()
    if (!query) return '❌ 缺少参数 query（研究主题）'
    const breadth = Math.min(Math.max(parseInt(args.breadth) || 4, 2), 6)
    const depth = Math.min(Math.max(parseInt(args.depth) || 2, 1), 3)
    try {
      const { runDeepResearch } = await import('../services/deep-research')
      const progress = (p: any) => {
        const line = `[深度研究] 深度 ${p.currentDepth}/${p.totalDepth} · 查询 ${p.completedQueries}/${p.totalQueries || '?'} · 当前：${p.currentQuery || '…'}\n`
        ctx?.onOutput?.('', line)
      }
      const result = await runDeepResearch({ query, breadth, depth, onProgress: progress })
      return JSON.stringify({
        engine: 'deep-research',
        learnings: result.learnings,
        visitedUrls: result.visitedUrls,
        report: result.report,
        summary: `深度研究完成：${result.learnings.length} 条学习点、${result.visitedUrls.length} 个来源、报告 ${result.report.length} 字符`,
      })
    } catch (err: any) {
      return `❌ 深度研究失败：${err.message}`
    }
  },
}

export default tool
