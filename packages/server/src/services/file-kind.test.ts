/**
 * 文件类型判定（图片乱码修复的地基，2026-09-29）。
 *
 * 这里钉的是**两个不能反悔的决策**：
 *  1. `.png/.jpg/…` 必须走媒体分支（否则又回到"把 PNG 当 utf-8 读"的老路）；
 *  2. `.svg` **必须留在文本路径** —— 它是文本，且一旦进 `raw` 就等于开了一条
 *     同源可执行 SVG 的通道（直接打开 URL 时文件里的 `<script>` 会在 App 源上跑）。
 */
import { describe, expect, it } from 'vitest'
import { mediaMimeOf, isBinaryPath, isNonPreviewableBinary } from './file-kind'

describe('mediaMimeOf（能当媒体内嵌渲染的类型）', () => {
  it('位图与 PDF 给出正确 MIME', () => {
    expect(mediaMimeOf('/tmp/a.png')).toBe('image/png')
    expect(mediaMimeOf('/tmp/a.jpg')).toBe('image/jpeg')
    expect(mediaMimeOf('/tmp/a.jpeg')).toBe('image/jpeg')
    expect(mediaMimeOf('/tmp/a.gif')).toBe('image/gif')
    expect(mediaMimeOf('/tmp/a.webp')).toBe('image/webp')
    expect(mediaMimeOf('/tmp/a.pdf')).toBe('application/pdf')
  })

  it('大小写不敏感（真机上 AI 写出的路径不一定全小写）', () => {
    expect(mediaMimeOf('/tmp/SHOT.PNG')).toBe('image/png')
    expect(mediaMimeOf('/tmp/Doc.PDF')).toBe('application/pdf')
  })

  it('🔴 svg 不算媒体：它是文本，且进 raw 会成为同源可执行 SVG', () => {
    expect(mediaMimeOf('/tmp/logo.svg')).toBeNull()
  })

  it('普通源码/文档不算媒体', () => {
    for (const p of ['a.ts', 'a.md', 'a.json', 'a.html', 'a.txt', 'README']) {
      expect(mediaMimeOf(`/tmp/${p}`), p).toBeNull()
    }
  })
})

describe('isBinaryPath / isNonPreviewableBinary', () => {
  it('图片既是二进制又是媒体 ⇒ 不算"不可预览"（走 raw 直出）', () => {
    expect(isBinaryPath('/tmp/a.png')).toBe(true)
    expect(isNonPreviewableBinary('/tmp/a.png')).toBe(false)
  })

  it('zip/db/字体/音视频属"二进制且文本预览无意义"', () => {
    for (const p of ['a.zip', 'a.db', 'a.woff2', 'a.mp3', 'a.mp4', 'a.wasm']) {
      expect(isNonPreviewableBinary(`/tmp/${p}`), p).toBe(true)
    }
  })

  it('文本类型一律不走二进制分支（行为与修复前一致）', () => {
    for (const p of ['a.ts', 'a.md', 'a.svg', 'a.html', 'a.log', 'a.sql', 'a.yaml']) {
      expect(isBinaryPath(`/tmp/${p}`), p).toBe(false)
      expect(isNonPreviewableBinary(`/tmp/${p}`), p).toBe(false)
    }
  })

  it('没有扩展名的路径当文本处理（不猜）', () => {
    expect(isBinaryPath('/tmp/Makefile')).toBe(false)
  })
})
