import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'

const resolveFfmpeg = vi.hoisted(() => vi.fn(async () => ({ path: '/mock/ffmpeg', tried: [] })))
vi.mock('../services/ffmpeg', () => ({ resolveFfmpeg, ffmpegInstallHint: () => 'install ffmpeg' }))
vi.mock('./shared', async (load) => ({ ...(await load() as object), readSetting: () => '' }))
import video from './video-edit'
import image from './generate-image'

describe('media tool path guards', () => {
  it('rejects sensitive video inputs, subtitles and concat inputs before probing ffmpeg', async () => {
    const sensitive = join(homedir(), '.ssh', 'secret')
    for (const args of [
      { input: sensitive }, { subtitle_file: sensitive }, { inputs: [sensitive] },
    ]) {
      expect(await video.execute({ op: 'convert', output: '/tmp/output.mp4', ...args }, {})).toContain('输入路径不合法')
    }
    expect(resolveFfmpeg).not.toHaveBeenCalled()
  })
  it('rejects a sensitive video output before probing ffmpeg', async () => {
    expect(await video.execute({ op: 'convert', output: join(homedir(), '.ssh', 'output.mp4') }, {})).toContain('输出路径不在允许的工作区')
    expect(resolveFfmpeg).not.toHaveBeenCalled()
  })
  it('rejects image generation into a sensitive directory before making a network request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await image.execute({ prompt: 'test' }, { cwd: join(homedir(), '.ssh') })
      expect(result).toContain('输出路径不允许')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
})
