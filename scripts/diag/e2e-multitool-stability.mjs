/**
 * 端到端多工具任务稳定性压测
 *
 * 目的：验证 reasoning_content 400 是否真的修住了 —— 不是在最小序列上，而是跑真实 Agent 循环。
 * 每个任务用独立 sessionId，走 POST /api/chat/agent（SSE），统计：
 *   工具调用轮数、是否出现 tool_sequence / API error 事件、耗时、完成状态。
 *
 * 用只读工具（file_read / git_status / git_diff / web_search / news_search）构造多轮依赖任务，
 * 避开 SENSITIVE_TOOLS（shell_exec / file_write / file_delete / memory_consolidate）以免卡在授权等待。
 *
 * 用法：
 *   node scripts/diag/e2e-multitool-stability.mjs            # 默认 20 次
 *   node scripts/diag/e2e-multitool-stability.mjs 3          # 跑 3 次（冒烟）
 */

const BASE = process.env.SC_BASE || 'http://127.0.0.1:3000'
const N = Number(process.argv[2] || 20)

const PROMPTS = [
  '先读 packages/server/src/services/error-classifier.ts，再读它的测试文件，最后一句话说明测试覆盖了哪几类错误。',
  '先用 git_status 看工作区，再 git_diff 看 packages/server/src/services/agent.ts 的改动，最后一句话总结改了什么。',
  '先读 scripts/diag/README.md，再读 packages/server/src/services/tool-sequence.test.ts，最后一句话说明两者描述的是不是同一条规则。',
  '先读根 package.json，再读 packages/server/package.json，对比 scripts 字段差异，一句话说明。',
  '先读 docs/STABILITY_REVIEW_2026-09-20.md，再读 docs/OPENSOURCE_PLAN_2026-09-20.md，一句话说明两份文档的分工。',
  '先读 packages/server/src/services/sse-health.ts，再 git_diff 它，一句话说明 safeWriteSse 的作用。',
  '先读 packages/server/src/services/memory-category.ts，再读它的测试，一句话说明分类词表的规模。',
  '用 web_search 搜一下 "DeepSeek reasoning_content must be passed back"，再读 scripts/diag/README.md，一句话说明两者关系。',
  '先读 packages/server/src/tools/file-read.ts（若不存在则先 file_exists 确认），再读 packages/server/src/tools/shared.ts，一句话说明工具模块的组织方式。',
  '先读 packages/client/src/utils/fold-state.ts，再 grep 不到了就改读它的测试文件，一句话说明 hasEnd 的作用。',
  '先读 AGENTS.md 或 README.md（存在哪个读哪个），再一次 git_status，一句话说明仓库当前是否干净。',
  '先读 packages/server/src/services/error-classifier.test.ts，再读 packages/server/src/services/tool-sequence.test.ts，一句话说明两者断言风格的差异。',
  '先 git_diff 看 packages/server/src/services/tool-sequence.test.ts，再读该文件末尾 40 行，一句话说明新增用例。',
  '先读 docs/MEDIA_CAPABILITY_ASSESSMENT_2026-09-19.md，再读 docs/OPENSOURCE_PLAN_2026-09-20.md，一句话说明前者提到的阻塞项在后者里的状态。',
  '先用 file_exists 确认 packages/server/bin/ffmpeg 是否存在，再 git_status 看它是否被跟踪，一句话说明结论。',
  '先读 packages/server/src/services/tool-guardrails.ts，再读它的测试，一句话说明护栏拦的是什么。',
  '先读 packages/server/src/services/context-compressor.ts 的前 60 行，再读它的测试，一句话说明压缩策略。',
  '先读 packages/client/src/utils/fold-state.test.ts，再读 packages/client/src/utils/delivery.ts，一句话说明两者的关系。',
  '用 web_search 查 "DeepSeek 深度思考 reasoning_content 回传 400"，再读 scripts/diag/README.md 的规则章节，一句话确认结论是否一致。',
  '先 git_diff 看 scripts/diag 目录下的新增文件，再读 scripts/diag/acceptance-rc-fix.ts，一句话说明它的验收方式。',
]

