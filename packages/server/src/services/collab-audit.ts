/**
 * 全自动众议院 · 项目会诊（异步任务版，2026-09-01）
 * 用 runAgentLoop 工具型成员（read/grep/cat/ls 真实检索）审项目找 bug——
 * 纯 LLM 灌代码找 bug 实测 0 问题（低效），工具型才真能发现。
 * 异步：POST 立即返回 taskId，后台并行跑成员，前端轮询进度/结果。
 */
import { randomUUID } from 'crypto'
import { readdir } from 'fs/promises'
import type { Dirent } from 'fs'
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

/**
 * 扫描项目文件计数（供 progress 展示）
 *
 * 2026-09-18 两点修正：
 * 1. **改异步**：原实现是 readdirSync + statSync 的**无上限**递归全量遍历，
 *    而"项目会诊"是 `void runAsync()` 后台跑的——扫大项目时会同步占住事件循环，
 *    把前台正在进行的对话 SSE 一起冻住。这正是"浏览器活跃 + 并发时流不动"的一个真实来源。
 * 2. **加上限**：这个数字只用于进度文案，没必要为它遍历整个仓库，
 *    超过 MAX_COUNT 就停止（文案里标注"+"）。
 */
const COUNT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.workbuddy', 'uploads', 'data'])
const COUNT_MAX = 20000

async function countFiles(root: string): Promise<{ n: number; capped: boolean }> {
  let n = 0
  let capped = false
  const walk = async (d: string): Promise<void> => {
    if (capped) return
    let e: Dirent[] = []
    try { e = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const ent of e) {
      if (capped) return
      if (COUNT_SKIP_DIRS.has(ent.name)) continue
      if (ent.isDirectory()) { await walk(join(d, ent.name)); continue }
      n++
      if (n >= COUNT_MAX) { capped = true; return }
    }
  }
  await walk(root)
  return { n, capped }
}

async function runAsync(t: AuditTask) {
  try {
    const db = getDB()
    const { n: files, capped } = await countFiles(t.project)
    const instruct = t.instruction || '找出这个项目的 BUG、安全隐患、逻辑错误'
    db.prepare(`UPDATE collab_audit SET progress=?, member_count=? WHERE id=?`).run(`工具型审计中（扫描 ${files}${capped ? '+' : ''} 个文件）`, 1, t.id)

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
