/** Serialize work for each conversation without blocking unrelated conversations. */
export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly counts = new Map<string, number>()
  private total = 0

  constructor(private readonly perKeyLimit = 20, private readonly totalLimit = 200) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const count = this.counts.get(key) ?? 0
    if (count >= this.perKeyLimit || this.total >= this.totalLimit) return Promise.reject(new Error('channel_queue_full'))
    this.counts.set(key, count + 1)
    this.total++
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => {}, () => {})
    this.tails.set(key, tail)
    return result.finally(() => {
      const remaining = (this.counts.get(key) ?? 1) - 1
      if (remaining) this.counts.set(key, remaining)
      else this.counts.delete(key)
      this.total--
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
  }
}
