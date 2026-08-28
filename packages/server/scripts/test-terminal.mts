/**
 * terminal-manager 集成验证脚本（真实 spawn bash）
 * 说明：vitest worker 与 bash 交互子进程生命周期冲突(多测试连跑 SIGTERM 143)，改用独立脚本验证
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/test-terminal.mts
 */
import { terminalOpen, terminalSend, terminalRead, terminalList, terminalSignal, terminalClose } from '../src/services/terminal-manager'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log('=== terminal-manager 集成验证 ===')
// 清理
for (const s of terminalList()) terminalClose(s.id)

// 1. open
const r1 = terminalOpen('/tmp')
check('open 创建会话', r1.ok, JSON.stringify(r1))
if (!r1.ok) { console.log(`结果: ${pass} 通过 / ${fail} 失败`); process.exit(fail ? 1 : 0) }
const id = r1.id
check('open 后列表可见', terminalList().some((s) => s.id === id))

// 2. send + read
terminalSend(id, 'echo hello-manager-verify')
await sleep(800)
const rd1 = terminalRead(id)
check('send+read 拿到输出', rd1.ok && rd1.output.includes('hello-manager-verify'), JSON.stringify(rd1))

// 3. read 增量
terminalSend(id, 'echo second-line-verify')
await sleep(800)
const rd2 = terminalRead(id)
check('read 增量(新输出)', rd2.ok && rd2.output.includes('second-line-verify'), JSON.stringify(rd2))
check('read 增量(不含旧输出)', !rd2.output.includes('hello-manager-verify'))

// 4. signal 中断
terminalSend(id, 'sleep 30')
await sleep(400)
const sig = terminalSignal(id, 'SIGINT')
check('signal 发送成功', sig.ok, JSON.stringify(sig))
await sleep(500)

// 5. close 后移除
terminalClose(id)
await sleep(1300)
check('close 后会话移除', !terminalList().some((s) => s.id === id))

// 6. 错误路径
check('send 到不存在会话返回错误', !terminalSend('nope', 'x').ok)
check('read 到不存在会话返回错误', !terminalRead('nope').ok)

for (const s of terminalList()) terminalClose(s.id)
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
