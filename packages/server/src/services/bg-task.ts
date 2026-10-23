/**
 * Background task registry (P0).
 *
 * What it is: a long-running shell command that is **detached from the tool call that started
 * it**. `shell_exec` normally blocks until the child exits (default 30s timeout); with
 * `run_in_background: true` it returns a task id immediately, the agent keeps working, and the
 * command keeps running.
 *
 * Deliberately NOT in P0 (tracked in the backlog):
 *   - persistence: the registry is in-memory, so a server restart forgets the list (the processes
 *     are children of this server anyway and die with it — claiming otherwise would be a lie)
 *   - UI: no pill yet, this layer is reachable through the API / `bg_task` tool
 *   - resume: no automatic "continue the turn when it finishes" (only the `done` event exists)
 *
 * Concurrency and memory are capped per process: 16 live tasks, 100KB of output each (ring, keeps
 * the tail). Both caps exist because an unbounded registry is a leak, not a feature.
 */
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

export type BgTaskStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface BgTask {
  id: string
  sessionId: string
  /** Human-readable title (from the tool call's `description`), shown in lists */
  title: string
  command: string
  cwd: string
  status: BgTaskStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** Total bytes produced so far (may exceed the retained buffer) */
  bytes: number
  /** 最后一次收到输出的时刻 —— 判断"还在推进"还是"卡住"的唯一可靠信号 */
  lastOutputAt: number
  buffer: string
  /** Read cursor for incremental `readBgTaskOutput` */
  consumed: number
  proc: ChildProcess | null
}

export interface BgTaskView {
  id: string
  sessionId: string
  title: string
  command: string
  status: BgTaskStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  bytes: number
  /** 最后一次收到输出的时刻（判断"还在推进"还是"卡住"） */
  lastOutputAt: number
  /** Last ~600 chars of output, for one-line previews */
  tail: string
}

export const BG_MAX_LIVE_TASKS = 16
export const BG_MAX_BUFFER = 100 * 1024

const tasks = new Map<string, BgTask>()
const events = new EventEmitter()
events.setMaxListeners(0)

/** Fired after a task reaches a terminal status. P2 uses it to resume the agent turn. */
export function onBgTaskDone(cb: (task: BgTaskView) => void): () => void {
  events.on('done', cb)
  return () => events.off('done', cb)
}

function appendOutput(t: BgTask, chunk: string) {
  if (chunk) t.lastOutputAt = Date.now()
  t.bytes += Buffer.byteLength(chunk)
  t.buffer += chunk
  if (t.buffer.length > BG_MAX_BUFFER) {
    const drop = t.buffer.length - BG_MAX_BUFFER
    t.buffer = t.buffer.slice(drop)
    t.consumed = Math.max(0, t.consumed - drop)
  }
}

export function toView(t: BgTask): BgTaskView {
  return {
    id: t.id,
    sessionId: t.sessionId,
    title: t.title,
    command: t.command,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    exitCode: t.exitCode,
    bytes: t.bytes,
    lastOutputAt: t.lastOutputAt,
    tail: t.buffer.slice(-600),
  }
}

function liveCount(): number {
  let n = 0
  for (const t of tasks.values()) if (t.status === 'running') n += 1
  return n
}

/**
 * Start a background task. Returns the task id.
 *
 * Throws when the concurrency cap is hit — the caller (a tool) turns that into a readable
 * message; silently queuing would look like the command is running when it is not.
 */
