/**
 * 真机端到端：过程旁白**不许被工具卡劈成两半**（P0 #1 集成层验收，2026-09-29）。
 *
 * ## 为什么必须有这一层
 *
 * `stores/chat-stream.test.ts` 只钉住状态机本身；「SSE 事件 → ChatView 接线 → flow 结构」
 * 这一段是集成面（老板方法论：**单测全绿 ≠ 集成正确**）。
 * 这里用**真实 SSE 帧**回放那次的因果序列，走页面里真正的 `handleAgentEvent`：
 *
 * ```
 * content_chunk 「第二步：我现在数一下当前目录下有多少」   ← 旁白还在流
 * tool_args_chunk 开始                                    ← 客户端此刻 push 工具卡
 * content_chunk 「个 .md 文件。」                          ← 尾片落在参数流之后
 * tool_args_chunk 结束 → tool_call                        ← 这里才该封口
 * ```
 *
 * ## 取证方式：读「客户端算出来准备落库的 flow」，不读 DOM
 *
 * 试过读 DOM，**不可靠**：完成态下 `shouldShowText` 只留最后一段正文
 * （`v-if="seg.kind === 'text' && shouldShowText(seg)"`），而且过程段进 detail 态后
 * 只渲染 thinking/tool、**根本不渲染 text 节点** —— 于是"DOM 里没有"这件事
 * 既可能是有 bug 也可能只是折叠了，**证明不了任何东西**。
 *
 * 改成拦写请求读 body：客户端收尾时会 POST 消息（含 `attachments.flow`），
 * 那份 flow 就是 chat-stream + agent-flow + ChatView 三方合成的产物，正是被 bug 改坏的东西。
 *
 * ## 不碰真实数据
 *
 * 所有非 GET 的 `/api/**` 都被截成本地 200 空响应（含落库），只有 `/api/chat/agent`
 * 由本脚本伪造 SSE ⇒ **不消耗模型额度、不写老板的库**。
 */
import { createRequire } from 'node:module'
// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { chromium } = require(__ROOT + '/packages/server/node_modules/playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:5173'

const HEAD = '第二步：我现在数一下当前目录下有多少'
const TAIL = '个 .md 文件。'
const ANSWER = '一共 2 个 .md 文件。'

const ev = (id, event, data) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const SSE =
  ev(1, 'thinking_chunk', { text: '先看看目录。' }) +
  ev(2, 'content_chunk', { text: HEAD }) +                                   // 旁白还在流
  ev(3, 'tool_args_chunk', { toolCallId: '', name: 'shell_exec', chunk: '{"command":"ls *.md' }) + // 工具卡此刻进 flow
  ev(4, 'content_chunk', { text: TAIL }) +                                  // ⚠️ 尾片落在参数流之后
  ev(5, 'tool_args_chunk', { toolCallId: 'call_1', name: 'shell_exec', chunk: '"}' }) +
  ev(6, 'tool_call', { id: 'call_1', name: 'shell_exec', arguments: '{"command":"ls *.md"}', status: 'running' }) +
  ev(7, 'tool_result', { toolCallId: 'call_1', name: 'shell_exec', result: 'a.md\nb.md' }) +
  ev(8, 'content_chunk', { text: ANSWER }) +
  // 收尾帧必须发：`done` 之后客户端才会跑「打字机收尾 + flow 对账 + 落库」，
  // 少了它拿到的只是中途快照（答案是空的，会误报失败）
  // ⚠️ 载荷键必须是 `content`（`case 'content'` 读的是 `data.content`）。
  // 写成 `text` 会让 msg.content 变 undefined ⇒ finish 收不到 finalText、走回旧路径，
  // 表现是"答案被并进旁白那一段"——那是**回放脚本的 bug**，不是产品 bug（已实测踩过）。
  ev(9, 'content', { content: ANSWER }) +
  ev(10, 'done', {})

