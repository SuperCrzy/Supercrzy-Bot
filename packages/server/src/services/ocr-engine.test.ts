import { describe, it, expect, afterEach } from 'vitest'
import { runOcr, ocrEngineStatus, resetOcrEngineCache } from './ocr-engine'

afterEach(() => resetOcrEngineCache())

describe('runOcr', () => {
  it('never throws on a missing file — the caller must be able to say WHY it failed', async () => {
    const r = await runOcr('/definitely/not/here.png')
    expect(r.texts).toEqual([])
    expect(r.engine).toBe('none')
    expect(String(r.error || '')).not.toBe('')
    // elapsed is a real measurement, not a placeholder
    expect(r.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('a failure does not poison the engine cache', async () => {
    await runOcr('/definitely/not/here.png')
    expect(ocrEngineStatus().cached).toBeNull()
  })
})

describe('ocrEngineStatus', () => {
  it('reports the current platform and only engines that could exist here', () => {
    const s = ocrEngineStatus()
    expect(s.platform).toBe(process.platform)
    if (process.platform !== 'darwin') expect(s.available).not.toContain('vision')
    if (process.platform !== 'win32') expect(s.available).not.toContain('winrt')
    // rapidocr is platform-neutral: it only needs the python script on disk
    for (const e of s.available) expect(['vision', 'winrt', 'rapidocr']).toContain(e)
  })
})
