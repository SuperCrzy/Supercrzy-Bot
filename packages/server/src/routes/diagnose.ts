/**
 * Diagnostic bundle — the evidence a report needs.
 *
 * Today a bug report is a screenshot and a description, which is why an audit can
 * conclude "there is no MCP UI" and nobody can check it without reopening the app.
 * This gathers, in one request: what version is running, what the environment
 * looks like, which capabilities are actually wired, and the tail of the log —
 * enough for someone else to reproduce without asking a follow-up question.
 *
 * Deliberately no file paths from the user's machine beyond the app data dir, and
 * no message contents: a diagnostic package gets pasted into issues and chats.
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform, release, arch, totalmem, freemem } from 'node:os'
import { getDB } from '../services/database'
import { config } from '../config'

export const diagnoseRouter = new Router({ prefix: '/api/diagnose' })

const LOG_DIR = join(homedir(), '.supercrzy', 'logs')
const MAX_LOG_CHARS = 120_000

function tailOfNewestLog(): { file: string; content: string; truncated: boolean } | null {
  try {
    if (!existsSync(LOG_DIR)) return null
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log') || f.endsWith('.md'))
      .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    if (files.length === 0) return null
    const raw = readFileSync(join(LOG_DIR, files[0].f), 'utf8')
    const truncated = raw.length > MAX_LOG_CHARS
    return { file: files[0].f, content: truncated ? raw.slice(-MAX_LOG_CHARS) : raw, truncated }
  } catch {
    return null
  }
}

/** Counts, not contents: enough to tell "configured but empty" from "working". */
function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const db = getDB()
    for (const t of ['sessions', 'messages', 'artifacts', 'skills', 'roles', 'mcp_servers', 'automations', 'routines', 'channels', 'checkpoints_meta']) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any
        out[t] = Number(row?.c || 0)
      } catch {
        out[t] = -1   // table absent on this version
      }
    }
  } catch { /* database not ready */ }
  return out
}

function settingsSnapshot(): Record<string, string | boolean> {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT key, value FROM settings').all() as any[]
    const safe: Record<string, string | boolean> = {}
    for (const r of rows) {
      const k = String(r.key)
      // Secrets never leave the machine; only their presence is reported.
      // maxTokens/tokenLimit are counts, not credentials: only mask real secrets.
      if (/api_?key|apikey|secret|password|_token$|token$/i.test(k) && !/maxtokens|tokenlimit|tokens/i.test(k)) safe[k] = r.value ? '(set)' : '(empty)'
      else safe[k] = String(r.value ?? '')
    }
    return safe
  } catch {
    return {}
  }
}

diagnoseRouter.get('/bundle', async (ctx: Context) => {
  const pkg = (() => {
    try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) } catch { return {} }
  })() as any

  ctx.body = {
    generatedAt: new Date().toISOString(),
    app: {
      version: pkg.version || 'unknown',
      name: pkg.name || 'unknown',
      node: process.version,
      packaged: process.env.SUPERCRZY_PACKAGED === '1',
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
    },
    os: { platform: platform(), release: release(), arch: arch(), totalMemMB: Math.round(totalmem() / 1048576), freeMemMB: Math.round(freemem() / 1048576) },
    workspace: { configured: Boolean(config.workspaceDir), dataDir: join(homedir(), '.supercrzy') },
    capabilities: {
      // What the prompt actually tells the model, so a "it said it could not" report
      // can be checked against what was really available.
      tables: tableCounts(),
      settings: settingsSnapshot(),
    },
    log: tailOfNewestLog(),
  }
})