function parseSse(text) {
  const ev = { tool_call: 0, tool_result: 0, error: 0, content: 0, thinking: 0, other: 0 }
  const errors = []
  let content = ''
  let turnMax = 0
  for (const block of text.split('\n\n')) {
    const m = /event: (\w+)\ndata: (.*)/s.exec(block)
    if (!m) continue
    const name = m[1]
    let d = {}
    try { d = JSON.parse(m[2]) } catch { /* ignore */ }
    if (name in ev) ev[name]++
    else ev.other++
    // ⚠️ 只认真正的错误通道：error 事件 + 带 error:true 的 content 事件。
    // 绝不去扫原始文本——工具结果会把源码里 `reasoning_content` / `tool_sequence` 字样原样回显，
    // 扫原文会产生假警报（本脚本第一版就踩了这个坑）。
    if (name === 'error' && d.message) errors.push(String(d.message).slice(0, 200))
    if (name === 'content' && d.error && d.content) errors.push(String(d.content).slice(0, 200))
    if (name === 'content' && d.content) content += d.content
    if (name === 'thinking' && typeof d.turn === 'number') turnMax = Math.max(turnMax, d.turn)
  }
  return { ev, errors, content, turnMax }
}

async function runOne(i, prompt) {
  const sessionId = `stab-${Date.now()}-${i}`
  const t0 = Date.now()
  let status = 0, text = '', err = ''
  try {
    const res = await fetch(`${BASE}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], sessionId, agent: true }),
      signal: AbortSignal.timeout(600000),
    })
    status = res.status
    text = await res.text()
  } catch (e) {
    err = `${e.name}: ${e.message}`
  }
  const ms = Date.now() - t0
  const { ev, errors, content, turnMax } = parseSse(text)
  const blob = errors.join(' ')
  const hit400 = /API error 400|reasoning_content|must be passed back/i.test(blob)
  const hitToolSeq = /tool_sequence/i.test(blob)
  return { i, sessionId, status, ms, ev, errors, turnMax,
           contentLen: content.length, hit400, hitToolSeq, err }
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).then(r => r.ok).catch(() => false)
  if (!health) { console.error(`服务未就绪：${BASE}/api/health 不可达`); process.exit(1) }

  const todo = []
  for (let i = 0; i < N; i++) todo.push([i + 1, PROMPTS[i % PROMPTS.length]])

  console.log(`端到端多工具压测 · ${todo.length} 次 · ${BASE}\n`)
  console.log('  #   状态  工具轮  工具调用  耗时     400?  tool_seq?  内容  备注')
  console.log('  ' + '─'.repeat(84))

  const results = []
  for (const [i, prompt] of todo) {
    const r = await runOne(i, prompt)
    results.push(r)
    const note = r.err ? r.err.slice(0, 30)
      : r.errors.length ? r.errors[0].slice(0, 30)
      : ''
    console.log(
      `  ${String(i).padStart(2)}  ${String(r.status).padEnd(5)} ` +
      `${String(r.turnMax).padStart(5)}  ${String(r.ev.tool_call).padStart(6)}   ` +
      `${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${r.hit400 ? ' 是 ' : '  否'} ${r.hitToolSeq ? '    是    ' : '    否    '} ` +
      `${String(r.contentLen).padStart(5)}  ${note}`
    )
    await new Promise(res => setTimeout(res, 1500)) // 别把限流打成限流
  }

  const ok = results.filter(r => r.status === 200 && !r.hit400 && !r.hitToolSeq && !r.err)
  const withTools = results.filter(r => r.ev.tool_call >= 2)
  const failed400 = results.filter(r => r.hit400)
  const failedSeq = results.filter(r => r.hitToolSeq)

  console.log('\n=== 汇总 ===')
  console.log(`  总次数                    ${results.length}`)
  console.log(`  干净完成                  ${ok.length}/${results.length} = ${Math.round(ok.length / results.length * 100)}%`)
  console.log(`  真发起 ≥2 次工具调用的     ${withTools.length}/${results.length}`)
  console.log(`  命中 400 (reasoning/API)  ${failed400.length}`)
  console.log(`  命中 tool_sequence        ${failedSeq.length}`)
  console.log(`  平均耗时                  ${(results.reduce((a, r) => a + r.ms, 0) / results.length / 1000).toFixed(1)}s`)
  const toolCounts = withTools.map(r => r.ev.tool_call)
  if (toolCounts.length) console.log(`  工具调用次数分布           ${toolCounts.join(', ')}`)

  if (failed400.length || failedSeq.length) {
    console.log('\n  失败明细：')
    for (const r of [...failed400, ...failedSeq]) {
      console.log(`    #${r.i} ${r.ms / 1000}s ${r.errors.join(' | ') || r.err}`)
    }
  }
  console.log('\n接着用 SQL 核对真实运行库里的 task_runs：')
  console.log("  select status, failure_code, count(*) from task_runs group by 1,2;")
}

main().catch(e => { console.error(e); process.exit(1) })
