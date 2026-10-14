/**
 * AI 浏览器「原生视图」端到端 harness（2026-09-23）
 *
 * 它是什么：一个**最小 Electron 应用**，只做三件事 ——
 *   1. 开 CDP 端口（`--remote-debugging-port=0`，和 main.cjs 完全一样）
 *   2. 用一个宿主窗口加载 fixture 页面，并通过**真实 preload + 真实 IPC 接线**
 *      （`browser-view-wiring.cjs`，就是产品里那一份）来摆布原生视图
 *   3. 把每一步的证据打到 stdout（`PASS/FAIL <name> :: detail`），交给
 *      `scripts/diag/verify-desktop-attach.mjs` 汇总
 *
 * 为什么不让它直接跑 `main.cjs`：main.cjs 会连带起内嵌后端、托盘、自动更新器、单实例锁 ——
 * 那会把"视图接线错了"和"别的东西崩了"混在一起，而且没法稳定断言。
 * 这里刻意只复用**接线模块本身**，剩下的角色（起后端、挑端口）交给验证脚本编排。
 *
 * 用法（由验证脚本拉起，不要手跑）：
 *   SUPERCRZY_HARNESS_USERDATA=/tmp/xx SUPERCRZY_HARNESS_BACKEND_PORT=3011 \
 *   SUPERCRZY_HARNESS_FIXTURE_PORT=3012 \
 *   electron browser-view-demo.cjs --no-sandbox --disable-gpu
 */
const electron = require('electron')
const { app, BrowserWindow, ipcMain } = electron
const path = require('path')
const http = require('http')
const cdp = require('./cdp-endpoint.cjs')
const { wireBrowserView } = require('./browser-view-wiring.cjs')

const USER_DATA = process.env.SUPERCRZY_HARNESS_USERDATA || '/tmp/supercrzy-harness-userdata'
const BACKEND_PORT = Number(process.env.SUPERCRZY_HARNESS_BACKEND_PORT || 0)
const FIXTURE_PORT = Number(process.env.SUPERCRZY_HARNESS_FIXTURE_PORT || 0)
const CDP_TIMEOUT_MS = 8000
const BOOT_TS = Date.now()

app.setPath('userData', USER_DATA)

// 与 main.cjs 完全相同的两个开关（其中 port=0 + DevToolsActivePort 是这条链的地基）
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

const B = `http://127.0.0.1:${BACKEND_PORT}`
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`

const results = []
const log = (m) => console.log(m)
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
/** 阶段面包屑：卡住时最后一条面包屑直接告诉你卡在哪一步（没有它只能靠猜） */
const step = (n) => console.log(`HARNESS_STEP ${n}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 给任何可能永不 settle 的 promise 套一个超时。
 *
 * 🔴 为什么必须有：本 harness 第一版就是死在"`await` 一个永不变的 promise"上 ——
 * `waitFor` 的 deadline 检查在 `await fn()` **之后**，所以 fn 内部的 fetch 一旦不返回，
 * 整个超时机制形同虚设（静默 180 秒，没有任何输出，看起来像进程死了）。
 * 教训：只要跨进程（IPC / CDP / HTTP），等待就必须是**可超时的等待**。
 */
function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms) }),
  ])
}

async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* 继续等 */ }
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

// ---- fixture 页面 ----
// 拆成两个地址是刻意的，复刻真实形态：
//   · /host    = **宿主 UI** 的角色（放画布、量矩形），必须被接管逻辑排除
//   · /content = **AI 浏览器里那个网页**（有输入框），必须被接管
// 两者若同址，就没法既断言"宿主被排除"又断言"内容页被接管"。
const HOST_CSS = '#canvas{position:absolute;left:40px;top:120px;width:420px;height:300px;background:#e8ecf1}'
const hostHtml = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>HARNESS-HOST-UI</title>
<style>html,body{margin:0;height:100%;font-family:system-ui}${HOST_CSS}</style></head><body>
<h1 id="host-title">HARNESS HOST UI</h1>
<div id="canvas">CANVAS</div>
<script>
  window.__t = {
    rect: function () { var r = document.getElementById('canvas').getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height } },
    move: function (l, t) { var c = document.getElementById('canvas')
      c.style.left = l + 'px'; c.style.top = t + 'px'; return window.__t.rect() }
  }
