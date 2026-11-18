import { describe, expect, it } from 'vitest'
import { KeyedTaskQueue } from './keyed-task-queue'

describe('conversation task queue', () => {
  it('serializes the same key while other keys continue', async () => {
    const queue = new KeyedTaskQueue()
    const order: string[] = []
    let finish!: () => void
    const first = queue.run('a', async () => { order.push('first'); await new Promise<void>((resolve) => { finish = resolve }); order.push('done') })
    const second = queue.run('a', async () => { order.push('second') })
    const other = queue.run('b', async () => { order.push('other') })
    await other
    expect(order).toEqual(['first', 'other'])
    finish()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'other', 'done', 'second'])
  })
  it('continues after failure and enforces per-conversation limits', async () => {
    const queue = new KeyedTaskQueue(2, 10)
    let reject!: (error: Error) => void
    const first = queue.run('a', () => new Promise<void>((_, fail) => { reject = fail }))
    const handled = first.catch(() => {})
    const second = queue.run('a', async () => 'next')
    await expect(queue.run('a', async () => 'overflow')).rejects.toThrow('channel_queue_full')
    await Promise.resolve()
    reject(new Error('failed'))
    await handled
    expect(await second).toBe('next')
    expect(await queue.run('a', async () => 'after')).toBe('after')
  })
})
