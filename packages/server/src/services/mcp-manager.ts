/**
 * MCP 连接器管理器 — 用户自定义 MCP server 接入 Agent 工具集
 *
 * 支持两种类型（对齐 MCP 标准）：
 * - stdio：本地命令（command + args + env），如 npx -y xxx-mcp
 * - sse/http：远程 URL（Streamable HTTP）
 *
 * 设计：与 computer-use.ts 同款 MCP SDK；连接惰性化；工具名加前缀 mcp_<server>_<tool>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn, type ChildProcess } from 'child_process'
import { getDB } from './database'

export interface McpServerConfig {
  id: string
  name: string
  type: 'stdio' | 'sse'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  enabled: number
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface McpConnection {
  client: Client
  proc?: ChildProcess
  transport?: any
}

const connections = new Map<string, McpConnection>()
let initPromise: Promise<void> | null = null

/** 读取全部 MCP server 配置 */
export function listMcpServers(): McpServerConfig[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as any[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: (r.type || 'stdio') as 'stdio' | 'sse',
    command: r.command || '',
    args: safeJson(r.args, []),
    env: safeJson(r.env, {}),
    url: r.url || '',
    enabled: r.enabled,
  }))
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

/** 初始化并连接所有启用的 MCP server（惰性：连接失败不影响其他） */
export async function initMcpServers(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const servers = listMcpServers().filter((s) => s.enabled === 1)
    for (const s of servers) {
      try {
        await connectServer(s)
      } catch (err: any) {
        console.log(`[McpManager] connect "${s.name}" failed: ${err.message}`)
      }
    }
  })()
  return initPromise
}

/** 连接单个 MCP server */
async function connectServer(cfg: McpServerConfig): Promise<void> {
  const existing = connections.get(cfg.id)
  if (existing) return
  let transport: any
  let proc: ChildProcess | undefined
  if (cfg.type === 'stdio') {
    if (!cfg.command) throw new Error('stdio 类型需要 command')
    const cmd = cfg.command
    const args = cfg.args || []
    proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...cfg.env, NODE_OPTIONS: '' },
    })
    proc.stderr?.on('data', (d) => {
      const msg = String(d).trim()
      if (msg && !msg.includes('ExperimentalWarning')) console.log(`[McpManager:${cfg.name}] ${msg}`)
    })
    proc.on('exit', () => {
      connections.delete(cfg.id)
    })
    transport = new StdioClientTransport({
      command: cmd,
      args,
      env: { ...process.env, ...cfg.env } as Record<string, string>,
    })
  } else {
    if (!cfg.url) throw new Error('sse/http 类型需要 url')
    transport = new StreamableHTTPClientTransport(new URL(cfg.url))
  }
  const client = new Client({ name: 'supercrzy-mcp', version: '1.0.0' })
  await client.connect(transport)
  connections.set(cfg.id, { client, proc, transport })
  const tools = await listTools(cfg.id)
  console.log(`[McpManager] "${cfg.name}" connected, ${tools.length} tools`)
}

/** 断开并移除连接（配置删除/停用时调用） */
export function disconnectMcpServer(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  try { conn.transport?.close() } catch { /* ignore */ }
  if (conn.proc) { try { conn.proc.kill('SIGTERM') } catch { /* ignore */ } }
  try { conn.client?.close() } catch { /* ignore */ }
  connections.delete(id)
}

/** 断开全部（应用退出） */
export function stopAllMcp(): void {
  for (const id of [...connections.keys()]) disconnectMcpServer(id)
}

/** 获取某 server 的工具列表 */
export async function listTools(serverId: string): Promise<McpToolInfo[]> {
  const conn = connections.get(serverId)
  if (!conn) return []
  try {
    const res = await conn.client.listTools()
    return (res.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }))
  } catch {
    return []
  }
}

/** 调用 MCP 工具（返回文本结果） */
export async function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const conn = connections.get(serverId)
  if (!conn) return `❌ MCP server 未连接（${serverId}）`
  try {
    const result = await conn.client.callTool({ name: toolName, arguments: args })
    const contents = (result?.content || []) as Array<{ type: string; text?: string }>
    return contents
      .map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c)))
      .join('\n')
  } catch (err: any) {
    return `❌ MCP 工具 ${toolName} 调用失败: ${err.message}`
  }
}

/** 汇总所有已连接 server 的工具（供 Agent 注入） */
export async function getAllMcpTools(): Promise<Array<{ serverId: string; serverName: string; tool: McpToolInfo }>> {
  await initMcpServers()
  const out: Array<{ serverId: string; serverName: string; tool: McpToolInfo }> = []
  for (const cfg of listMcpServers().filter((s) => s.enabled === 1)) {
    const tools = await listTools(cfg.id)
    for (const t of tools) out.push({ serverId: cfg.id, serverName: cfg.name, tool: t })
  }
  return out
}