</script>
</body></html>`

const contentHtml = (title) => `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;padding:24px;font-family:system-ui}</style></head><body>
<h1 id="content-title">${title}</h1>
<input id="q" placeholder="搜索关键词" style="width:320px;height:28px">
</body></html>`

let fixtureServer = null
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    fixtureServer = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0]
      const send = (html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      }
      if (url === '/host') return send(hostHtml)
      if (url === '/content') return send(contentHtml('HARNESS-CONTENT'))
      if (url === '/second') return send(contentHtml('HARNESS-PAGE-TWO'))
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    fixtureServer.on('error', reject)
    fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(fixtureServer))
  })
}

/** fixture 里的内容页地址（会被 AI 侧接管的那一页） */
const CONTENT_URL = `${FIX}/content`
const SECOND_URL = `${FIX}/second`

// ---- 后端 API 小工具（一律带超时：见 withTimeout 的注释）----
async function api(pathname, opts, timeoutMs = 8000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(B + pathname, { ...(opts || {}), signal: ctl.signal })
    let body = null
    try { body = await res.json() } catch { /* 非 JSON */ }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}
const act = (payload) => api('/api/collab/browser/act', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}, 20000)

let hostWin = null
let manager = null

app.whenReady().then(async () => {
  // ① 先验最底层：真 Electron 上，CDP 端口能不能被发现（这是整条链的地基）
  step('cdp-port')
  const { found, reason } = await cdp.waitForCdpPort(USER_DATA, { sinceMs: BOOT_TS, timeoutMs: CDP_TIMEOUT_MS })
  if (!found) {
    check('cdp_port_discovered', false, reason)
    return finish()
  }
  check('cdp_port_discovered', true, `port=${found.port}`)
  log(`HARNESS_CDP_ENDPOINT http://127.0.0.1:${found.port}`)

  step('fixture-server')
  try { await startFixtureServer() } catch (e) {
    check('fixture_server_up', false, e && e.message)
    return finish()
  }

  manager = wireBrowserView({ Electron: electron, ipcMain, getHostWindow: () => hostWin, log })

  step('host-window')
  hostWin = new BrowserWindow({
    width: 1100, height: 760, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await hostWin.loadURL(FIX + '/host')
  check('host_window_at_fixture_origin', hostWin.webContents.getURL().startsWith(FIX + '/host'), hostWin.webContents.getURL())

  // 通知验证脚本：CDP 端口已就绪，可以起后端了
  console.log(`HARNESS_READY cdp=${found.port} fixture=${FIXTURE_PORT} backend=${BACKEND_PORT}`)

  // ② 等后端（由验证脚本在拿到 HARNESS_READY 后拉起，attach 模式）
  step('wait-backend')
  const up = await waitFor(async () => { const r = await api('/api/health', undefined, 3000); return r.status === 200 }, 45000, 300)
  if (!up) { check('backend_ready', false, `${B}/api/health 一直没就绪`); return finish() }

  const sess = await api('/api/collab/browser/sessions')
  check('backend_attach_mode', sess.body && sess.body.mode === 'attach' && !!sess.body.startPageUrl,
    JSON.stringify({ mode: sess.body && sess.body.mode, startPageUrl: sess.body && sess.body.startPageUrl }))
  const START = sess.body && sess.body.startPageUrl
  if (!START) return finish()
  check('start_page_url_on_backend', START.startsWith(`http://127.0.0.1:${BACKEND_PORT}`), START)

  // ③ 走真实渲染进程：量矩形 → 真实 IPC → 原生视图摆位
  step('show-view')
  const drive = (script) => withTimeout(hostWin.webContents.executeJavaScript(script), 10000, 'executeJavaScript')
  const showScript = `(async () => {
    var r = window.__t.rect()
    return await window.supercrzyDesktop.browserView.show({ bounds: { x: r.x, y: r.y, width: r.width, height: r.height }, url: ${JSON.stringify(START)} })
  })()`
  let st = null
  try { st = await drive(showScript) } catch (e) {
    check('bridge_available', false, `preload 桥调用失败：${e && e.message}`)
    return finish()
  }
  check('bridge_available', !!(st && st.available), JSON.stringify({ available: st && st.available, error: st && st.error }))
  check('view_attached_and_visible', !!(st && st.attached && st.visible), JSON.stringify({ attached: st && st.attached, visible: st && st.visible }))

  const wc = () => manager._webContents()
  const viewUrl = () => (wc() ? wc().getURL() : '')

  const loaded = await waitFor(() => viewUrl() === START, 15000, 150)
  check('view_loaded_start_page', !!loaded, viewUrl())
  // 关键：不只是"URL 对了"，而是**真的渲染出了内容**（白屏在 CDP 层同样表现为 URL 正确）
  const rendered = await waitFor(async () => {
    const v = await withTimeout(wc().executeJavaScript('String(!!document.getElementById("sc-start"))'), 5000, 'probe-start')
    return v === 'true'
  }, 8000, 150)
  check('view_really_rendered', !!rendered, '起始页 DOM 里能查到 #sc-start（证明不是白屏）')

  // ④ 接管决策可排障：AI 侧应当采纳视图起始页，并跳过宿主 fixture 页
  // ⚠️ 必须先**触发一次接管**：`attach` 报告是 `getPage()`（懒接管）的副产物，
  // 只调 /browser/sessions 看到的永远是 null。第一版就是这里读了个空对象。
  step('attach-report')
  const snap = await api('/api/collab/browser/snapshot', undefined, 25000)
  const after = await api('/api/collab/browser/sessions')
  const rep = (after.body && after.body.attach) || {}
  // ★ 这一条是今天修掉的那个死结的正面证据：
  //   起始页与宿主 UI **同 origin**（都在后端口上），按 origin 一刀切排除会把起始页自己也排掉
  //   → attach 模式一个可接管页面都没有。判据收窄为「origin + SPA 入口路径」后才同时成立。
  check('backend_adopted_start_page', rep.adopted === START,
    `adopted=${rep.adopted} snap.status=${snap.status} snap.error=${JSON.stringify((snap.body && snap.body.error) || '')}`.slice(0, 220))
  check('host_page_excluded', (rep.skipped || []).some((s) => String(s).startsWith(FIX + '/host')), JSON.stringify(rep.skipped))

  // ⑤ 像人一样把视图导航到内容页（这一步在原生模式下就是地址栏做的事）
  step('navigate-to-content')
  await drive(`window.supercrzyDesktop.browserView.navigate(${JSON.stringify(CONTENT_URL)}); true`)
  const atContent = await waitFor(() => viewUrl() === CONTENT_URL, 15000, 150)
  check('navigate_in_view_works', !!atContent, viewUrl())
  // 断言的是**行为**：视图被导航后，AI 那一侧看到的就该是那一页。
  // 不要去断言 `attach.adopted` —— 它记的是"最后一次采纳决策"，视图导航后它**不会**变
  // （getPage 缓存了同一个 Page 对象，这是对的）。第一版断言错了这一点，
  // 于是"AI 明明在 /content 上读写正常"却报了 FAIL —— 断实现细节而不是断行为，就会这样。
  const snap2 = await api('/api/collab/browser/snapshot', undefined, 25000)
  check('ai_side_follows_view_navigation', snap2.body && snap2.body.url === CONTENT_URL,
    `snapshot.url=${snap2.body && snap2.body.url}`)
  // 顺带钉住那个"会说谎的诊断"：报告的 adopted 是旧的，但 pages 必须给出实时页面
  const sessNow = await api('/api/collab/browser/sessions')
  const livePages = (sessNow.body && sessNow.body.pages) || []
  check('sessions_report_live_page', livePages.some((p) => p && p.url === CONTENT_URL),
    `pages=${JSON.stringify(livePages)} adopted=${(sessNow.body && sessNow.body.attach && sessNow.body.attach.adopted) || ''}`)

  // ⑥ 人打字 → AI 看得见（反向）★
  // 用 Chromium 自己的 insertText（走输入管线，和真人敲键盘同一条路），
  // 而不是 Playwright 的 fill —— 否则就不是"跨运行时同一份 DOM"的证据了。
  // 注意：必须先把文本打给**视图**那一侧（人是在 AI 浏览器里打字的），
  // 第一版把 #q 当成了宿主窗口的元素，于是焦点在宿主页、文本打在视图页 → 两边都不对。
  step('human-types')
  const focusOk = await withTimeout(wc().executeJavaScript('String(!!document.getElementById("q"))'), 5000, 'has-q').catch(() => 'false')
  if (focusOk !== 'true') check('content_page_has_input', false, '视图里的内容页没有 #q')
  else check('content_page_has_input', true, '视图里的内容页有 #q')
  await wc().focus()
  await withTimeout(wc().executeJavaScript('document.getElementById("q").focus(); true'), 5000, 'focus-q')
  await withTimeout(wc().insertText('HUMAN-TYPED-42'), 6000, 'insertText')
  const seenByAi = await waitFor(async () => {
    const r = await api('/api/collab/browser/interactive')
    const items = (r.body && r.body.items) || []
    return items.find((x) => String(x).includes('HUMAN-TYPED-42'))
  }, 10000, 250)
  check('human_types_ai_sees', !!seenByAi, seenByAi ? String(seenByAi).slice(0, 90) : 'AI 侧 /browser/interactive 没看到人输入的内容')

  // ⑦ AI 打字 → 人看得见（正向）★
  step('ai-types')
  const typed = await act({ action: 'type', text: 'AI-TYPED-99', into: '搜索关键词' })
  const inDom = await waitFor(async () => {
    const v = await withTimeout(wc().executeJavaScript('String((document.getElementById("q")||{}).value || "")'), 5000, 'read-q')
    return String(v || '').includes('AI-TYPED-99') ? v : null
  }, 8000, 200)
  check('ai_types_human_sees', !!inDom,
    `act.result=${JSON.stringify(typed.body && typed.body.result)} 视图DOM=${JSON.stringify(inDom)}`)

  // ⑧ bounds：真实 IPC 端到端 + 布局变化后跟随
  step('bounds')
  const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 1
  const rectOk = (native, dom) => near(native.x, dom.x) && near(native.y, dom.y)
    && near(native.width, dom.width) && near(native.height, dom.height)
  const b1 = manager._view().getBounds()
  const r1 = await drive('window.__t.rect()')
  check('bounds_ipc_end_to_end', rectOk(b1, r1), `native=${JSON.stringify(b1)} dom=${JSON.stringify(r1)}`)

  const r2 = await drive('window.__t.move(210, 300)')
  await drive(`window.supercrzyDesktop.browserView.bounds(${JSON.stringify(r2)}); true`)
  await sleep(250)
  const b2 = manager._view().getBounds()
  check('bounds_follow_layout_change', rectOk(b2, r2), `native=${JSON.stringify(b2)} dom=${JSON.stringify(r2)}`)

  // ⑨ 隐藏 / 再显示
  step('hide-show')
  const hidden = await drive('window.supercrzyDesktop.browserView.hide()')
  check('hide_works', !!(hidden && hidden.available && hidden.visible === false), JSON.stringify({ visible: hidden && hidden.visible }))
  await drive(showScript)
  const reShown = await waitFor(() => manager.getState().visible, 5000, 100)
  check('show_works_again', !!reShown, JSON.stringify(manager.getState()))
  // 关键回归：已经导航到内容页后，再 show（带起始页 url）**不能**把页面顶回去。
  // 这正是 wiring 里"只在视图还没有页面时才 loadURL"那条分支存在的理由 ——
  // 它一旦回归，"人对着 AI 正在看的那一页操作"这条链就断了，而现象只是"页面自己跳回去了"。
  await sleep(600)
  check('show_does_not_stomp_current_page', viewUrl() === CONTENT_URL, `url=${viewUrl()}（期望 ${CONTENT_URL}）`)

  // ⑩ 释放会话**不能**杀掉 Electron（attach 模式下 browser === Electron 本体）
  step('close-session')
  const closed = await api('/api/collab/browser/close', { method: 'POST' })
  await sleep(600)
  check('close_session_keeps_electron_alive', !hostWin.isDestroyed() && app.isReady(),
    `close.status=${closed.status} hostWindowDestroyed=${hostWin.isDestroyed()}`)
  check('close_session_keeps_view_alive', !!manager._view() && !!wc() && !wc().isDestroyed(), viewUrl())

  // ⑪ 再导航一次，确认关闭后仍能重新接管（不是一次性快照）
  step('re-adopt-after-close')
  await drive(`window.supercrzyDesktop.browserView.navigate(${JSON.stringify(SECOND_URL)}); true`)
  const atSecond = await waitFor(() => viewUrl() === SECOND_URL, 10000, 150)
  check('navigate_after_close_works', !!atSecond, viewUrl())
  const reAdopt2 = await waitFor(async () => {
    await api('/api/collab/browser/interactive')
    const s = await api('/api/collab/browser/sessions')
    const at = s.body && s.body.attach
    return at && at.adopted === SECOND_URL ? at : null
  }, 15000, 300)
  check('re_adopt_after_close', !!reAdopt2, reAdopt2 ? `adopted=${reAdopt2.adopted}` : `adopted 仍不是 ${SECOND_URL}`)

  finish()
}).catch((e) => {
  check('harness_uncaught', false, (e && e.stack) || String(e))
  finish()
})

function finish() {
  const passed = results.filter((r) => r.ok).length
  console.log(`\nHARNESS_DONE ${passed}/${results.length}`)
  for (const r of results.filter((x) => !x.ok)) console.log(`HARNESS_FAILED ${r.name}`)
  setTimeout(() => {
    try { if (manager) manager.destroy() } catch { /* 忽略 */ }
    try { if (fixtureServer) fixtureServer.close() } catch { /* 忽略 */ }
    app.exit(results.some((r) => !r.ok) ? 1 : 0)
  }, 300)
}
