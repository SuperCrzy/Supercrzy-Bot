/**
 * Workspace 文件服务 — HTTP 版
 * 供 DetailPanel 文件 Tab / 工作台使用
 * 安全：所有路径必须位于 workspace 根目录内（白名单），防目录穿越
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { config } from '../config'

export const workspaceRouter = new Router({ prefix: '/api/workspace' })

const WORKSPACE_ROOT = resolve(config.workspaceDir || process.cwd())

/** 校验并规范化路径：必须在 workspace 根内，否则返回 null */
function safePath(input: string): string | null {
  if (!input || input.includes('\0')) return null
  const abs = resolve(WORKSPACE_ROOT, input)
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + '/')) return null
  return abs
}

// 文件列表
workspaceRouter.get('/files', async (ctx: Context) => {
  const dirInput = (ctx.query.dir as string) || ''
  const dirPath = safePath(dirInput || '.')
  if (!dirPath) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path: must be inside workspace' }
    return
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter(e => !e.name.startsWith('.') || e.name === '.gitignore')
        .map(async (e) => {
          const fullPath = join(dirPath, e.name)
          let size = 0
          let mtime = ''
          try {
            const s = await stat(fullPath)
            size = s.size
            mtime = s.mtime.toISOString()
          } catch {}
          return {
            name: e.name,
            path: fullPath,
            type: e.isDirectory() ? 'directory' : 'file',
            size,
            mtime,
          }
        })
    )
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { files, path: dirPath, root: WORKSPACE_ROOT }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 读取文件内容（限制 100KB）
workspaceRouter.get('/files/content', async (ctx: Context) => {
  const fileInput = (ctx.query.path as string) || ''
  const filePath = safePath(fileInput)
  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path: must be inside workspace' }
    return
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    ctx.body = { content: content.slice(0, 100000), path: filePath }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 供调试：显示当前 workspace 根
export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export default workspaceRouter
