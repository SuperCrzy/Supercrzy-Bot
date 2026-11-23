import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { useSessionDrafts } from './useSessionDrafts'

describe('session composer drafts', () => {
  it('keeps unsent text and attachments in their own session', () => {
    const session = ref<string | null>('a')
    const text = ref('')
    const files = ref<Array<{ name: string }>>([])
    const scope = effectScope()
    scope.run(() => useSessionDrafts(() => session.value, text, files))
    text.value = 'Draft A'
    files.value = [{ name: 'a.txt' }]
    session.value = 'b'
    expect(text.value).toBe('')
    expect(files.value).toEqual([])
    text.value = 'Draft B'
    session.value = 'a'
    expect(text.value).toBe('Draft A')
    expect(files.value).toEqual([{ name: 'a.txt' }])
    text.value = ''
    files.value = []
    session.value = 'b'
    expect(text.value).toBe('Draft B')
    session.value = 'a'
    expect(text.value).toBe('')
    expect(files.value).toEqual([])
    scope.stop()
  })
})
