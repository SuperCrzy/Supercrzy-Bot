/**
 * stdio 命令的跨平台解析（2026-10-26）。
 *
 * 钉住的实机 bug：Windows 10 + Node 24 上 `spawn('npx.cmd', ...)` 抛 EINVAL
 * （Node 18.20.2+/20.12.2+/22 起拒绝无 shell 启动 .cmd，CVE-2024-27980 的修复），
 * computer_use 与所有 MCP stdio server 都因此起不来。
 *
 * 本机是 macOS，所以翻转 process.platform 断言分支；真正的进程启动仍需 Windows 实机回归。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { resolveStdioCommand } from './stdio-command'

const realPlatform = process.platform
function withPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => withPlatform(realPlatform))

describe('resolveStdioCommand', () => {
  it('POSIX：原样返回，绝不经 shell', () => {
    withPlatform('darwin')
    expect(resolveStdioCommand('npx', ['-y', 'pkg'])).toEqual({ command: 'npx', args: ['-y', 'pkg'] })
  })

  it('Windows：npx（无扩展名）→ 经 cmd.exe，参数保持顺序', () => {
    withPlatform('win32')
    const r = resolveStdioCommand('npx', ['-y', 'computer-use-mcp'])
    expect(r.command.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(r.args).toEqual(['/d', '/s', '/c', 'npx', '-y', 'computer-use-mcp'])
  })

  it('Windows：.cmd / .bat 同样经 cmd.exe', () => {
    withPlatform('win32')
    for (const cmd of ['npm.cmd', 'pnpm.CMD', 'run.bat']) {
      const r = resolveStdioCommand(cmd, [])
      expect(r.command.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(r.args[3]).toBe(cmd)
    }
  })

  it('Windows：已经是 .exe 的命令原样跑（不需要 shell）', () => {
    withPlatform('win32')
    const r = resolveStdioCommand('C:\\tools\\server.exe', ['--port', '1'])
    expect(r.command).toBe('C:\\tools\\server.exe')
    expect(r.args).toEqual(['--port', '1'])
  })

  it('Windows：空命令不崩（交给上层报错）', () => {
    withPlatform('win32')
    expect(() => resolveStdioCommand('', [])).not.toThrow()
  })
})
