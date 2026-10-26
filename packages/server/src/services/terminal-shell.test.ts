/**
 * 终端默认 shell 的平台分支（2026-10-26）。
 *
 * Windows 实机报 `terminal_open 看似成功、terminal_read 报 spawn /bin/bash ENOENT`：
 * 默认 shell 写死成 POSIX 路径，且固定传 `-i`（cmd.exe 不接受）。
 *
 * 本机是 macOS，没法真的在 Windows 上起进程 —— 所以这里**翻转 process.platform** 直接断言
 * 分支结果。这能钉住"Windows 不会拿到 /bin/bash 或 -i"，但钉不住"cmd.exe 在 Windows 上
 * 真能交互" —— 那一层必须靠实机回归，已在 commit 里注明。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { defaultShellSpec } from './terminal-manager'

const realPlatform = process.platform
function withPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => withPlatform(realPlatform))

describe('defaultShellSpec：按平台给 shell', () => {
  it('Windows → cmd.exe（或 %ComSpec%），且不带 POSIX 的 -i', () => {
    withPlatform('win32')
    const spec = defaultShellSpec()
    expect(spec.shell).not.toContain('/bin/bash')
    expect(spec.shell.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(spec.args).not.toContain('-i')
  })

  it('Windows 尊重 %ComSpec%', () => {
    withPlatform('win32')
    const orig = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      expect(defaultShellSpec().shell).toBe('C:\\Windows\\System32\\cmd.exe')
    } finally {
      if (orig === undefined) delete process.env.ComSpec
      else process.env.ComSpec = orig
    }
  })

  it('macOS / Linux → /bin/bash -i（行为与修复前一致，不引入 $SHELL 变量）', () => {
    for (const p of ['darwin', 'linux'] as NodeJS.Platform[]) {
      withPlatform(p)
      expect(defaultShellSpec()).toEqual({ shell: '/bin/bash', args: ['-i'] })
    }
  })
})
