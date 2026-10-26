/**
 * Cross-platform stdio command resolution (2026-10-26).
 *
 * Pins the behaviour behind a real failure: on Windows 10 / Node 24, `spawn('npx.cmd')`
 * threw EINVAL (Node refuses to spawn .cmd without a shell since the CVE-2024-27980
 * fix), so computer_use and every MCP stdio server failed to start.
 *
 * This machine is macOS, so the platform is flipped in the tests instead. The actual
 * process launch still needs a real Windows run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { resolveStdioCommand } from './stdio-command'

const realPlatform = process.platform
function withPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => withPlatform(realPlatform))

describe('resolveStdioCommand', () => {
  it('POSIX: returned unchanged, never shelled out', () => {
    withPlatform('darwin')
    expect(resolveStdioCommand('npx', ['-y', 'pkg'])).toEqual({ command: 'npx', args: ['-y', 'pkg'] })
  })

  it('Windows: npx (no extension) goes through cmd.exe with args in order', () => {
    withPlatform('win32')
    const r = resolveStdioCommand('npx', ['-y', 'computer-use-mcp'])
    expect(r.command.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(r.args).toEqual(['/d', '/s', '/c', 'npx', '-y', 'computer-use-mcp'])
  })

  it('Windows: .cmd and .bat also go through cmd.exe', () => {
    withPlatform('win32')
    for (const cmd of ['npm.cmd', 'pnpm.CMD', 'run.bat']) {
      const r = resolveStdioCommand(cmd, [])
      expect(r.command.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(r.args[3]).toBe(cmd)
    }
  })

  it('Windows: an .exe command runs directly, no shell needed', () => {
    withPlatform('win32')
    const r = resolveStdioCommand('C:\\tools\\server.exe', ['--port', '1'])
    expect(r.command).toBe('C:\\tools\\server.exe')
    expect(r.args).toEqual(['--port', '1'])
  })

  it('Windows: an empty command does not throw (the caller validates it)', () => {
    withPlatform('win32')
    expect(() => resolveStdioCommand('', [])).not.toThrow()
  })
})
