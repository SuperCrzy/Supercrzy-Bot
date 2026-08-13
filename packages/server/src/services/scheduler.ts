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
