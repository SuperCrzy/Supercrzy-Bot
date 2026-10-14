/**
 * AI 浏览器（多会话浏览器池版 2026-09-04）
 * 目标(A 方向/老板核准): 真浏览器多实例隔离, 供网页各 end-user / 会话各自实例, 不再全局抢一个。
 * playwright-core + 系统 Chrome。每 key(如 collab session / user) 一实例; 默认 `default` 兼容旧调用。
 * 提供的画面帧/长轮询均 per-key, 各自 waitLatest 收到自己会话的新帧。
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { existsSync } from 'fs'
import { BROWSER_START_PAGE_PATH } from './ai-browser-start-page'

/** 自动探测可用的浏览器内核（mac/win/linux + env/pw自带 优先级看 detectBrowserPath 注释由下同） */
export function detectBrowserPath(): string {
  for (const env of ['SUPERCRZY_CHROME', 'CHROME_PATH']) {
    const v = process.env[env]
    if (v && existsSync(v)) return v
  }
  try {
    const ep = chromium.executablePath()
    if (ep && existsSync(ep)) return ep
  } catch { /* ignore */ }
  const isWin = process.platform === 'win32'
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates: string[] = []
  if (isWin) {
    for (const p of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
      const base = process.env[p]
      if (!base) continue
      candidates.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`, `${base}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`)
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const c of candidates) if (c && existsSync(c)) return c
  return ''
}

export interface BrowserSnapshot {
  url: string
  title: string
  screenshot: string
  ts: number
  error?: string
  /**
   * 页面视口的 CSS 尺寸（2026-09-23 新增）。
   *
   * 为什么必须带上：前端要把"人点画面的位置"换算成"页面里的坐标"才能点准。
   * 旧前端硬编码按 1000×700 算 —— 那是最早 launch 模式写死的 viewport。
   * attach 之后视图尺寸由窗口决定（可变），而且**截图的像素尺寸会随设备像素比放大**
   * （retina 上 naturalWidth = CSS 宽 × 2），所以**不能用图片尺寸反推坐标**，
   * 只能问页面自己 `window.innerWidth/innerHeight`。
   */
  viewport?: { width: number; height: number }
}

/**
 * 把「地址栏输入」归一成 Playwright 能接受的绝对 URL。
 *
 * 为什么必须有：`page.goto('baidu.com')` 会抛 `Cannot navigate to invalid URL`，
 * 而 navigate() 旧实现把它 `.catch(() => {})` 静默吃掉 → 页面停在 about:blank，
 * 用户只看到**白屏**，界面上的地址还写着 about:blank，无从判断哪里错了。
 * 2026-09-23 实测对照：`baidu.com` → about:blank(6KB 白图)；`https://www.baidu.com`
 * → 正常（标题「百度一下，你就知道」/52KB）。`example.com` 同样如此。
 * **只要不带协议就必然白屏**，与目标站点、无头模式都无关。
 */
export function normalizeUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'about:blank'
  // 带 // 的完整协议（http:// https:// file:// ws:// …）原样返回
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  // 无 // 的特殊协议原样返回（about:blank / data: / mailto: / chrome:// 的简写等）
  if (/^(about|data|mailto|tel|javascript|file|blob|chrome|view-source):/i.test(s)) return s
  // 本地回环 / 内网 / 裸 IP / 非 443 端口 → 走 http；其余一律 https
  const hostPart = s.split('/')[0]
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s)
  const isBareIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)
  const port = (hostPart.match(/:(\d+)$/) || [])[1]
  const useHttp = isLocal || isBareIp || (!!port && port !== '443')
  return (useHttp ? 'http://' : 'https://') + s
}

/**
 * 浏览器实例 key 的唯一构造入口（2026-09-23）。
 * 历史 bug：路由侧拼 `'wb:' + sid`，而 AI 工具侧走便捷导出硬编码 `'default'` →
 * 两套命名空间永不相交 = 右栏与 AI 各跑一个 Chrome，"右栏实时看 AI 操作画面"根本不可能成立。
 * 现在路由与工具都调本函数，key 必然一致。前缀保留 `wb:` 以兼容既有前端（X-Browser-Key 语义不变）。
 */