export function startBgTask(opts: {
  sessionId: string
  title: string
  command: string
  cwd: string
}): string {
  if (liveCount() >= BG_MAX_LIVE_TASKS) {
    throw new Error(`后台任务已达上限（${BG_MAX_LIVE_TASKS} 个），请先取消不用的任务`)
  }
  const id = randomUUID().slice(0, 8)
  const win = process.platform === 'win32'
  const shell = win ? 'powershell.exe' : '/bin/bash'
  const args = win ? ['-NoProfile', '-Command', opts.command] : ['-lc', opts.command]

  const t: BgTask = {
    id,
    sessionId: opts.sessionId || '',
    title: String(opts.title || opts.command).slice(0, 120),
    command: opts.command,
    cwd: opts.cwd,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    bytes: 0,
    lastOutputAt: Date.now(),
    buffer: '',
    consumed: 0,
    proc: null,
  }
  tasks.set(id, t)

  try {
    const proc = spawn(shell, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.proc = proc
    proc.stdout?.on('data', (d: Buffer) => appendOutput(t, d.toString()))
    proc.stderr?.on('data', (d: Buffer) => appendOutput(t, d.toString()))
    proc.on('error', (err) => {
      appendOutput(t, `\n[spawn error] ${err.message}\n`)
      settle(t, null, 'failed')
    })
    proc.on('exit', (code) => {
      settle(t, code, code === 0 ? 'done' : 'failed')
    })
  } catch (e: any) {
    appendOutput(t, `\n[spawn error] ${e?.message || e}\n`)
    settle(t, null, 'failed')
  }

  return id
}

/** Move a task to a terminal status exactly once, then notify listeners. */
function settle(t: BgTask, code: number | null, status: BgTaskStatus) {
  if (t.status !== 'running') return
  t.status = status
  t.exitCode = code
  t.endedAt = Date.now()
  t.proc = null
  try {
    events.emit('done', toView(t))
  } catch { /* a listener must never break the exit path */ }
}

export function getBgTask(id: string): BgTask | undefined {
  return tasks.get(id)
}

/** Newest first. `sessionId` empty = every session (the "all tasks" view). */
export function listBgTasks(sessionId?: string): BgTaskView[] {
  const out: BgTaskView[] = []
  for (const t of tasks.values()) {
    if (sessionId && t.sessionId && t.sessionId !== sessionId) continue
    out.push(toView(t))
  }
  out.sort((a, b) => b.startedAt - a.startedAt)
  return out
}

/**
 * Incremental output read: returns everything written after `from` plus the new cursor.
 * `from` beyond the retained buffer is clamped — the caller sees `truncated: true` so it can say
 * "early output was dropped" instead of pretending the text starts at the beginning.
 */
export function readBgTaskOutput(
  id: string,
  from = 0,
): { ok: true; text: string; next: number; truncated: boolean } | { ok: false; error: string } {
  const t = tasks.get(id)
  if (!t) return { ok: false, error: `任务不存在: ${id}` }
  const start = Math.max(0, Math.min(Number.isFinite(from) ? from : 0, t.buffer.length))
  const truncated = start < (Number.isFinite(from) ? from : 0)
  return { ok: true, text: t.buffer.slice(start), next: t.buffer.length, truncated }
}

/** Cancel a running task. Kill is SIGTERM first; the exit handler records `cancelled`. */
export function cancelBgTask(id: string): { ok: boolean; error?: string } {
  const t = tasks.get(id)
  if (!t) return { ok: false, error: `任务不存在: ${id}` }
  if (t.status !== 'running') return { ok: false, error: `任务已结束（${t.status}），无需取消` }
  try {
    t.proc?.kill('SIGTERM')
  } catch { /* already gone */ }
  settle(t, null, 'cancelled')
  return { ok: true }
}

/** Drop finished tasks from the registry (the output buffers are the memory cost). */
export function clearFinishedBgTasks(): number {
  let n = 0
  for (const [id, t] of tasks) {
    if (t.status !== 'running') {
      tasks.delete(id)
      n += 1
    }
  }
  return n
}

/**
 * Remove a task from the registry (the UI's row "delete" action).
 *
 * A running task is killed first — deleting the record while its process keeps eating CPU would
 * leak a process nobody can see or stop any more.
 */
export function deleteBgTask(id: string): { ok: boolean; error?: string } {
  const t = tasks.get(id)
  if (!t) return { ok: false, error: `任务不存在: ${id}` }
  if (t.status === 'running') {
    try { t.proc?.kill('SIGTERM') } catch { /* already gone */ }
  }
  tasks.delete(id)
  return { ok: true }
}

/** Test hook: forget everything. Never call this in product code. */
export function __resetBgTasksForTest(): void {
  for (const t of tasks.values()) {
    try { t.proc?.kill('SIGKILL') } catch { /* ignore */ }
  }
  tasks.clear()
}
