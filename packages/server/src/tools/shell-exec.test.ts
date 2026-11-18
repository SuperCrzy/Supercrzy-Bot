import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../services/sandbox', () => ({
  scanDangerousPath: () => null,
  sandboxify: async (command: string) => ({ exec: command, args: null, sandboxed: false }),
  markSandboxUnavailable: () => {},
  WORKSPACE_ROOT: '/tmp',
}))
import shellExec from './shell-exec'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-shell-stop-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('shell process cancellation on POSIX', () => {
  const command = `node -e 'process.stdout.write("ready"); setTimeout(() => require("fs").writeFileSync("marker", "late"), 1000)'`
  it('returns normal command output without reporting a timeout', async () => {
    const result = await shellExec.execute({ command: `node -e 'process.stdout.write("done")'`, timeout: 5000 }, { cwd: dir })
    expect(result).toBe('done')
  })
  it('kills the shell and its child on timeout before the child can write', async () => {
    const result = await shellExec.execute({ command, timeout: 400 }, { cwd: dir })
    expect(result).toContain('超时')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(existsSync(join(dir, 'marker'))).toBe(false)
  })
  it('terminates the process group after a stop request', async () => {
    let stop = false
    const result = await shellExec.execute({ command, timeout: 5000 }, { cwd: dir, shouldStop: () => stop, onOutput: () => { stop = true } })
    expect(result).toContain('已请求停止')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(existsSync(join(dir, 'marker'))).toBe(false)
  })
})