const log = (...a) => console.log(...a)
let failures = 0
function check(name, ok, extra = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
let agentHit = 0
const savedBodies = []

await page.route('**/api/**', async (route) => {
  const req = route.request()
  if (req.url().includes('/api/chat/agent')) {
    agentHit += 1
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: SSE })
  }
  if (req.method() !== 'GET') {
    // 不落库；但把 body 留下来 —— 客户端算出来的 flow 就在这里，比读 DOM 可靠得多
    try { savedBodies.push(req.postData() || '') } catch { /* ignore */ }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  }
  return route.continue()
})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const ta = page.locator('textarea:visible').last()
  await ta.click()
  await ta.fill('数一下 md 文件')
  await ta.press('Enter')

  // 等打字机播完 + 客户端收尾落库
  await page.waitForTimeout(7000)
} finally {
  await browser.close()
}

// ── 从「客户端真实算出来并准备落库的 flow」里取证 ──────────────────────────────
let flow = null
log('--- 每次落库的 flow 形状（诊断用）---')
for (const b of savedBodies) {
  let shape = '(无 flow)'
  if (b.includes('"flow"')) {
    try {
      const parsed = JSON.parse(b)
      const cand = parsed?.attachments?.flow || parsed?.flow
      if (Array.isArray(cand)) shape = cand.map((n) => `${n.kind}${n.kind === 'text' ? '(' + (n.text || '').length + ')' : ''}`).join(' | ')
    } catch { shape = '(解析失败)' }
  }
  log('   ', shape)
}
for (const b of savedBodies) {
  if (!b.includes('"flow"')) continue
  try {
    const parsed = JSON.parse(b)
    const cand = parsed?.attachments?.flow || parsed?.flow
    // 取"最后一份节点最多"的落库：客户端会多次落库（工具结果一次、done 收尾一次、
    // 打字机播完再补一次），节点数相同的情况下**后面那份才是终态** ⇒ 用 >= 让后者胜出
    if (Array.isArray(cand) && cand.length && (!flow || cand.length >= flow.length)) flow = cand
  } catch { /* 非 JSON 的写请求 */ }
}

const segs = (flow || []).filter((n) => n.kind === 'text').map((n) => n.text)
const kinds = (flow || []).map((n) => n.kind)
log('SSE 命中 /api/chat/agent 次数:', agentHit)
log('捕获到的写请求数:', savedBodies.length)
log('客户端算出的 flow 节点序列:', JSON.stringify(kinds))
log('text 段内容:', JSON.stringify(segs))

check('确实打到了聊天主通道（否则后面的断言无意义）', agentHit > 0, `hits=${agentHit}`)
check('确实捕获到客户端算出的 flow（否则断言无对象）', !!flow, `writes=${savedBodies.length}`)
check('过程区产出 2 段正文（旁白 + 答案）', segs.length === 2, `segs=${segs.length}`)

const merged = segs.some((s) => s.includes(HEAD) && s.includes(TAIL))
check('🔴 尾片与旁白合并在同一段（未被工具卡劈开）', merged, JSON.stringify(segs))

const punctOnly = segs.filter((s) => /^[\s.。！!？?,，、;；:：…]+$/.test(s))
check('🔴 不存在「只有标点」的正文段（老板截图里的孤立句号）', punctOnly.length === 0, JSON.stringify(punctOnly))
check('不存在单独成段的尾片', !segs.some((s) => s.trim() === TAIL), JSON.stringify(segs.filter((s) => s.trim() === TAIL)))

const ti = kinds.indexOf('text')
const ki = kinds.indexOf('tool')
check('旁白段排在工具卡之前（顺序没乱）', ti >= 0 && ki >= 0 && ti < ki, JSON.stringify(kinds))
check('最终答案成段出现', segs.some((s) => s.includes(ANSWER)), JSON.stringify(segs))

log(failures === 0 ? '\n结果：全部通过' : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
