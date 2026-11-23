/**
 * Diagnostic bundle — the evidence a report needs.
 *
 * Today a bug report is a screenshot and a description, which is why an audit can
 * conclude "there is no MCP UI" and nobody can check it without reopening the app.
 * This gathers, in one request: what version is running, what the environment
 * looks like, which capabilities are actually wired, and log metadata —
 * enough for someone else to reproduce without asking a follow-up question.
 *
 * Free-form settings and log contents are excluded: they can contain credentials,
 * conversations, paths, and other private data that regex redaction cannot guarantee.
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
export function summarizeLogs(logDir = LOG_DIR): { available: boolean; latestSizeBytes?: number } {
  try {
    if (!existsSync(logDir)) return { available: false }
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith('.log') || f.endsWith('.md'))
      .map((f) => statSync(join(logDir, f)))
      .filter((s) => s.isFile())
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return files.length ? { available: true, latestSizeBytes: files[0].size } : { available: false }
  } catch {
    return { available: false }
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

export function summarizeSettings(rows: Array<{ key: unknown; value: unknown }>): Record<string, string | number | boolean> {
  const numeric = new Set(['temperature', 'maxTokens', 'maxTurns', 'gatewayTimeout', 'memoryCharLimit', 'toolAutoApproveSeconds', 'ttsRate', 'completionSoundVolume'])
  const flags = new Set(['streamingEnabled', 'compactMode', 'showReasoning', 'showCost', 'busyInputMode', 'memoryEnabled', 'memoryAutoConsolidate', 'piiMaskingEnabled', 'streamRead'])
  const presence = new Set(['apiKey', 'tavilyApiKey', 'serperApiKey', 'jinaApiKey', 'embeddingApiKey', 'imageApiKey', 'accessToken', 'systemPrompt', 'model'])
  const safe: Record<string, string | number | boolean> = {}
  for (const row of rows) {
    const key = String(row.key)
    const value = typeof row.value === 'string' ? row.value.trim() : String(row.value ?? '').trim()
    if (numeric.has(key) && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) safe[key] = Number(value)
    else if (flags.has(key) && /^(true|false|1|0)$/i.test(value)) safe[key] = /^(true|1)$/i.test(value)
    else if (presence.has(key)) safe[`${key}Configured`] = value.length > 0
  }
  return safe
}

function settingsSnapshot(): Record<string, string | number | boolean> {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT key, value FROM settings').all() as any[]
    return summarizeSettings(rows)
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
    workspace: { configured: Boolean(config.workspaceDir) },
    capabilities: {
      // What the prompt actually tells the model, so a "it said it could not" report
      // can be checked against what was really available.
      tables: tableCounts(),
      settings: settingsSnapshot(),
    },
    log: summarizeLogs(),
  }
})
