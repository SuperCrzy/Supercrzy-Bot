/**
 * Checkpoint API — Agent 执行时间线数据源
 * 读取 data/checkpoints/*.json(由 agent.ts saveCheckpoint 写入)
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'
import { readSnapshotIndex, readSnapshotText, diffLines, restoreSnapshotFile } from '../services/checkpoint-snapshot'

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

/**
 * Per-file diff for a checkpoint.
 *
 * A checkpoint used to be a conversation snapshot only: the UI could list the files
 * a turn touched but not show what changed inside them, and there was no way to undo
 * a single file. Both need the before/after captured at write time, which is what
 * the snapshot index holds.
 */
checkpointsRouter.get('/:id/diff', async (ctx: Context) => {
  const id = ctx.params.id as string
  if (!UUID_RE.test(id)) { ctx.status = 400; ctx.body = { error: 'Invalid checkpoint id' }; return }

  const index = readSnapshotIndex(CKPT_DIR, id)
  const files = index.entries.map((entry) => {
    if (entry.metadataOnly) {
      return { path: entry.path, metadataOnly: true, existed: entry.existed, sizeBefore: entry.sizeBefore, sizeAfter: entry.sizeAfter, hunks: [] }
    }
    const before = entry.beforeHash ? readSnapshotText(CKPT_DIR, id, entry.beforeHash, 'before') : ''
    const after = entry.afterHash ? readSnapshotText(CKPT_DIR, id, entry.afterHash, 'after') : ''
    const lines = diffLines(before ?? '', after ?? '')
    return {
      path: entry.path,
      metadataOnly: false,
      existed: entry.existed,
      sizeBefore: entry.sizeBefore,
      sizeAfter: entry.sizeAfter,
      added: lines.filter((l) => l.type === 'add').length,
      deleted: lines.filter((l) => l.type === 'del').length,
      lines: lines.slice(0, 2000),
      truncated: lines.length > 2000,
    }
  })
  ctx.body = { checkpointId: id, files }
})

/**
 * Restore files from a checkpoint.
 *
 * Body: { paths?: string[], all?: boolean } — explicit paths for a single-file
 * rollback, or all to restore the whole set. Returns per-file outcomes rather than
 * a blanket success, because a partial restore (binary skipped, snapshot missing)
 * is a normal result the caller has to report.
 */
checkpointsRouter.post('/:id/restore', async (ctx: Context) => {
  const id = ctx.params.id as string
  if (!UUID_RE.test(id)) { ctx.status = 400; ctx.body = { error: 'Invalid checkpoint id' }; return }

  const body = (ctx.request.body || {}) as { paths?: string[]; all?: boolean }
  const index = readSnapshotIndex(CKPT_DIR, id)
  if (index.entries.length === 0) {
    ctx.status = 404
    ctx.body = { error: '该检查点没有文件快照（可能是升级前创建的）' }
    return
  }

  const wanted = body.all
    ? index.entries
    : index.entries.filter((e) => (body.paths || []).includes(e.path))
  if (wanted.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'paths 为空或与快照不匹配' }
    return
  }

  const results = wanted.map((entry) => ({ path: entry.path, ...restoreSnapshotFile(CKPT_DIR, id, entry) }))
  ctx.body = {
    checkpointId: id,
    restored: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
})

export default checkpointsRouter

