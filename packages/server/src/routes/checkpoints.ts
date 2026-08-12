/**
 * Checkpoint API — Agent 执行时间线数据源
 * 读取 data/checkpoints/*.json(由 agent.ts saveCheckpoint 写入)
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'

export const checkpointsRouter = new Router({ prefix: '/api/checkpoints' })

const CKPT_DIR = join(config.workspaceDir || process.cwd(), 'data', 'checkpoints')

/** 只允许 UUID 格式，防止路径穿越（导出供单测） */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidCheckpointId(id: string): boolean {
  return UUID_RE.test(id)
}

interface CheckpointMeta {
  id: string
  turn: number
  timestamp: string
  fileCount: number
  toolCallCount: number
  /** 任务标题：第一条用户消息前 50 字 */
  firstUserMsg: string
}

// 列表（元信息，按时间倒序）
checkpointsRouter.get('/', async (ctx: Context) => {
  try {
    const files = await readdir(CKPT_DIR)
    const metas: CheckpointMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readFile(join(CKPT_DIR, f), 'utf-8')
        const d = JSON.parse(raw)
        const msgs = Array.isArray(d.messages) ? d.messages : []
        const firstUser = msgs.find((m: any) => m.role === 'user')
        let firstUserMsg = ''
        if (firstUser) {
          const c = firstUser.content
          firstUserMsg = (typeof c === 'string' ? c : JSON.stringify(c)).replace(/\\n/g, ' ').slice(0, 50)
        }
        metas.push({
          id: d.id || f.replace('.json', ''),
          turn: d.turn || 0,
          timestamp: d.timestamp || '',
          fileCount: (d.createdFiles || []).length,
          toolCallCount: (d.totalToolCalls || []).length,
          firstUserMsg,
        })
      } catch { /* skip corrupt file */ }
    }
    metas.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    ctx.body = metas
  } catch {
    ctx.body = []
  }
})

// 详情（完整执行历史）
checkpointsRouter.get('/:id', async (ctx: Context) => {
  const id = ctx.params.id as string
  if (!UUID_RE.test(id)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid checkpoint id' }
    return
  }
  try {
    const raw = await readFile(join(CKPT_DIR, `${id}.json`), 'utf-8')
    ctx.body = JSON.parse(raw)
  } catch {
    ctx.status = 404
    ctx.body = { error: 'Checkpoint not found' }
  }
})

// 删除
checkpointsRouter.delete('/:id', async (ctx: Context) => {
  const id = ctx.params.id as string
  if (!UUID_RE.test(id)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid checkpoint id' }
    return
  }
  try {
    await rm(join(CKPT_DIR, `${id}.json`))
    ctx.body = { success: true }
  } catch {
    ctx.status = 404
    ctx.body = { error: 'Checkpoint not found' }
  }
})

export default checkpointsRouter
