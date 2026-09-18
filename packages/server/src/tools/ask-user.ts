/**
 * ask_user — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { randomUUID } from 'crypto'

const tool: ToolDef = {
  name: 'ask_user',
  description: '当你遇到歧义或需要用户决策时使用。提出问题并列出选项，等待用户选择后继续执行。仅在确实需要用户输入时才调用。',
  category: 'interaction',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '向用户提出的问题' },
      header: { type: 'string', description: '问题简短标题（最多12字）' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '选项显示文字' },
            description: { type: 'string', description: '选项说明' },
          },
          required: ['label', 'description'],
        },
        description: '选项列表（2-4个）',
      },
      multiSelect: { type: 'boolean', description: '是否允许多选', default: false },
    },
    required: ['question', 'options'],
  },
  async execute(args, ctx) {
    // 对齐 ask_question：走提问交互链路（前端 QuestionFloating 弹窗），挂起等待答复。
    // 2026-08-27 修复：原 return `__ASK_USER__` 标记从未被 agent 拦截 → 前端无 UI，是被遗忘的死工具。
    if (!ctx?.askQuestion || !ctx?.emitQuestion) {
      return '⛔ 当前环境不支持提问交互，请基于现有信息合理假设后继续。'
    }
    const id = `q_${randomUUID()}`
    const question = String(args.question || args.prompt || '').trim()
    if (!question) return '❌ ask_user 需要提供 question 参数'
    // 2026-08-27 修复：options schema 是对象数组 {label, description}，不能 String(对象)（= [object Object]）
    // → 提取 label/文本字段为字符串
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
    // 挂起等待答复（与 ask_question 同一条超时逻辑）
    const answer = await ctx.askQuestion(id, question, options)
    if (answer === '__timeout__') return '⏰ 用户未在时限内答复，请基于现有信息合理假设后继续。'
    return `用户答复: ${answer}`
  },
}

export default tool
