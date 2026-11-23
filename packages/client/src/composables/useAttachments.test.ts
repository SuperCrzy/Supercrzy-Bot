import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { Attachment } from '@/types'
import { useAttachments } from './useAttachments'
import { useSessionDrafts } from './useSessionDrafts'

vi.mock('@/utils/i18n-error', () => ({ errMsg: (_code: string, fallback: string) => fallback }))
afterEach(() => vi.unstubAllGlobals())

function event(name: string) {
  return { target: { files: [new File(['x'], name, { type: 'text/plain' })], value: name } } as unknown as Event
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('attachment uploads', () => {
  it('returns OCR text to the original draft after switching sessions', async () => {
    const session = ref<string | null>('a')
    const text = ref('')
    const files = ref<Attachment[]>([])
    const scope = effectScope()
    const ocr = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ files: [{ id: 'img', name: 'a.png', type: 'image/png', url: '/img' }] })).mockReturnValueOnce(ocr.promise))
    const app = scope.run(() => {
      const drafts = useSessionDrafts(() => session.value, text, files)
      return useAttachments({ uploadedFiles: files, sessionId: () => session.value ?? undefined, addAttachments: drafts.addAttachments, updateAttachment: drafts.updateAttachment,
        fileInputRef: ref(null), t: key => key, onError: vi.fn() })
    })!
    await app.handleFileSelect(event('a.png'))
    session.value = 'b'
    ocr.resolve(Response.json({ texts: ['识别文字'] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(files.value).toEqual([])
    session.value = 'a'
    expect(files.value[0]?.ocrTexts).toEqual(['识别文字'])
    scope.stop()
  })
  it('keeps delayed responses in their original session and tracks concurrent uploads', async () => {
    const session = ref<string | null>('a')
    const text = ref('draft A')
    const files = ref<Attachment[]>([])
    const scope = effectScope()
    const first = deferred<Response>(), second = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const app = scope.run(() => {
      const drafts = useSessionDrafts(() => session.value, text, files)
      return useAttachments({ uploadedFiles: files, sessionId: () => session.value ?? undefined, addAttachments: drafts.addAttachments, updateAttachment: drafts.updateAttachment,
        fileInputRef: ref(null), t: key => key, onError: vi.fn() })
    })!
    const one = app.handleFileSelect(event('a.txt'))
    session.value = 'b'
    const two = app.handleFileSelect(event('b.txt'))
    expect(app.uploading.value).toBe(true)
    first.resolve(Response.json({ files: [{ id: 'a', name: 'a.txt', type: 'text/plain' }] }))
    await one
    expect(app.uploading.value).toBe(true)
    expect(files.value).toEqual([])
    second.resolve(Response.json({ files: [{ id: 'b', name: 'b.txt', type: 'text/plain' }] }))
    await two
    expect(app.uploading.value).toBe(false)
    expect(files.value.map(f => f.name)).toEqual(['b.txt'])
    session.value = 'a'
    expect(files.value.map(f => f.name)).toEqual(['a.txt'])
    expect(text.value).toBe('draft A')
    scope.stop()
  })
})
