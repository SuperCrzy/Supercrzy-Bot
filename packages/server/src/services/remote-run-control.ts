/** In-process cancellation stays set even while the agent initializes. */
const active = new Map<string, { accountId: string; taskId: string; sessionId: string; stop: boolean }>()

export function registerRemoteRun(accountId: string, taskId: string, sessionId: string): () => void {
  const key = JSON.stringify([accountId, taskId])
  const run = { accountId, taskId, sessionId, stop: false }
  active.set(key, run)
  return () => { if (active.get(key) === run) active.delete(key) }
}

export function requestRemoteRunStop(accountId: string, taskId: string): boolean {
  const run = active.get(JSON.stringify([accountId, taskId]))
  if (!run) return false
  run.stop = true
  return true
}

export function requestAllRemoteRunsStop(): void {
  for (const run of active.values()) run.stop = true
}

export function isRemoteRunStopRequested(sessionId: string): boolean {
  for (const run of active.values()) if (run.sessionId === sessionId && run.stop) return true
  return false
}