export const BROWSER_KEY_PREFIX = 'wb:'
export function browserKey(sessionId?: string | null): string {
  const raw = String(sessionId || 'default').slice(0, 64)
  // 幂等：传已带前缀的 key 不二次拼接（路由/工具两侧都可能传全量 key）
  return raw.startsWith(BROWSER_KEY_PREFIX) ? raw : BROWSER_KEY_PREFIX + raw
}

// ================= 运行模式：launch（截图镜像） / attach（接管真网页） 2026-09-23 =================
/**
 * 两种模式的本质差别，决定了后面所有分支：
 *
 * - `launch`（默认，保持既有行为）：后端自己 `chromium.launch()` 起一个**无头内核**，
 *   右栏看到的画面是这个内核的**截图**（`<img src="data:image/jpeg;base64,…">`）。
 *   人能看见，但点不了、打不了字 —— 人和 AI 是**两台浏览器**。
 * - `attach`：后端用 `connectOverCDP` **接管 Electron 窗口里那个真网页**。
 *   同一个 renderer、同一份 DOM ⇒ 人直接在页面上打字，AI 那边天然就看得到（反之亦然）。
 *   这是「AI 浏览器从监控器升级为操作面」的唯一技术前提。
 *
 * ⚠️ 默认 `launch` 是刻意的：attach 依赖 desktop 侧先开 CDP 端口并建好视图，
 * 在它落地之前把默认值改掉会让浏览器功能整体不可用。
 */
export type BrowserMode = 'launch' | 'attach'
export function browserMode(): BrowserMode {
  return String(process.env.BROWSER_MODE || '').toLowerCase() === 'attach' ? 'attach' : 'launch'
}
/** attach 模式的 CDP 端点（只监听本机；由 desktop 的 main.cjs 通过 env 传下来） */
export function attachEndpoint(): string {
  return String(process.env.SUPERCRZY_CDP_ENDPOINT || 'http://127.0.0.1:9333').replace(/\/+$/, '')
}

/**
 * 宿主 App 自己的 UI 的 origin（本地 serve 前端的那几个口）。
 *
 * ⚠️ 2026-09-23 收窄过一次排除粒度，别改回去 —— 原来这里是「命中 origin 即排除」，
 * 但 desktop 侧原生视图（`WebContentsView`）的起始页也只能落在同一个后端 origin 上
 * （`/browser-start.html`，见 `ai-browser-start-page.ts`）。
 * 按 origin 一刀切会把起始页自己也排掉 → attach 模式下**一个可接管页面都找不到**，
 * 症状是 `attachToRealPage` 抛「找不到可接管的真网页」，浏览器功能整体不可用。
 *
 * 现在的判据拆成两层：origin 命中 **且** path 是 SPA 入口，才算宿主 UI。
 */
function hostUiOrigins(): string[] {
  const port = process.env.PORT || '3000'
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    // dev 形态前端跑在 vite 上（detectDevFrontend 会选它）
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
}

/** SPA 入口路径。哈希路由（`/#/settings`）的 pathname 也是 `/`，所以同样被判定为宿主 UI。 */
const HOST_UI_PATHS = ['', '/', '/index.html']

