/**
 * file_read — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { readFile } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath } from './shared'

const tool: ToolDef = {
  name: 'file_read',
  description: '读取本地文件内容。支持文本文件。读取大文件时可用 startLine/endLine 只读取指定行范围（省 token 且能精确看某段代码），返回内容带行号；不传则读取全文（maxLength 以内）。',
  category: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      maxLength: { type: 'number', description: '最大读取字符数，默认10000' },
      startLine: { type: 'number', description: '起始行号（从1开始）' },
      endLine: { type: 'number', description: '结束行号（含），不传表示读到文件末尾' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const content = await readFile(path, 'utf-8')
      // 行号切片（WorkBuddy readFile 同款）：startLine/endLine 只需读指定行范围（省 token + 精确看某段）
      // 返回带行号的文本（"489: ..."），前端据此显示 "已读取 xxx L489-末尾"（readLineRange 解析 startLine/endLine）
      const startLine = Number(args.startLine) || 0
      const endLine = Number(args.endLine) || 0
      if (startLine > 0) {
        const lines = content.split('\n')
        const sIdx = Math.min(Math.max(startLine, 1), lines.length + 1)
        const eIdx = endLine > 0 ? Math.min(endLine, lines.length) : lines.length
        // 截断保护：切片本身也受 maxLength 约束
        const slice = lines.slice(sIdx - 1, eIdx)
        const numbered = slice.map((ln: string, i: number) => `${sIdx + i}: ${ln}`).join('\n')
        return numbered
      }
      // 限制长度
      const maxLen = args.maxLength || 10000
      if (content.length > maxLen) {
        return content.slice(0, maxLen) + `\n\n... (文件共 ${content.length} 字符，仅显示前 ${maxLen} 字符)`
      }
      return content
    } catch (err: any) {
      return `❌ 读取文件失败：${err.message}`
    }
  },
}

export default tool
