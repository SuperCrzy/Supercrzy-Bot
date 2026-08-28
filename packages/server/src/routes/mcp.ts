/**
 * MCP 连接器 API：用户自定义 MCP server 管理（对标 WorkBuddy 连接器）
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'
import {
  listMcpServers,
  disconnectMcpServer,
  initMcpServers,
  listTools,
  getAllMcpTools,
  type McpServerConfig,
} from '../services/mcp-manager.js'

export const mcpRouter = new Router({ prefix: '/api/mcp' })

/** 列表 */
mcpRouter.get('/servers', (ctx: Context) => {
  ctx.body = listMcpServers()
})

/** 新增 */
mcpRouter.post('/servers', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as Partial<McpServerConfig> & { command?: string; args?: string[] | string; env?: Record<string, string> | string }
  const name = (body.name || '').trim()
  if (!name) {
    ctx.status = 400
    ctx.body = { error: '名称必填' }
    return
  }
  const type = body.type === 'sse' ? 'sse' : 'stdio'
  if (type === 'stdio' && !(body.command || '').trim()) {
    ctx.status = 400
    ctx.body = { error: 'stdio 类型需要命令（如 npx）' }
    return
  }
  if (type === 'sse' && !(body.url || '').trim()) {
    ctx.status = 400
    ctx.body = { error: 'sse/http 类型需要 URL' }
    return
  }
  const db = getDB()
  const id = randomUUID()
  const args = typeof body.args === 'string' ? body.args : JSON.stringify(body.args || [])
  const env = typeof body.env === 'string' ? body.env : JSON.stringify(body.env || {})
  db.prepare(
    'INSERT INTO mcp_servers (id, name, type, command, args, env, url, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name, type, (body.command || '').trim(), args, env, (body.url || '').trim(), body.enabled === 0 ? 0 : 1)
  ctx.status = 201
  ctx.body = { success: true, id }
})

/** 更新 */
mcpRouter.put('/servers/:id', (ctx: Context) => {
  const db = getDB()
  const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(ctx.params.id) as any
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Not found' }
    return
  }
  const body = (ctx.request.body || {}) as Record<string, any>
  const fields: string[] = []
  const values: any[] = []
  for (const key of ['name', 'type', 'command', 'url']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`)
      values.push(typeof body[key] === 'string' ? body[key].trim() : body[key])
    }
  }
  if (body.args !== undefined) {
    fields.push('args = ?')
    values.push(typeof body.args === 'string' ? body.args : JSON.stringify(body.args))
  }
  if (body.env !== undefined) {
    fields.push('env = ?')
    values.push(typeof body.env === 'string' ? body.env : JSON.stringify(body.env))
  }
  if (body.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(body.enabled ? 1 : 0)
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')")
    values.push(ctx.params.id)
    db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  // 配置变化 → 重连
  disconnectMcpServer(ctx.params.id)
  const cfg = listMcpServers().find((s) => s.id === ctx.params.id)
  if (cfg && cfg.enabled === 1) {
    try {
      // 异步重连（不阻塞响应）
      void import('../services/mcp-manager.js').then((m) => m.initMcpServers())
    } catch { /* ignore */ }
  }
  ctx.body = { success: true }
})

/** 删除 */
mcpRouter.delete('/servers/:id', (ctx: Context) => {
  const db = getDB()
  disconnectMcpServer(ctx.params.id)
  const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Not found' }
    return
  }
  ctx.body = { success: true }
})

/** 测试连接：列出工具数 */
mcpRouter.post('/test', async (ctx: Context) => {
  const { id } = ctx.request.body as { id?: string }
  if (!id) {
    ctx.status = 400
    ctx.body = { error: 'id 必填' }
    return
  }
  try {
    await initMcpServers()
    const tools = await listTools(id)
    ctx.body = { success: true, toolCount: tools.length, tools: tools.map((t) => t.name) }
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { success: false, error: err.message }
  }
})

/** 全部已连接工具的汇总（供 Agent 使用，也用于调试展示） */
mcpRouter.get('/tools', async (ctx: Context) => {
  try {
    const all = await getAllMcpTools()
    ctx.body = all.map(({ serverId, serverName, tool }) => ({
      serverId,
      serverName,
      name: tool.name,
      fullName: `mcp_${serverId.slice(0, 8)}_${tool.name}`,
      description: tool.description || '',
    }))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// ===== MCP 预设市场（官方精选 + 官方 registry 搜索）=====

/** 内置精选预设（官方参考服务器，离线可用） */
const MCP_PRESETS = [
  {
    id: 'playwright',
    name: 'Playwright',
    desc: '浏览器自动化：打开网页、点击、截图、提取内容',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    url: '',
    official: true,
  },
  {
    id: 'time',
    name: '时间工具',
    desc: '当前时间 / 时区查询',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-timeserver@latest'],
    url: '',
    official: true,
  },
  {
    id: 'filesystem',
    name: '文件系统',
    desc: '本地文件读写（添加时选择允许访问的目录）',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@latest', '<目录>'],
    url: '',
    official: true,
    needsDir: true,
  },
  {
    id: 'git',
    name: 'Git',
    desc: '仓库状态 / 提交 / 分支操作',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-git@latest'],
    url: '',
    official: true,
  },
]

mcpRouter.get('/presets', (ctx: Context) => {
  ctx.body = MCP_PRESETS
})

// 官方 registry 搜索（服务端 search 参数直接过滤，无需本地拉全量；1h 结果缓存）
const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io'
const searchCache = new Map<string, { ts: number; data: any }>()

/** 官方 registry 搜索（registry 服务端 ?search= 过滤 + 1h 缓存） */
mcpRouter.get('/search', async (ctx: Context) => {
  const q = String((ctx.query.q as string) || '').trim().toLowerCase()
  if (!q) {
    ctx.body = { total: 0, items: [] }
    return
  }
  const cached = searchCache.get(q)
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    ctx.body = cached.data
    return
  }
  try {
    const res = await fetch(
      `${REGISTRY_BASE}/v0/servers?search=${encodeURIComponent(q)}&per_page=30`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) },
    )
    if (!res.ok) {
      ctx.status = 502
      ctx.body = { error: `registry ${res.status}` }
      return
    }
    const data: any = await res.json()
    const items = (data?.servers || []).map((s: any) => ({
      name: s.server?.name || s.server?.title || '',
      title: s.server?.title || s.server?.name || '',
      desc: (s.server?.description || '').slice(0, 160),
      version: s.server?.version || '',
      official: !!(s._meta?.['io.modelcontextprotocol.registry/official']?.status),
      remotes: (s.server?.remotes || []).map((r: any) => r.url).filter(Boolean),
      packages: (s.server?.packages || []).map((p: any) => p.name || p.package || '').filter(Boolean),
    }))
    const body = { total: items.length, items }
    searchCache.set(q, { ts: Date.now(), data: body })
    ctx.body = body
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err.message || 'registry 不可达' }
  }
})

