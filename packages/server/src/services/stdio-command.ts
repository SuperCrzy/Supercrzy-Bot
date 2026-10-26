/**
 * Cross-platform stdio command resolution (2026-10-26).
 *
 * Background: since 18.20.2 / 20.12.2 / 22 (the fix for CVE-2024-27980), Node refuses
 * to spawn .bat / .cmd without a shell and throws EINVAL. On Windows, `npx`, `npm` and
 * `pnpm` are all .cmd wrappers, so `spawn('npx', [...])` fails on Node 22/24 every time.
 *
 * The MCP StdioServerParameters type exposes no shell option, so the only way around it
 * is to flip the roles: cmd.exe becomes the executable and the original command moves
 * into argv. `/d /s /c` is npm's own calling form — skip the AutoRun registry command
 * and strip the outermost quote pair when present.
 *
 * Why a separate file: this decision had already been written twice, once wrongly
 * (computer-use) and once not at all (mcp-manager). A third independent copy is only a
 * matter of time.
 */

/** Whether a command name is a script wrapper that needs cmd.exe on Windows */
function needsShellOnWindows(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (!c) return false
  // Explicit .exe runs directly; .cmd/.bat and extension-less names (npx/npm/node,
  // resolved through PATHEXT) all need a shell.
  if (c.endsWith('.exe')) return false
  return true
}

/**
 * Normalise `(command, args)` into something spawnable on the current platform.
 *
 * - POSIX: returned unchanged
 * - Windows with a .exe: returned unchanged
 * - Windows with .cmd/.bat/no extension: rewritten to `cmd.exe /d /s /c <command> <args...>`
 *
 * WARNING: callers must pass args the **program** generated, never free-form user text.
 * After going through cmd.exe the arguments are parsed by a shell, so untrusted input
 * here would be an injection vector. Both current callers pass either a fixed package
 * name or the user's own MCP server config — equivalent to typing the command into a
 * terminal themselves.
 */
export function resolveStdioCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  if (!needsShellOnWindows(command)) return { command, args }
  const comspec = process.env.ComSpec || 'cmd.exe'
  return { command: comspec, args: ['/d', '/s', '/c', command, ...args] }
}
