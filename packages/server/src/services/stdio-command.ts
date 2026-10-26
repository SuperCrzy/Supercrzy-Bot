/**
 * 跨平台 stdio 子进程命令解析（2026-10-26）。
 *
 * 背景：Node 自 18.20.2 / 20.12.2 / 22 起（CVE-2024-27980 的修复）**拒绝在不带 shell 的
 * 情况下 spawn .bat / .cmd**，直接抛 `EINVAL`。而 Windows 上 `npx`、`npm`、`pnpm` 全是
 * `.cmd` 包装器 —— 于是 `spawn('npx', [...])` 在 Windows + Node 22/24 上必然失败。
 *
 * MCP 的 `StdioServerParameters` 不暴露 shell 选项，所以只能反过来：把 `cmd.exe` 当可执行
 * 文件、把原命令放进参数里。`/d /s /c` 是 npm 自己的调用形式 —— 跳过 AutoRun 注册表命令，
 * 并按需去掉最外层引号。
 *
 * 为什么单独成文件：这套判断已经在两个地方各写过一次（computer-use 写错了、
 * mcp-manager 干脆没写），第三次再各写一遍只是时间问题。
 */

/** 判断一个命令名是否是需要经 cmd.exe 启动的脚本包装器 */
function needsShellOnWindows(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (!c) return false
  // 明确的 exe 直接跑；.cmd/.bat 以及无扩展名的（npx/npm/node，靠 PATHEXT 解析）都要经 shell
  if (c.endsWith('.exe')) return false
  return true
}

/**
 * 把 `(command, args)` 规范成当前平台可直接 spawn 的形式。
 *
 * - POSIX：原样返回
 * - Windows 且命令是 `.exe`：原样返回
 * - Windows 且命令是 `.cmd/.bat/无扩展名`：改成 `cmd.exe /d /s /c <command> <args...>`
 *
 * ⚠️ 调用方传入的 args 必须是**程序生成的**，不能来自用户输入的自由文本 —— 经 cmd.exe 后
 * 参数会被 shell 解析，存在注入面。当前两个调用方（computer-use 的固定包名、
 * mcp-manager 里用户配置的 server 命令）都属于"用户自己的配置"，与在终端里直接敲命令等价。
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
