import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { shouldAutoSendQueue, useSessionQueue } from './useSessionQueue'

describe('session message queue', () => {
  it('keeps queued messages with their original conversation', () => {
    const selected = ref<string | null>('a')
    const scope = effectScope()
    const queue = scope.run(() => useSessionQueue(() => selected.value))!
    queue.value.push({ id: 'one', text: 'message for A' })
    selected.value = 'b'
    expect(queue.value).toEqual([])
    queue.value.push({ id: 'two', text: 'message for B' })
    expect(shouldAutoSendQueue('a', selected.value, queue.value.length)).toBe(false)
    selected.value = 'a'
    expect(queue.value.map((item) => item.text)).toEqual(['message for A'])
    expect(shouldAutoSendQueue('a', selected.value, queue.value.length)).toBe(true)
    expect(shouldAutoSendQueue('a', selected.value, queue.value.length, false)).toBe(false)
    queue.value.splice(0)
    selected.value = 'b'
    expect(queue.value.map((item) => item.text)).toEqual(['message for B'])
    selected.value = 'a'
    expect(queue.value).toEqual([])
    scope.stop()
  })
})