/** 排障/测试用的显式排除项（前缀语义，给精确控制用，不要拿它当常规开关） */
function explicitExcludes(): string[] {
  return String(process.env.SUPERCRZY_CDP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** 拆 origin / pathname；非法 URL 返回 null（非法 URL 会走前面的 http(s) 判定被挡掉） */
function splitUrl(u: string): { origin: string; pathname: string } | null {
  try {
    const x = new URL(u)
    return { origin: x.origin, pathname: x.pathname }
  } catch {
    return null
  }
}

/**
 * 单个候选 URL 的可接管判定（纯函数，不碰 Playwright）。
 *
 * 抽成纯函数是刻意的：这套判据有四条规则，其中"空 URL 会卡住 CDC 30s"和
 * "宿主 UI 也是 http 地址"两条都是踩出来的、很反直觉的结论 ——
 * 必须能脱离浏览器被**单独断言**，否则每验证一次都要起 Electron，没人会去验。
 */
export function judgeUrl(u: string): { ok: boolean; why: string } {
  // ① 空 URL：宿主窗口建好但还没 loadURL 时会以 page target 出现。
  //    实测（2026-09-23）这种 target 的 Page.enable/Runtime.enable/Network.enable **一条都不回**，
  //    Playwright 的 connectOverCDP 会等它初始化到 30s 超时 —— 本函数的第一职责就是把它挡掉。
  if (!u) return { ok: false, why: '空 URL（未加载页面的窗口，会卡住 connectOverCDP）' }
  // ② 非 http(s)：启动占位页（data:text/html,…）、file: 的 client-dist 等
  if (!/^https?:\/\//i.test(u)) return { ok: false, why: `非 http(s)：${u.slice(0, 40)}` }
  // ③ 显式排除项（前缀语义）
  for (const e of explicitExcludes()) {
    if (u === e || u.startsWith(e + '/')) return { ok: false, why: `显式排除 SUPERCRZY_CDP_EXCLUDE：${e}` }
  }
  // ④ 宿主 App 自己的 UI：origin 命中 **且** 是 SPA 入口路径（收窄后的判据，见 hostUiOrigins 注释）
  const parts = splitUrl(u)
  if (parts && hostUiOrigins().includes(parts.origin) && HOST_UI_PATHS.includes(parts.pathname)) {
    return { ok: false, why: `宿主 UI（SPA 入口）：${u.slice(0, 60)}` }
  }
  // ⑤ 排障用精确指定（子串匹配）
  const match = String(process.env.SUPERCRZY_CDP_PAGE_MATCH || '').trim()
  if (match && !u.includes(match)) return { ok: false, why: `不匹配 SUPERCRZY_CDP_PAGE_MATCH="${match}"` }
  return { ok: true, why: 'ok' }
}

/**
 * attach 模式下原生视图的落点 URL。
 *
 * 用 `127.0.0.1` 而不是 `localhost` 是刻意的：**与宿主窗口的 origin 分开**，
 * 避免原生视图和 App 自己共享同一个 origin（同一个 origin 意味着共享 Service Worker /
 * localStorage / IndexedDB —— App 的页面在那边注册过 sw，没必要让 AI 浏览的内容也吃这套）。
 */
export function browserStartPageUrl(): string {
  return `http://127.0.0.1:${process.env.PORT || '3000'}${BROWSER_START_PAGE_PATH}`
}


/** 单个候选页面的可接管判定。返回原因字符串是为了让排障时不必猜。 */
function judgePage(p: Page): { ok: boolean; why: string } {
  if (p.isClosed()) return { ok: false, why: '已关闭' }
  return judgeUrl(p.url() || '')
}

/** 最近一次接管的决策过程（诊断用，经 /api/collab/browser/sessions 暴露） */
export interface AttachReport {
  mode: BrowserMode
  endpoint: string
  adopted: string
  candidates: string[]
  skipped: string[]
  at: number
}
let lastAttachReport: AttachReport | null = null
export function getAttachReport(): AttachReport | null { return lastAttachReport }

/** connectOverCDP 到 Electron，并在它的 target 列表里挑出"AI 浏览器的那一页" */
async function attachToRealPage(s: Session): Promise<Page> {
  if (!s.b || !s.b.isConnected()) {
    s.b = await chromium.connectOverCDP(attachEndpoint(), { timeout: 15000 })
  }
  const pages = s.b.contexts().flatMap((c) => c.pages())
  const judged = pages.map((p) => ({ p, v: judgePage(p) }))
  const picked = judged.find((j) => j.v.ok)
  lastAttachReport = {
    mode: 'attach',
    endpoint: attachEndpoint(),
    adopted: picked ? picked.p.url() : '',
    candidates: pages.map((p) => p.url() || '(空)'),
    skipped: judged.filter((j) => !j.v.ok).map((j) => `${j.p.url() || '(空)'} → ${j.v.why}`),
    at: Date.now(),
  }
  if (!picked) {
    const detail = lastAttachReport.candidates.join(' | ')
    throw new Error(
      `CDP 端点 ${attachEndpoint()} 上找不到可接管的真网页（看到 ${pages.length} 个 target：${detail}）。`
      + `常见原因：desktop 侧还没建原生视图，或视图停在 about:blank（它必须 loadURL ${browserStartPageUrl()} —— `
      + '只有真实 http(s) 页面才能被接管）；宿主窗口白屏（空 target 会让接管卡住）也会走到这里。'
      + `逐条排除原因见 GET /api/collab/browser/sessions 的 attach.skipped。`,
    )
  }
  return picked.p
}

/**
 * 解绑一个会话。
 * 🔴 attach 模式下**绝对不能调 `browser.close()`** —— 那个 browser 就是 Electron 本体，
 * 关掉它 = 关掉用户的主窗口。这里只丢引用，视图的生命周期归 desktop 侧管。
 */
async function releaseSession(s: Session) {
  if (browserMode() === 'attach') return
  try { await s.b?.close() } catch { /* 已断开也算释放 */ }
}


// ---- keyed browser sessions ----
interface Session { b: Browser | null; p: Page | null; last: BrowserSnapshot | null; waiters: Array<{ afterTs: number; resolve: (f: BrowserSnapshot | null) => void }>; idle: number }
const SESSIONS = new Map<string, Session>()
function sess(key: string): Session {
  const k = key || 'default'
  let s = SESSIONS.get(k)
  if (!s) { s = { b: null, p: null, last: null, waiters: [], idle: Date.now() }; SESSIONS.set(k, s) }
  return s
}
// ---- 闲置实例回收(兜底；正常路径由任务结束的显式清理负责, 2026-09-23) ----
// 会话实例(wb:<sid>) 10 分钟无动作即回收；`default` 只服务后台服务(video-transcript/content-factory)，
// 用更长阈值 30 分钟，避免它们在中途等 LLM 时被回收（旧代码直接 skip default = 永不回收，
// 实测残留一个无头 Chrome 34 分钟不退，就是这条 skip 造成的）。
const IDLE_MAX_MS = 10 * 60 * 1000
const IDLE_MAX_DEFAULT_MS = 30 * 60 * 1000
/**
 * 扫一遍闲置实例并回收，返回被回收的 key。
 * `now` 可注入 → 让验证脚本不必真等 10 分钟（见 scripts/diag/verify-ai-browser.ts）。
 */
function auditIdle(now = Date.now()): string[] {
  const victims: string[] = []
  for (const [k, s] of SESSIONS) {
    if (!s.b && !s.p) continue // 从未真正起浏览器的 key 无需动作
    const max = k === 'default' ? IDLE_MAX_DEFAULT_MS : IDLE_MAX_MS
    if (now - s.idle < max) continue
    victims.push(k)
    SESSIONS.delete(k) // 先同步摘除，避免下一轮重复选中
    // attach 模式下 releaseSession 只丢引用、不 close（那个 browser 就是 Electron 本体）
    void releaseSession(s)
  }
  return victims
}
/** 测试/诊断入口：按给定"当前时间"跑一次闲置回收 */
export function __auditIdleAt(nowMs: number): string[] { return auditIdle(nowMs) }
// unref：回收定时器不该拖住进程退出（否则 vitest / 优雅停机都要等它）
if (typeof setInterval === 'function') {
  const idleTimer = setInterval(() => { auditIdle() }, 90 * 1000)
  ;(idleTimer as unknown as { unref?: () => void })?.unref?.()
}
function notify(s: Session, f: BrowserSnapshot) {
  const ws = s.waiters; s.waiters = []
  ws.forEach((w) => { if ((f.ts || 0) > (w.afterTs || 0)) w.resolve(f); else s.waiters.push(w) })
}
async function getPage(s: Session): Promise<Page> {
  s.idle = Date.now()
  if (!s.p || s.p.isClosed()) {
    // attach：接管 Electron 窗口里那个真网页（不新建 context/page —— 就是在用它那一个）
    if (browserMode() === 'attach') {
      s.p = await attachToRealPage(s)
      return s.p
    }
    if (!s.b || !s.b.isConnected()) {
      const exe = detectBrowserPath()
      if (!exe) throw new Error('未找到可用 Chrome/Chromium 内核。安装或用 SUPERCRZY_CHROME 指定。')
      s.b = await chromium.launch({ executablePath: exe, headless: process.env.BROWSER_HEADFUL !== '1', args: ['--no-sandbox'] })
    }
    const ctx = await s.b.newContext({ viewport: { width: 1000, height: 700 } })
    s.p = await ctx.newPage()
  }
  return s.p
}
async function snap(s: Session, p: Page): Promise<BrowserSnapshot> {
  const shot = await p.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => Buffer.alloc(0))
  // 视口尺寸向页面本身要，别用 shot 的像素尺寸反推（retina 下会被放大 2 倍 → 点击坐标全偏）
  const vp = await p.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    .catch(() => null) as { width: number; height: number } | null
  const n: BrowserSnapshot = {
    url: p.url() || 'about:blank',
    title: (await p.title().catch(() => '')) || '',
    screenshot: shot.length ? shot.toString('base64') : '',
    ts: Date.now(),
    ...(vp && vp.width > 0 ? { viewport: vp } : {}),
  }
  s.last = n; notify(s, n)
  return n
}

// ---------- 每种动作默认走 'default'（兼容旧调用点，AI/browser单实例仍工作）----------
async function navigate(k: string, url: string) {
  const s = sess(k); const p = await getPage(s)
  const target = normalizeUrl(url)
  // 旧实现是 `.catch(() => {})` —— 导航失败（裸域名 / DNS 不通 / 证书错 / 超时）全被吞掉，
  // 用户只能看到白屏。改成把首个错误行带回去，由前端显示。
  let err = ''
  await p.goto(target, { timeout: 45000, waitUntil: 'commit' })
    .catch((e: any) => { err = String(e?.message || e).split('\n')[0].slice(0, 300) })
  await new Promise((r) => setTimeout(r, 600))
  const n = await snap(s, p)
  // 「没走成」有两种形态，都要报出来，否则用户只能看到无法解释的画面：
  //  ① 根本没导航 → about:blank（裸域名被吞掉的旧行为）
  //  ② Chrome 自己渲染了错误页 → chrome-error://chromewebdata/（DNS 不通 / 连接被拒；
  //     这种情况 goto 是"成功提交"的，不会进 catch，只有查 url 才发现）
  // 反例：有些站点先 200 再跳转，此时 url 已是正常地址，不能误判为失败。
  const stuck = !n.url || n.url === 'about:blank'
  const chromeErr = n.url.startsWith('chrome-error://')
  if (!err && chromeErr) err = '无法访问该地址（域名解析失败或连接被拒）'
  if (stuck || chromeErr) n.error = err || '导航失败'
  return n
}
async function shot(k: string) { const s = sess(k); return snap(s, await getPage(s)) }
async function refresh(k: string) { const s = sess(k); const p = await getPage(s); await p.reload({ timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {}); return snap(s, p) }
async function readText(k: string, maxChars = 20000) {
  const s = sess(k); const p = await getPage(s)
  const bodySrc = `var sels=['article','main','#content','.article-content','.post-content','.article','.content'];
    var t='',el,i,s; for(i=0;i<sels.length;i++){ el=document.querySelector(sels[i]); if(el){ s=(el.innerText||'').trim(); if(s.length>80){ t=s; break; } } }
    if(!t && document.body) t=(document.body.innerText||'').trim();
    return { text:t.slice(0,limit), title:document.title||'' };`
  const fn = new Function('limit', bodySrc) // eslint-disable-line no-new-func
  const info = await p.evaluate(fn as any, maxChars)
  return { url: p.url(), title: (info as any)?.title || '', text: (info as any)?.text || '' }
}
async function evalJS<A>(k: string, bodySrc: string, arg?: A): Promise<unknown> {
  const s = sess(k); const p = await getPage(s); const fn = new Function('arg', bodySrc) // eslint-disable-line no-new-func
  try { return await p.evaluate(fn as any, arg) } catch { return null }
}

// ---------- 动作层（per key） ----------
export interface BrowserActionResult { ok: boolean; url?: string; title?: string; error?: string }
async function clickAt(k: string, x: number, y: number): Promise<BrowserActionResult> { try { const s = sess(k); const p = await getPage(s); await p.mouse.click(x, y); return { ok: true, url: p.url(), title: (await p.title()) || '' } } catch (e: any) { return { ok: false, error: e.message } } }
async function clickText(k: string, text: string) {
  try {
    const s = sess(k); const p = await getPage(s)
    const loc = p.getByText(text, { exact: false }).first()
    const el = await loc.evaluate((n) => { let node = n as HTMLElement; for (let i = 0; node && i < 4; i++) { if (node.closest && node.closest('a,button,input,select,textarea,[role=button],[onclick]')) return { tag: (node.closest('a,button,input,select,textarea,[role=button],[onclick]') as HTMLElement).tagName }; node = node.parentElement as HTMLElement } return null }).catch(() => null)
    if (el) { await loc.click(); return { ok: true, url: p.url(), title: (await p.title()) || '' } }
    const box = await loc.boundingBox(); if (box) { await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); return { ok: true } }
    return { ok: false, error: `未能定位可点元素: "${text}"` }
  } catch (e: any) { return { ok: false, error: e.message } }
}
async function typeText(k: string, text: string, into?: string) {
  try { const s = sess(k); const p = await getPage(s)
    if (into) { const l = p.getByPlaceholder(into).first(); if (await l.count()) { await l.fill(text); return { ok: true } } const r = p.getByRole('textbox', { name: into }).first(); if (await r.count()) { await r.fill(text); return { ok: true } } }
    await p.keyboard.press('Escape'); await p.keyboard.type(text); return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
}
async function pressKey(k: string, keyName: string) { try { const s = sess(k); const pp = await getPage(s); await pp.keyboard.press(keyName); return { ok: true } } catch (e: any) { return { ok: false, error: e.message } } }
async function scroll(k: string, dy: number) { try { const s = sess(k); const p = await getPage(s); await p.mouse.wheel(0, dy); return { ok: true } } catch (e: any) { return { ok: false, error: e.message } } }
async function back(k: string) { try { const s = sess(k); const p = await getPage(s); if (p.url().startsWith('http')) await p.goBack({ timeout: 15000 }).catch(() => {}); return { ok: true, url: p.url() } } catch (e: any) { return { ok: false, error: e.message } } }
async function listInteractive(k: string): Promise<string[]> {
  try { const s = sess(k); const p = await getPage(s)
    const fn = new Function(`var se=[];var qs='button,a,input[type=text],input[type=search],input:not([type]),textarea,select,[role=button],[role=link]';var n=document.querySelectorAll(qs);for(var i=0;i<n.length&&se.length<40;i++){var el=n[i];if(!el.offsetParent)continue;var tag=el.tagName.toLowerCase();var t=(el.innerText||el.value||el.getAttribute('placeholder')||el.getAttribute('aria-label')||'').trim().slice(0,30);if(!t)continue;var r=el.getBoundingClientRect();se.push(tag+' | '+(el.tagName.toLowerCase()==='a'?el.href:el.value||'')+' | '+t+' | '+Math.round(r.x)+','+Math.round(r.y));}return se;`) // eslint-disable-line
    return ((await p.evaluate(fn as any)) || []) as string[]
  } catch { return [] }
}
function lastOf(k: string) { return sess(k).last }
function waitLatest(k: string, afterTs: number, timeoutMs = 15000): Promise<BrowserSnapshot | null> {
  const s = sess(k); const cur = s.last
  if (cur && (cur.ts || 0) > afterTs) return Promise.resolve(cur)
  return new Promise((res) => { const rec = { afterTs, resolve: res as (f: BrowserSnapshot | null) => void }; s.waiters.push(rec); setTimeout(() => { const i = s.waiters.indexOf(rec); if (i >= 0) { s.waiters.splice(i, 1); res(s.last) } }, timeoutMs) })
}
async function closeKey(k: string) {
  const s = SESSIONS.get(k)
  if (s) { await releaseSession(s); SESSIONS.delete(k) }
}

/**
 * 任务结束清理（2026-09-23 老板要求"每次任务结束后自动清理"）。
 * 一个会话跑完就把它的浏览器实例连同临时 profile 一起释放 ——
 * 之前只在闲置 10 分钟后兜底回收，且 default 桶根本不回收，任务跑完 Chrome 会一直挂着。
 * 幂等：key 不存在时静默返回。
 */
export async function closeBrowserForSession(sessionId?: string | null) {
  await closeKey(browserKey(sessionId))
}
/** 释放全部实例（进程退出/重置用），返回被释放的 key 列表 */
export async function closeAllBrowsers(): Promise<string[]> {
  const keys = [...SESSIONS.keys()]
  await Promise.all(keys.map((k) => closeKey(k)))
  return keys
}
/** 诊断用：当前持有实例的 key 列表（GET /api/collab/browser/sessions 暴露） */
export function activeBrowserKeys(): string[] { return [...SESSIONS.keys()] }

/**
 * 诊断用：每个活会话**此刻**正在操作哪一页。
 *
 * 为什么必须有（不是锦上添花）：`getAttachReport().adopted` 记的是**上一次采纳决策**的结果，
 * 而 `getPage()` 会缓存已采纳的 `Page` —— 视图（或 AI）导航到新页面后，同一份 webContents
 * 继续被操作，但报告里的 adopted **不会更新**。
 * 于是 /browser/sessions 会出现"报告说 AI 在 A、实际 AI 在 B 上读写正常"这种**会说谎的诊断**，
 * 排障时能把人带偏一整轮（2026-09-23 端到端验证实测到过）。
 * 两者含义不同，就都摊开：`adopted` = 最后一次采纳决策，`pages` = 实时所在页面。
 */
export function browserSessionPages(): Array<{ key: string; url: string }> {
  return [...SESSIONS.entries()].map(([key, s]) => {
    let url = ''
    try { url = s.p && !s.p.isClosed() ? s.p.url() : '' } catch { url = '' }
    return { key, url }
  })
}

// ================= 旧默认导出（行为= default 实例; 兼容历史消费者） =================
export async function browserNavigate(url: string) { return navigate('default', url) }
export async function browserRefresh() { return refresh('default') }
export async function browserScreenshot() { return shot('default') }
export async function browserReadText(maxChars = 20000) { return readText('default', maxChars) }
export async function browserEvalJS<A>(bodySrc: string, arg?: A) { return evalJS<A>('default', bodySrc, arg) }
export async function browserClickAt(x: number, y: number) { return clickAt('default', x, y) }
export async function browserClickText(text: string) { return clickText('default', text) }
export async function browserTypeText(text: string, into?: string) { return typeText('default', text, into) }
export async function browserPressKey(keyName: string) { return pressKey("default", keyName) }
export async function browserScroll(dy: number) { return scroll('default', dy) }
export async function browserBack() { return back('default') }
export async function browserListInteractive() { return listInteractive('default') }
export function getLastBrowserFrame() { return lastOf('default') }
export function resetLastBrowserFrame() { SESSIONS.delete('default') }
export function waitForBrowserFrame(afterTs: number, timeoutMs = 15000) { return waitLatest('default', afterTs, timeoutMs) }
export async function closeBrowser() { await closeKey('default') }

// ---- 多会话 API：给网页各会话(user/collab/sessionId) 用 per-instance 隔离 ----
export interface BrowserSessionHandle {
  navigate(u: string): Promise<BrowserSnapshot>
  screenshot(): Promise<BrowserSnapshot>
  refresh(): Promise<BrowserSnapshot>
  read(maxChars?: number): Promise<{ url: string; title: string; text: string }>
  evalJS<A>(src: string, arg?: A): Promise<unknown>
  clickAt(x: number, y: number): Promise<BrowserActionResult>
  clickText(t: string): Promise<any>
  typeText(t: string, into?: string): Promise<any>
  press(keyName: string): Promise<any>
  goBack(): Promise<any>
  wheel(dy: number): Promise<any>
  interactive(): Promise<string[]>
  lastFrame(): BrowserSnapshot | null
  waitAfter(afterTs: number): Promise<BrowserSnapshot | null>
  close(): Promise<void>
}
export type { BrowserSessionHandle as BrowserService }

export function browserSession(key: string): BrowserSessionHandle {
  const k = key || 'default'
  return {
    navigate: (u) => navigate(k, u),
    screenshot: () => shot(k),
    refresh: () => refresh(k),
    read: (m) => readText(k, m),
    evalJS: (src, arg) => evalJS(k, src, arg),
    clickAt: (x, y) => clickAt(k, x, y),
    clickText: (t) => clickText(k, t),
    typeText: (t, into) => typeText(k, t, into),
    press: (n) => pressKey(k, n),
    goBack: () => back(k),
    wheel: (dy) => scroll(k, dy),
    interactive: () => listInteractive(k),
    lastFrame: () => lastOf(k),
    waitAfter: (at) => waitLatest(k, at),
    close: () => closeKey(k),
  }
}
