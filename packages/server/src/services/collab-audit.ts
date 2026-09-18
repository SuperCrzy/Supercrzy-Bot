/**
 * 全自动众议院 · 项目会诊（异步任务版，2026-09-01）
 * 用 runAgentLoop 工具型成员（read/grep/cat/ls 真实检索）审项目找 bug——
 * 纯 LLM 灌代码找 bug 实测 0 问题（低效），工具型才真能发现。
 * 异步：POST 立即返回 taskId，后台并行跑成员，前端轮询进度/结果。
 */
import { randomUUID } from 'crypto'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getDB } from './database'
import { runToolAuditMember } from './tool-audit'

export interface AuditMember {
  provider: string
  brand: string
  text: string          // 该成员审计结论（来自 runAgentLoop SSE 捕获）
  toolCalls: number
  error?: string
}
export interface AuditResult {
  project: string
  filesScanned: number
  members: AuditMember[]
  summary: string       // 汇总要点
  generatedAt: number
}

export interface AuditTask {
  id: string
  project: string
  instruction: string
  status: 'running' | 'done' | 'failed'
  progress: string
  memberCount: number
  doneCount: number
  result?: AuditResult
  error?: string
  createdAt: string
}

function row(t: any): AuditTask {
  return {
    id: t.id, project: t.project, instruction: t.instruction, status: t.status,
    progress: t.progress, memberCount: t.member_count, doneCount: t.done_count,
    result: t.result ? JSON.parse(t.result) : undefined, error: t.error,
    createdAt: t.created_at,
  }
}

export function getAuditTask(id: string): AuditTask | null {
  const r = getDB().prepare('SELECT * FROM collab_audit WHERE id = ?').get(id) as any
  return r ? row(r) : null
}

export function listAuditTasks(): AuditTask[] {
  const rows = getDB().prepare('SELECT * FROM collab_audit ORDER BY created_at DESC LIMIT 50').all() as any[]
  return rows.map(row)
}

export function createAuditTask(projectPath: string, instruction?: string): AuditTask {
  const id = `ca_${Date.now()}_${randomUUID().slice(0, 6)}`
  getDB().prepare('INSERT INTO collab_audit (id, project, instruction, status, progress, member_count, done_count) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, projectPath, instruction || '找出这个项目的 BUG、安全隐患、逻辑错误', 'running', '准备扫描', 0, 0,
  )
  const task: AuditTask = {
    id, project: projectPath, instruction: instruction || '',
    status: 'running', progress: '准备扫描', memberCount: 0, doneCount: 0, createdAt: new Date().toISOString(),
  }
  void runAsync(task)
  return task
}

/** 扫描项目文件计数（供 progress 展示） */
function countFiles(root: string): number {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.workbuddy'])
  let n = 0
  const walk = (d: string) => {
    let e: string[] = []
    try { e = readdirSync(d) } catch { return }
    for (const name of e) {
      if (SKIP.has(name)) continue
      const p = join(d, name)
      let s: any
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else n++
    }
  }
  walk(root)
  return n
}

async function runAsync(t: AuditTask) {
  try {
    const db = getDB()
    const files = countFiles(t.project)
    const instruct = t.instruction || '找出这个项目的 BUG、安全隐患、逻辑错误'
    db.prepare(`UPDATE collab_audit SET progress=?, member_count=? WHERE id=?`).run(`工具型审计中（扫描 ${files} 个文件）`, 1, t.id)

    // 工具型成员并行：DeepSeek 已验证能带工具审计(不400)；Kimi 的 runAgentLoop 适配(baseUrl/temp/thinking)
    // 待后续；第一版先用 DeepSeek 单成员跑通"真能出问题"验证。
    const ds = await runToolAuditMember({ provider: 'deepseek', model: 'deepseek-v4-flash', target: t.project, instruction: instruct, maxTurns: 16 })

    const members: AuditMember[] = [
      { provider: 'deepseek', brand: 'DeepSeek', text: ds.text, toolCalls: ds.toolCalls.length, error: ds.error },
    ]
    const result: AuditResult = {
      project: t.project, filesScanned: files, members,
      summary: buildSummary(members),
      generatedAt: Date.now(),
    }
    db.prepare(`UPDATE collab_audit SET status='done', result=?, done_count=?, progress=? WHERE id=?`).run(
      JSON.stringify(result), members.filter((m) => m.text).length,
      `会诊完成：${members.filter((m) => m.text).length}/1 位完成审计`, t.id,
    )
  } catch (e: any) {
    const db = getDB()
    db.prepare(`UPDATE collab_audit SET status='failed', error=? WHERE id=?`).run(e?.message || String(e), t.id)
  }
}

/** 汇总各成员审计结论 → 一句话 + 各成员要点 */
function buildSummary(members: AuditMember[]): string {
  const done = members.filter((m) => m.text)
  if (done.length === 0) return '各成员均未返回有效审计结论'
  const lines = done.map((m) => `【${m.brand}】\n${m.text.slice(0, 1200)}`)
  return lines.join('\n\n')
}
