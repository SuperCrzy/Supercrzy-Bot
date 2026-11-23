import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { useSessionDrafts } from './useSessionDrafts'

describe('session composer drafts', () => {
  it('clears sent welcome content without removing uploads that completed later', () => {
    const session = ref<string | null>(null)
    const text = ref('hello')
    const files = ref<Array<{ name: string }>>([{ name: 'sent.txt' }])
    const scope = effectScope()
    const drafts = scope.run(() => useSessionDrafts(() => session.value, text, files))!
    const sent = [...files.value]
    session.value = 'new-session'
    drafts.addAttachments(null, [{ name: 'late.txt' }])
    drafts.consumeDraft(null, 'hello', sent)
    session.value = null
    expect(text.value).toBe('')
    expect(files.value.map(f => f.name)).toEqual(['late.txt'])
    scope.stop()
  })
  it('returns a delayed upload to its originating draft after a session switch', () => {
    const session = ref<string | null>('a')
    const text = ref('draft A')
    const files = ref<Array<{ name: string }>>([])
    const scope = effectScope()
    const drafts = scope.run(() => useSessionDrafts(() => session.value, text, files))!
    session.value = 'b'
    drafts.addAttachments('a', [{ name: 'late.txt' }])
    expect(files.value).toEqual([])
    session.value = 'a'
    expect(text.value).toBe('draft A')
    expect(files.value).toEqual([{ name: 'late.txt' }])
    scope.stop()
  })
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
