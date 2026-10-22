/**
 * terminal_read — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 *
 * 2026-10-22（老板实测）：命令刚发出去就 read，缓冲区还是空的 ⇒ 返回"暂无新输出"
 * ⇒ 模型立刻用**完全相同的参数**再读一次，连读 4 次触发 loop-guard 干预、整轮被打断。
 * 根因不是模型笨，是这个工具**不等待**：真正读 pty 的语义应该是"等到有输出或超时"。
 * 所以加 waitMs（默认 3s，上限 15s），让一次调用就把等待做掉。
 */
import type { ToolDef } from './types'
import { terminalRead } from '../services/terminal-manager'

const DEFAULT_WAIT_MS = 3000
const MAX_WAIT_MS = 15000
const POLL_MS = 100

const tool: ToolDef = {
    name: 'terminal_read',
    description: '增量读取终端会话输出（从上次读取位置；返回 nextOffset 供下次续读）。默认会等待最多 3 秒直到有新输出，所以命令发出后**直接读一次即可**，不要连续重试相同参数。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
        offset: { type: 'number', description: '可选：起始读取位置（默认上次消费位置）' },
        waitMs: { type: 'number', description: `可选：最多等待多久等新输出（毫秒，默认 ${DEFAULT_WAIT_MS}，上限 ${MAX_WAIT_MS}）。传 0 = 立即返回当前已到达的输出` },
      },
      required: ['id'],
    },
  async execute(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const id = String(args.id)
    const raw = Number(args.waitMs ?? DEFAULT_WAIT_MS)
    const waitMs = Math.min(Math.max(Number.isFinite(raw) ? raw : DEFAULT_WAIT_MS, 0), MAX_WAIT_MS)
    const deadline = Date.now() + waitMs
    let res = terminalRead(id, args.offset ? Number(args.offset) : undefined)
    // 空读就等：一次调用把等待做掉，避免模型用同样参数反复空读（会撞 loop-guard）
    while (res.ok && !res.output && !res.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      res = terminalRead(id)
    }
    if (!res.ok) return `❌ ${res.error}`
    if (!res.output) {
      const waited = waitMs > 0 ? `，已等待 ${Math.min(waitMs, Date.now() - (deadline - waitMs))}ms` : ''
      return `（${id} 暂无新输出${waited}${res.exited ? '，会话已退出' : ''}）`
    }
    return `${res.output}\n[输出结束 nextOffset=${res.nextOffset}${res.exited ? ' 会话已退出' : ''}]`
  },
}

export default tool
