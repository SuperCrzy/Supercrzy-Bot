/**
 * 复现「AI 执行过程的回复有问题」：跑一轮真实的工具任务，把**过程段的 DOM 结构**打出来。
 *
 * 为什么必须是 DOM 而不是看 SSE：老板报的现象是"每段旁白末尾多一个孤立句号"、
 * "旁白中英跳"。前者只能靠**节点边界**判断（一个孤立 `.` 是独立 `<p>` 还是段内换行），
 * 从事件流看不出来；后者要看正文段与思考段/工具卡的**实际交错**。
 *
 * 同时把 SSE 的 content_chunk 序列 tee 下来，用于把 DOM 现象对回事件。
 *
 * 用法：node scripts/diag/probe-process-reply.mjs ["提示词"]
 * 只读：不删会话、不改设置（会新建一次对话轮次）。
 */
import { createRequire } from 'node:module'
// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { chromium } = require(__ROOT + '/packages/server/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://localhost:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROMPT = process.argv[2] || '帮我查一下「AI Agent 在 2026 年的最新进展」，整理成一份简报，每个结论都带上来源链接。'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))

// 把 SSE 原始事件 tee 到页面里（不改变响应本身）
await page.addInitScript(() => {
  window.__ev = []
  const of = window.fetch
  window.fetch = async (u, init) => {
    const url = typeof u === 'string' ? u : String(u?.url || '')
    const res = await of(u, init)
    if (!url.includes('/api/chat/agent')) return res
    try {
      const [a, b] = res.body.tee()
      ;(async () => {
        const rd = b.getReader(); const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await rd.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const parts = buf.split('\n\n'); buf = parts.pop() || ''
          for (const p of parts) {
            const em = /^event: (.+)$/m.exec(p); const dm = /^data: (.*)$/m.exec(p)
            if (!em || !dm) continue
            let d = null
            try { d = JSON.parse(dm[1]) } catch { }
            window.__ev.push({ t: Math.round(performance.now()), ev: em[1], d })
          }
        }
      })()
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch { return res }
  }
})

async function dismissModals() {
  await page.waitForTimeout(800)
  const has = async () => (await page.locator('.n-modal-mask').count()) > 0
  if (!(await has())) return
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (await has()) { await page.mouse.click(12, 400); await page.waitForTimeout(300) }
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(2600)
await dismissModals()

await page.evaluate(() => { window.__ev.length = 0 })
// 打字输入（直接设 value 不触发 Vue 的 v-model，必须用键盘输入）
const input = page.locator('textarea').last()
await input.click()
await input.type(PROMPT, { delay: 0 })
await page.waitForTimeout(200)
await page.keyboard.press('Enter')

console.log(`已发送：${PROMPT}\n（等待本轮跑完…）`)

/**
 * 抓"这一轮 assistant 块"的全貌。
 *
 * ⚠️ 必须用 `textContent` 而不是 `innerText`：`innerText` 会**跳过隐藏节点**，
 *    而折叠态（done 之后）恰好把过程区隐藏 —— 用 innerText 会得到"旁白根本没渲染"的
 *    错误结论（第一版就踩了）。这里同时记录 hidden 标记，把"没渲染"和"渲染了但被折叠"分开。
 */
const SNAP_FN = `(() => {
  // 骨架（实测）：.message.assistant > .message-body > .msg-flow-renderer > [.process-collapse-bar, 各 flow 节点..., .message-content]
  //             以及 .message-body > .message-tokens
  const all = Array.from(document.querySelectorAll('.message.assistant .msg-flow-renderer'))
  const root = all[all.length - 1]
  if (!root) return { err: 'no .msg-flow-renderer' }
  const parts = []
  const walk = (el, d) => {
    for (const c of el.children) {
      const cls = String(c.className || '')
      const txt = String(c.textContent || '').replace(/\\s+/g, ' ').trim()
      const hidden = !c.offsetParent || getComputedStyle(c).display === 'none' || getComputedStyle(c).visibility === 'hidden'
      parts.push({ d, tag: c.tagName.toLowerCase(), cls: cls.slice(0, 58), hidden, text: txt.slice(0, 120) })
      if (d < 4 && !/^(PRE|CODE|SVG)$/.test(c.tagName)) walk(c, d + 1)
    }
  }
  walk(root, 0)
  return { parts: parts.slice(0, 80), visibleText: String(root.innerText || '').slice(0, 1800) }
})()`

async function snap(label) {
  const s = await page.evaluate(SNAP_FN)
  console.log(`\n──────── 快照 ${label} ────────`)
  if (s.err) { console.log('  ', s.err); return s }
  for (const p of s.parts) {
    console.log(`${'  '.repeat(p.d)}${p.hidden ? '[隐藏]' : '      '}<${p.tag}> ${p.cls}  «${p.text}»`)
  }
  return s
}

// 流式期间多抓几次（老板看到的"执行过程"就是这个时刻的形态）
const marks = [5000, 12000, 25000, 45000]
const snaps = []
let prev = 0
for (const mk of marks) {
  await page.waitForTimeout(mk - prev)
  prev = mk
  snaps.push(await snap(`流式中 t≈${mk}ms`))
}
await page.waitForFunction(() => window.__ev.map((e) => e.ev).includes('done'), { timeout: 420000 })
  .catch(() => console.log('⚠️ 等 done 超时'))
await page.waitForTimeout(3500) // 等打字机播完 + done 对账落定
await snap('done 之后（+3.5s）')

const out = await page.evaluate(() => {
  const ev = window.__ev
  return {
    sse: ev.map((e) => {
      const d = e.d || {}
      const pick = e.ev === 'content_chunk' || e.ev === 'content' ? { text: String(d.text || d.content || '').slice(0, 130) }
        : e.ev === 'tool_call' ? { name: d.name }
          : e.ev === 'thinking' ? { reasoning: String(d.reasoning || '').slice(0, 130) }
            : {}
      return { t: e.t, ev: e.ev, ...pick }
    }),
  }
})

console.log('\n=== SSE 关键事件（content_chunk / content / tool_call）===')
for (const e of (out.sse || []).filter((x) => ['content_chunk', 'content', 'tool_call'].includes(x.ev))) {
  console.log(`  ${String(e.t).padStart(6)}ms ${e.ev.padEnd(15)} ${JSON.stringify(e.text ?? e.name ?? '')}`)
}
console.log('\n页面异常:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
