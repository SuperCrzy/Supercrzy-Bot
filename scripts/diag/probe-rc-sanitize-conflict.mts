/**
 * 对照实验：sanitizeToolCallSequence 会不会因 reasoning_content 把工具历史删掉？
 *
 * 背景（2026-10-14）：本仓曾同时存在两条互相矛盾的判据 ——
 *   · ensureReasoningEcho ：「字段值为空串也满足协议」（09-20 对照实验结论）
 *   · sanitizeToolCallSequence ：「不能补假 rc，只能整轮降级」，判据 hasReasoningContent（trim 非空）
 * 而管线顺序是 sanitize 先跑、echo 后跑 ⇒ echo 补的空串救不回已被砍的轮次。
 * 又因 saveCheckpoint / 恢复两侧都调 sanitize，破坏会被写进检查点 ⇒ 静默丢工具历史，API 仍 200。
 *
 * 本脚本就是定位该问题时用的对照实验：**唯一变量 = 被观察那轮 assistant 的 rc 取值**。
 * 期望（修复后）：四种取值结果完全一致（7 条消息、2 个 tool_calls、2 条 tool 消息）。
 * 若某种取值出现 tool_calls 变少，说明降级判据又被加回来了。
 *
 * 用法：./node_modules/.bin/tsx scripts/diag/probe-rc-sanitize-conflict.mts
 */
import { sanitizeToolCallSequence, ensureReasoningEcho } from '../../packages/server/src/services/agent'

const tc = (id: string) => ({
  id, type: 'function' as const, function: { name: 'web_search', arguments: '{"q":"x"}' },
})

/** 形状固定：一轮正常工具调用 + 一轮被观察的工具调用 + 一条收尾 assistant。 */
function build(rcOfWatchedTurn: string | undefined): any[] {
  const watched: any = { role: 'assistant', content: '', tool_calls: [tc('b')] }
  if (rcOfWatchedTurn !== undefined) watched.reasoning_content = rcOfWatchedTurn
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'turn1' },
    { role: 'assistant', content: '', reasoning_content: '思考1', tool_calls: [tc('a')] },
    { role: 'tool', tool_call_id: 'a', content: 'r1' },
    watched,                                             // ← 唯一变量在这一轮
    { role: 'tool', tool_call_id: 'b', content: 'r2' },
    { role: 'assistant', content: '最终答案' },
  ]
}

const stat = (msgs: any[]) => ({
  messages: msgs.length,
  toolCalls: msgs
    .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    .reduce((n: number, m: any) => n + m.tool_calls.length, 0),
  toolMsgs: msgs.filter((m) => m.role === 'tool').length,
})

const DS = { withTools: true, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' }
const CASES: Array<string | undefined> = [undefined, '', '   ', '思考B']

console.log('被观察那轮的 rc       过 sanitize 后            再过 echo 后（实际发出）')
console.log('-'.repeat(78))
const results: ReturnType<typeof stat>[] = []

for (const rc of CASES) {
  const raw = build(rc)
  const afterSanitize = sanitizeToolCallSequence(raw)
  const afterEcho = ensureReasoningEcho(afterSanitize, DS)
  const s = stat(afterEcho)
  results.push(s)
  const label = rc === undefined ? '(缺字段)' : rc === '' ? '(空串)' : `(${JSON.stringify(rc)})`
  const a = stat(raw)
  console.log(
    `${String(label).padEnd(20)} ${`${a.messages}→${stat(afterSanitize).messages} 条, calls ${stat(afterSanitize).toolCalls}`.padEnd(24)} ${s.messages} 条, calls ${s.toolCalls}, tool ${s.toolMsgs}`,
  )
}

const first = JSON.stringify(results[0])
const consistent = results.every((r) => JSON.stringify(r) === first)
console.log('-'.repeat(78))
if (consistent) {
  console.log(`✅ 四种 rc 取值结果一致：${first} —— 工具历史不因 rc 丢失`)
} else {
  console.log(`❌ 结果不一致 ⇒ 降级判据依赖了 rc：${JSON.stringify(results)}`)
  process.exitCode = 1
}
