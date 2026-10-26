/**
 * 终端会话管理器（对齐 Harness tool-terminal 六件套：open/list/send/read/signal/close）
 *
 * 与 shell_exec 的区别：
 *  - shell_exec：一次性执行 → 拿结果 → 结束（只读/查询类，禁止写）
 *  - terminal：持久会话 → 可长任务后台运行 / 交互式程序 / 多次读输出 / 发中断信号
 *
 * 权限：仅 full 权限可用（terminal_open 时校验），沙箱白名单路径外拒绝。
 */
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

interface TerminalSession {
  id: string
  proc: ChildProcess
  shell: string
  cwd: string
  createdAt: number
  /** 输出环形缓冲（上限 200KB，超限丢最旧） */
  buffer: string
  /** 上次 read 的消费位置（增量读取） */
  consumed: number
  exited: boolean
  exitCode: number | null
}

const MAX_BUFFER = 200 * 1024

const sessions = new Map<string, TerminalSession>()

/** 追加输出到缓冲（超限裁剪最旧一半） */
function appendOutput(s: TerminalSession, chunk: string) {
  s.buffer += chunk
  if (s.buffer.length > MAX_BUFFER) {
    s.buffer = s.buffer.slice(-MAX_BUFFER)
    s.consumed = Math.max(0, s.buffer.length - MAX_BUFFER)
  }
}

/**
 * 各平台的默认交互 shell 与启动参数。
 *
 * 🔴 2026-10-26：原来默认写死 `/bin/bash` 且固定传 `-i`。Windows 上没有 /bin/bash，
 * spawn 直接报 `ENOENT` —— 实测表现是 terminal_open 看似成功（会话对象已建、错误只写进
 * 输出缓冲区），而 terminal_read 拿不到任何输出并报 spawn /bin/bash ENOENT。
 * cmd.exe 也不接受 `-i`（那是 POSIX shell 的参数）。
 *
 * Unix 侧**维持 /bin/bash 不变**：换成 $SHELL 会把用户的 zsh 启动脚本一并带进来，
 * 输出里混入提示符/别名提示，属于与本 bug 无关的行为变化。要改应单独做并验证。
 */
export function defaultShellSpec(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    // %ComSpec% 是所有 Windows 都保证存在的；/Q 关回显，减少缓冲区噪音
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/Q'] }
  }
  return { shell: '/bin/bash', args: ['-i'] }
}

/** 打开一个持久终端会话（交互式 shell；cwd 可指定） */
export function terminalOpen(
  cwd?: string,
  shell?: string,
): { ok: true; id: string } | { ok: false; error: string } {
  // 会话上限防泄漏：最多 8 个，超出拒绝并提示先关
  if (sessions.size >= 8) {
    return { ok: false, error: '终端会话已达上限（8 个），请先关闭不用的会话（terminal_close）' }
  }
  const spec = defaultShellSpec()
  const useShell = shell || spec.shell
  const useArgs = shell ? [] : spec.args
  const id = randomUUID().slice(0, 8)
  try {
    const proc = spawn(useShell, useArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const s: TerminalSession = {
      id, proc, shell: useShell, cwd: cwd || process.cwd(), createdAt: Date.now(),
      buffer: '', consumed: 0, exited: false, exitCode: null,
    }
    proc.stdout?.on('data', (d: Buffer) => appendOutput(s, d.toString()))
    proc.stderr?.on('data', (d: Buffer) => appendOutput(s, d.toString()))
    proc.on('exit', (code) => {
      s.exited = true
      s.exitCode = code
      appendOutput(s, `\n[terminal ${id} exited, code ${code}]\n`)
    })
    proc.on('error', (err) => appendOutput(s, `\n[terminal error: ${err.message}]\n`))
    sessions.set(id, s)
    return { ok: true, id }
  } catch (err: any) {
    return { ok: false, error: `启动失败: ${err.message}` }
  }
}

/** 列出全部会话 */
export function terminalList(): Array<{ id: string; shell: string; cwd: string; running: boolean; since: number }> {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    shell: s.shell,
    cwd: s.cwd,
    running: !s.exited,
    since: s.createdAt,
  }))
}

/** 向会话发送命令（写 stdin + 换行；会话已退出则拒绝） */
export function terminalSend(id: string, command: string): { ok: boolean; error?: string } {
  const s = sessions.get(id)
  if (!s) return { ok: false, error: '会话不存在' }
  if (s.exited) return { ok: false, error: '会话已退出' }
  try {
    s.proc.stdin?.write(command + '\n')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 增量读取会话输出（从上次消费位置；未读尽返回 nextOffset 供下次继续） */
export function terminalRead(id: string, offset?: number): { ok: true; output: string; nextOffset: number; exited: boolean } | { ok: false; error: string } {
  const s = sessions.get(id)
  if (!s) return { ok: false, error: '会话不存在' }
  const from = Math.min(offset ?? s.consumed, s.buffer.length)
  const output = s.buffer.slice(from)
  s.consumed = s.buffer.length
  return { ok: true, output, nextOffset: s.consumed, exited: s.exited }
}

/** 向会话发信号（SIGINT 中断当前命令 / SIGTERM 终止 / 其他） */
export function terminalSignal(id: string, signal: string): { ok: boolean; error?: string } {
  const s = sessions.get(id)
  if (!s) return { ok: false, error: '会话不存在' }
  if (s.exited) return { ok: false, error: '会话已退出' }
  try {
    s.proc.kill(signal as NodeJS.Signals)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 关闭会话（发 SIGTERM，1s 后强杀） */
export function terminalClose(id: string): { ok: boolean; error?: string } {
  const s = sessions.get(id)
  if (!s) return { ok: false, error: '会话不存在' }
  try {
    s.proc.kill('SIGTERM')
  } catch { /* 已退出 */ }
  setTimeout(() => {
    try { if (!s.exited) s.proc.kill('SIGKILL') } catch { /* ignore */ }
  }, 1000)
  sessions.delete(id)
  return { ok: true }
}
