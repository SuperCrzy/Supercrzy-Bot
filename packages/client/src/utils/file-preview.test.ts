/**
 * `openFilePreview` 的分流测试（P1 图片乱码修复，2026-09-29）。
 *
 * 直接钉住症状本身：**媒体文件绝不允许把后端返回的 `content` 灌进文本预览**。
 * 旧实现在这里对 PNG 会写入服务端 utf-8 解码后的 35 万字符 `U+FFFD`（乱码），
 * 于是「kind: media ⇒ 走 setPreviewImage、不写 previewContent」这条断言会直接红。
 *
 * 为什么必须 mock 掉 fetch 而不是打真后端：这条测试要能在 CI 里跑，
 * 且要覆盖 `kind: binary` / `d.error` 这两个真实文件不容易造的分支。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appStore } = vi.hoisted(() => ({
  appStore: {
    previewFiles: {} as Record<string, string>,
    previewPath: '',
    previewContent: '',
    previewTs: 0,
    detailPanelVisible: false,
    detailPanelTab: '',
    clearPreviewImage: vi.fn(),
    setPreviewImage: vi.fn(),
    setDetailPanelTab: vi.fn(),
  },
}))

vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))

const { openFilePreview } = await import('./file-preview')

function stubJson(body: unknown, ok = true) {
  const f = vi.fn(async () => ({ ok, json: async () => body }))
  vi.stubGlobal('fetch', f)
  return f
}

beforeEach(() => {
  appStore.previewFiles = {}
  appStore.previewPath = ''
  appStore.previewContent = ''
  appStore.previewTs = 0
  appStore.clearPreviewImage.mockClear()
  appStore.setPreviewImage.mockClear()
  appStore.setDetailPanelTab.mockClear()
})

describe('openFilePreview 按后端 kind 分流', () => {
  it('🔴 kind:media（PNG/截图）→ 走 setPreviewImage，绝不写 previewContent', async () => {
    const url = '/api/filesystem/raw?path=%2Ftmp%2Fscreen-1.png'
    stubJson({ path: '/tmp/screen-1.png', kind: 'media', mime: 'image/png', size: 151928, url })

    await openFilePreview('/tmp/screen-1.png')

    expect(appStore.setPreviewImage).toHaveBeenCalledWith(url, true, '/tmp/screen-1.png')
    // 关键：没有把二进制内容当文本灌进去（旧实现就是在这里出乱码）
    expect(appStore.previewContent).toBe('')
    // 图片预览与文本预览互斥：必须先清掉上一张图
    expect(appStore.clearPreviewImage).toHaveBeenCalled()
  })

  it('kind:text → 写 previewContent，不碰图片预览', async () => {
    stubJson({ path: '/tmp/a.ts', kind: 'text', startLine: 1, endLine: 3, content: 'line1\nline2\nline3' })

    const d = await openFilePreview('/tmp/a.ts')

    expect(appStore.previewContent).toBe('line1\nline2\nline3')
    expect(appStore.previewPath).toBe('/tmp/a.ts L1-3')
    expect(appStore.setPreviewImage).not.toHaveBeenCalled()
    expect((d as any).kind).toBe('text')
  })

  it('kind:binary → 只显示提示文案，不渲染内容', async () => {
    stubJson({ path: '/tmp/a.zip', kind: 'binary', size: 2048, message: '二进制文件（2.0 KB）不支持文本预览' })

    await openFilePreview('/tmp/a.zip')

    expect(appStore.previewContent).toBe('二进制文件（2.0 KB）不支持文本预览')
    expect(appStore.setPreviewImage).not.toHaveBeenCalled()
  })

  it('后端报错（error）→ 返回 null，且不动任何预览状态', async () => {
    stubJson({ error: '路径不在白名单内：xxx' })

    const d = await openFilePreview('/etc/shadow')

    expect(d).toBeNull()
    expect(appStore.previewContent).toBe('')
    expect(appStore.setPreviewImage).not.toHaveBeenCalled()
  })
})
