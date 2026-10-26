/**
 * Shared bridge from messaging channels to the local agent SSE endpoint.
 *
 * Why this module exists
 * ----------------------
 * Six channel bots (telegram / discord / slack / dingtalk / feishu / wecom) each carried a
 * private 40-line copy of `callAgent()`. Every copy had the same two defects:
 *
 *   1. **Wrong event shape.** They looked for `d.type === 'block' && d.block.type === 'text'`,
 *      but `/api/chat/agent` emits *named* SSE events (`event: content_chunk`, `event: done`)
 *      with a leading `id:` line. Nothing ever matched, so every channel replied "No response"
 *      even though the agent had run correctly.
 *
 *   2. **Broken chunk buffering.** The loop did
 *          `for (const line of buf.split('\n')) { ... }`
 *      and *then* `buf = buf.split('\n').pop()`. The trailing partial line was fed to the parser
 *      as if it were complete AND discarded, so any JSON split across two TCP chunks was either
 *      mangled or lost. The correct order — pop the tail first, iterate the complete lines — is
 *      already used in `services/chat.ts`; this module is the single copy of it now.
 *
 * Design notes
 * ------------
 * - Accumulates `content_chunk` deltas into one string. That event is the agent's actual
 *   assistant text, whereas the flow's text segments are narration; taking "the last text
 *   block" (the old behaviour) returned a narration/answer mixture.
 * - `error` events are surfaced rather than swallowed, so a channel can tell the user what
 *   went wrong instead of a generic "Sorry".
 * - Kept dependency-free and side-effect-free so it is trivially unit-testable with a fake
 *   `Response` whose body yields arbitrary chunk boundaries.
 */

export interface AgentReply {
  /** Accumulated assistant text. Empty when the run produced no content. */
  text: string
  /** Set when the agent reported an error or the HTTP call failed. */
  error: string | null
}

export interface CallAgentOptions {
  /** Text sent to the agent as a single user message. */
  userText: string
  /** Base URL of the local server; defaults to PORT env or 3000. */
  baseUrl?: string
  /** Abort after this many milliseconds. 0 disables the timeout. Default 180000. */
  timeoutMs?: number
  /** Extra JSON fields merged into the request body (e.g. sessionId). */
  extraBody?: Record<string, unknown>
}

/** A parsed SSE frame: event name + raw data payload (may span multiple `data:` lines). */
export interface SseFrame {
  event: string
  data: string
}

/**
 * Incremental SSE frame parser.
 *
 * Feed it decoded text as it arrives; it returns the frames that are *complete*. A frame ends
 * on a blank line (per the SSE spec). Incomplete trailing text is retained for the next call,
 * which is the whole point — never parse a partial line.
 */
export class SseFrameParser {
  private buffer = ''

  /** Returns frames completed by this push; keeps the remainder buffered. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []

    // Frames are separated by a blank line. Servers may use LF or CRLF, so accept both:
    // a CRLF frame terminator is "\r\n\r\n", which contains no plain "\n\n".
    let idx: number
    while ((idx = this.indexOfTerminator()) !== -1) {
      const end = this.terminatorLengthAt(idx)
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + end)
      const frame = this.parseFrame(raw)
      if (frame) frames.push(frame)
    }
    return frames
  }

  /** Index of the earliest "\n\n" or "\r\n\r\n", or -1. */
  private indexOfTerminator(): number {
    const lf = this.buffer.indexOf('\n\n')
    const crlf = this.buffer.indexOf('\r\n\r\n')
    if (lf === -1) return crlf
    if (crlf === -1) return lf
    return Math.min(lf, crlf)
  }

  /** Length of the terminator beginning at `idx` (4 for CRLFCRLF, 2 for LFLF). */
  private terminatorLengthAt(idx: number): number {
    return this.buffer.startsWith('\r\n\r\n', idx) ? 4 : 2
  }

  /** Flush at end-of-stream so a final frame without a trailing blank line is not lost. */
  flush(): SseFrame[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest.trim()) return []
    const frame = this.parseFrame(rest)
    return frame ? [frame] : []
  }

  private parseFrame(raw: string): SseFrame | null {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of raw.replace(/\r/g, '').split('\n')) {
      if (line.startsWith(':')) continue // comment / heartbeat (e.g. ": connected")
      if (line.startsWith('id:')) continue // sequence number, irrelevant to channel replies
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length === 0) return null
    return { event, data: dataLines.join('\n') }
  }
}

/**
 * Fold one frame into the accumulating reply. Exported so tests can drive the reducer
 * directly without standing up a server.
 */
export function applyFrame(frame: SseFrame, acc: { text: string; error: string | null }): void {
  let payload: any
  try {
    payload = JSON.parse(frame.data)
  } catch {
    return // non-JSON data line — ignore rather than crash the channel
  }

  switch (frame.event) {
    case 'content_chunk':
      // The agent's actual assistant text. Deltas arrive in order, so concatenation is correct.
      if (typeof payload?.text === 'string') acc.text += payload.text
      break
    case 'error':
      // The agent reports stop/pause as `error` + a flag; only a real failure is an error.
      if (!payload?.stopped && !payload?.paused) {
        acc.error = typeof payload?.message === 'string' ? payload.message : 'agent error'
      }
      break
    case 'done':
      if (payload?.finished === false && !acc.error) {
        acc.error = '任务未完成（可能达到轮次上限）'
      }
      break
    default:
      // thinking_chunk / tool_args_chunk / planner_* / etc. are narration — not the answer.
      break
  }
}

/**
 * Call the local agent over SSE and return the accumulated reply.
 *
 * Never throws: transport failures are returned as `error` so a channel can respond gracefully.
 */
export async function callAgent(opts: CallAgentOptions): Promise<AgentReply> {
  const port = process.env.PORT || '3000'
  const url = `${opts.baseUrl || `http://localhost:${port}`}/api/chat/agent`
  const timeoutMs = opts.timeoutMs ?? 180_000
  const acc: { text: string; error: string | null } = { text: '', error: null }

  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: opts.userText }],
        ...(opts.extraBody || {}),
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      return { text: '', error: `agent HTTP ${res.status}` }
    }
    if (!res.body) return { text: '', error: 'agent returned no body' }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseFrameParser()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        applyFrame(frame, acc)
      }
    }
    for (const frame of parser.flush()) applyFrame(frame, acc)

    return { text: acc.text.trim(), error: acc.error }
  } catch (err: any) {
    const aborted = err?.name === 'AbortError'
    return { text: acc.text.trim(), error: aborted ? `agent timeout after ${timeoutMs}ms` : String(err?.message || err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
