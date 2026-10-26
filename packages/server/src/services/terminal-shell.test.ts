/**
 * Platform-specific default shell (2026-10-26).
 *
 * Reported from Windows: `terminal_open` appeared to succeed while `terminal_read`
 * answered `spawn /bin/bash ENOENT`. The default shell was the POSIX literal
 * `/bin/bash`, and the spawn always passed `-i` — which cmd.exe does not accept.
 *
 * This machine is macOS, so the Windows branch is asserted by flipping
 * `process.platform`. That pins "Windows never receives /bin/bash or -i", but it
 * cannot prove cmd.exe interacts correctly over pipes — that needs a real run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { defaultShellSpec } from './terminal-manager'

const realPlatform = process.platform
function withPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => withPlatform(realPlatform))

describe('defaultShellSpec: shell per platform', () => {
  it('Windows: cmd.exe (or %ComSpec%), without the POSIX -i flag', () => {
    withPlatform('win32')
    const spec = defaultShellSpec()
    expect(spec.shell).not.toContain('/bin/bash')
    expect(spec.shell.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(spec.args).not.toContain('-i')
  })

  it('Windows: honours %ComSpec%', () => {
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

  it('macOS / Linux: /bin/bash -i, unchanged from before the fix (no $SHELL lookup)', () => {
    for (const p of ['darwin', 'linux'] as NodeJS.Platform[]) {
      withPlatform(p)
      expect(defaultShellSpec()).toEqual({ shell: '/bin/bash', args: ['-i'] })
    }
  })
})
