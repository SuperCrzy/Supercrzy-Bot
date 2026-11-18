/** Report slow tools without pretending they have stopped or launching new work. */
export async function waitForToolBatch<T>(run: Promise<T>, timeoutMs: number, onSlow: () => void): Promise<T> {
  const timer = setTimeout(() => {
    try { onSlow() } catch { /* reporting must not affect the running tool */ }
  }, timeoutMs)
  timer.unref()
  try { return await run } finally { clearTimeout(timer) }
}
