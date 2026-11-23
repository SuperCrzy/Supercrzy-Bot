/** A completed transport is not necessarily a successfully completed task. */
export function isUnsuccessfulAgentEvent(event: string, data: any): boolean {
  if (event === 'error') return !data?.retrying
  if (event === 'done') return data?.finished === false
  return event === 'task_state' && ['failed', 'cancelled', 'paused'].includes(data?.status)
}

/** Unnumbered server errors are valid; only deduplicate numeric event IDs. */
export function nextAgentEventSequence(id: string, last: number): number | null {
  if (!/^\d+$/.test(id)) return last
  const sequence = Number(id)
  if (!Number.isSafeInteger(sequence)) return last
  return sequence > last ? sequence : null
}
