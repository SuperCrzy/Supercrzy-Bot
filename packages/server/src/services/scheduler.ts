/**
 * Scheduler Service — 定时自动化任务调度器
 * 每分钟扫描一次，执行到期的自动化任务
 * 完成后通过 Notifier 推送结果到微信/QQ
 */
import { getDB } from './database'
import { calcNextRun } from '../routes/automations'
import { notify, type NotifyChannel } from './notifier'

let intervalId: ReturnType<typeof setInterval> | null = null
let running = false

interface Automations {
  id: string
  name: string
  prompt: string
  status: string
  schedule_type: 'recurring' | 'once'
  rrule: string
  scheduled_at: string | null
  next_run_at: number
  last_run_at: number | null
  model_id: string | null
  notify_channel: string
}

/**
 * Execute a single automation
 */
async function executeAutomation(auto: Automations): Promise<void> {
  const db = getDB()
  const now = Math.floor(Date.now() / 1000)

  console.log(`[Scheduler] Running automation: ${auto.name}`)

  let result = ''

  try {
    // Call the Agent API
    const response = await fetch(`http://localhost:${process.env.PORT || '3000'}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: auto.prompt }],
        model: auto.model_id || 'deepseek-v4-pro',
      }),
    })

    if (!response.ok) {
      throw new Error(`Agent API returned ${response.status}`)
    }

    // Read the SSE stream to get the result
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let contentCount = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('event: content')) {
          // Content event is on next line
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            if (data.content) {
              result = data.content
              contentCount++
            }
          } catch {}
        }
      }
    }

    console.log(`[Scheduler] Automation "${auto.name}" completed (${contentCount} chunks, ${result.length} chars)`)
  } catch (err: any) {
    console.error(`[Scheduler] Automation "${auto.name}" failed:`, err.message)
    result = `Error: ${err.message}`
  }

  // Update last run and next run
  const nextRunAt = auto.schedule_type === 'once'
    ? 0
    : Math.floor(calcNextRun(auto.rrule || '', Date.now()) / 1000)

  db.prepare(
    'UPDATE automations SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
  ).run(now, nextRunAt, now, auto.id)

  // Disable one-time automations after execution
  if (auto.schedule_type === 'once') {
    db.prepare("UPDATE automations SET status = 'completed' WHERE id = ?").run(auto.id)
  }

  // ── Notifier: 如果有 notify_channel，推送结果给用户 ──
  const channel = auto.notify_channel?.trim()
  if (channel) {
    const summary = result
      ? result.slice(0, 300).replace(/\n+/g, ' ').trim() + (result.length > 300 ? '...' : '')
      : '(no result)'

    const title = `[Agent] ${auto.name}`
    const body = result
      ? `Completed.\n\nSummary: ${summary}`
      : 'Execution failed or returned no content.'

    console.log(`[Scheduler] Notifying via ${channel}: ${title}`)
    const notifyResult = await notify(channel as NotifyChannel, title, body)
    console.log(`[Scheduler] Notify result: ${JSON.stringify(notifyResult)}`)
  }
}

/**
 * Check and execute due automations
 */
async function tick(): Promise<void> {
  if (running) return
  running = true

  try {
    const db = getDB()
    const now = Math.floor(Date.now() / 1000)

    const due = db.prepare(
      "SELECT * FROM automations WHERE status = 'active' AND next_run_at > 0 AND next_run_at <= ?"
    ).all(now) as Automations[]

    if (due.length > 0) {
      console.log(`[Scheduler] Found ${due.length} due automation(s)`)
      for (const auto of due) {
        await executeAutomation(auto)
      }
    }

    // P2 Skill Generation：180 天未用自动停用（每 6 小时检查一次，避免高频写库）
    try {
      const nowMs = Date.now()
      const sweepRow = db.prepare("SELECT value FROM settings WHERE key = 'skillSweepLast'").get() as any
      const lastSweep = Number(sweepRow?.value || 0)
      if (nowMs - lastSweep > 6 * 60 * 60 * 1000) {
        const cutoff = new Date(nowMs - 180 * 24 * 60 * 60 * 1000).toISOString()
        const stale = db.prepare(
          "SELECT name FROM skills WHERE enabled = 1 AND is_builtin = 0 AND last_used IS NOT NULL AND last_used < ?"
        ).all(cutoff) as Array<{ name: string }>
        for (const s of stale) {
          db.prepare("UPDATE skills SET enabled = 0, updated_at = datetime('now') WHERE name = ?").run(s.name)
          console.log(`[Scheduler] 技能 180 天未使用已停用: ${s.name}`)
        }
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('skillSweepLast', ?)").run(String(nowMs))
      }
    } catch (e: any) {
      console.log(`[Scheduler] 技能停用检查失败: ${e?.message || e}`)
    }
  } catch (err: any) {
    console.error('[Scheduler] Tick error:', err.message)
  } finally {
    running = false
  }
}

/**
 * Start the scheduler
 */
export function startScheduler(): void {
  if (intervalId) return

  // Initial tick
  tick()

  // Check every 60 seconds
  intervalId = setInterval(tick, 60000)

  // 事件触发自动化：监听工作区文件变化（防抖 3s，学 Grok 文件事件触发）
  startFileEventWatcher()
  console.log('[Scheduler] Started (check interval: 60s)')
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    console.log('[Scheduler] Stopped')
  }
}

/**
 * 事件触发自动化（学 Grok runAutomationForEvent）
 * 匹配 event_trigger 的自动化直接执行；不更新 next_run_at（区别于定时）
 * @param event 事件名：file-changed / message-received / manual
 * @param context 附加上下文（如变更文件路径），拼进 prompt
 */
export async function fireAutomationForEvent(event: string, context?: string): Promise<number> {
  const db = getDB()
  const rows = db.prepare(
    "SELECT * FROM automations WHERE status = 'active' AND event_trigger = ?"
  ).all(event) as Automations[]

  if (rows.length === 0) {
    console.log(`[Scheduler] No automation for event "${event}"`)
    return 0
  }

  let fired = 0
  for (const auto of rows) {
    // 事件上下文附加到 prompt（若未包含占位符则追加）
    let prompt = auto.prompt
    if (context && !prompt.includes('{{context}}')) {
      prompt = `${prompt}\n\n[事件上下文] ${context}`
    } else if (context) {
      prompt = prompt.replace('{{context}}', context)
    }

    const withContext = { ...auto, prompt }
    try {
      await executeAutomation(withContext as Automations)
      fired++
      db.prepare('UPDATE automations SET last_run_at = ?, updated_at = ? WHERE id = ?')
        .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), auto.id)
    } catch (err: any) {
      console.error(`[Scheduler] Event automation "${auto.name}" failed:`, err.message)
    }
  }
  console.log(`[Scheduler] Event "${event}" fired ${fired} automation(s)`)
  return fired
}

// ---- 事件触发自动化：文件变化监听 ----
let fileWatcher: ReturnType<typeof setInterval> | null = null
let pendingFileEvents = new Set<string>()
let fileEventTimer: ReturnType<typeof setTimeout> | null = null

/** 启动文件事件监听：扫描 workspace 目录（每 10s 快照对比，避免 fs.watch 的平台差异/目录级限制） */
function startFileEventWatcher(): void {
  if (fileWatcher) return
  let lastSnapshot = new Map<string, number>()

  const scan = () => {
    try {
      const { readdirSync } = require('fs') as typeof import('fs')
      const { config } = require('../config') as typeof import('../config')
      const root = config.workspaceDir || process.cwd()
      // 只扫顶层，避免大目录性能问题
      const files = readdirSync(root, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))

      const current = new Map<string, number>()
      for (const f of files) {
        const key = f.name + (f.isDir ? '/' : '')
        current.set(key, 1)
        if (!lastSnapshot.has(key)) {
          // 新文件
          pendingFileEvents.add(f.name)
        }
      }
      for (const key of lastSnapshot.keys()) {
        if (!current.has(key)) pendingFileEvents.add(key) // 删除
      }
      lastSnapshot = current

      // 防抖触发
      if (pendingFileEvents.size > 0 && !fileEventTimer) {
        fileEventTimer = setTimeout(() => {
          if (pendingFileEvents.size > 0) {
            const ctx = [...pendingFileEvents].slice(0, 10).join(', ')
            void fireAutomationForEvent('file-changed', `工作区文件发生变化: ${ctx}`)
            pendingFileEvents.clear()
          }
          fileEventTimer = null
        }, 3000)
      }
    } catch { /* 目录不可读则跳过 */ }
  }

  scan()
  fileWatcher = setInterval(scan, 10000)
  console.log('[Scheduler] File event watcher started (10s scan interval)')
}

/** 停止文件事件监听 */
export function stopFileEventWatcher(): void {
  if (fileWatcher) { clearInterval(fileWatcher); fileWatcher = null }
}
