/** Read a local Agent SSE response without mistaking a dropped stream for success. */
export async function readWechatAgentStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  options: { idleMs?: number; onEvent?: (name: string, payload: Record<string, unknown>) => void } = {},
): Promise<{ text: string; filePath: string; completed: boolean }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let chunks = ''
  let final = ''
  let filePath = ''
  let doneEvent = false
  let terminal: string | undefined
  const consume = (line: string) => {
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return }
    if (!line.startsWith('data:')) return
    let data: Record<string, unknown>
    try { data = JSON.parse(line.slice(5).trim()) } catch { return }
    if (eventName === 'content_chunk' && typeof data.text === 'string') chunks += data.text
    if (eventName === 'content' && typeof data.content === 'string') final = data.content
    if (eventName === 'file_created' && typeof data.path === 'string') filePath = data.path
    if (eventName === 'done') {
      doneEvent = data.finished !== false
      if (!final && !chunks && typeof data.summary === 'string') final = data.summary
    }
    if (eventName === 'task_state' && ['completed', 'failed', 'cancelled', 'paused'].includes(String(data.status))) terminal = String(data.status)
    if (eventName === 'checkpoint_available' || eventName === 'turn_limit_reached') terminal = 'interrupted'
    options.onEvent?.(eventName, data)
    eventName = ''
  }
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('agent_stream_idle_timeout')) }, options.idleMs ?? 60_000)
      })
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await Promise.race([reader.read(), idle]) } finally { if (timer) clearTimeout(timer) }
      if (part.done) break
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) consume(line.replace(/\r$/, ''))
    }
    buffer += decoder.decode()
    if (buffer) consume(buffer.replace(/\r$/, ''))
    return { text: final || chunks, filePath, completed: doneEvent && (!terminal || terminal === 'completed') }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}
