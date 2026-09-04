/**
 * AI 浏览器（多会话浏览器池版 2026-09-04）
 * 目标(A 方向/老板核准): 真浏览器多实例隔离, 供网页各 end-user / 会话各自实例, 不再全局抢一个。
 * playwright-core + 系统 Chrome。每 key(如 collab session / user) 一实例; 默认 `default` 兼容旧调用。
 * 提供的画面帧/长轮询均 per-key, 各自 waitLatest 收到自己会话的新帧。
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { existsSync } from 'fs'

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

export interface BrowserSnapshot { url: string; title: string; screenshot: string; ts: number }

// ---- keyed browser sessions ----
interface Session { b: Browser | null; p: Page | null; last: BrowserSnapshot | null; waiters: Array<{ afterTs: number; resolve: (f: BrowserSnapshot | null) => void }>; idle: number }
const SESSIONS = new Map<string, Session>()
function sess(key: string): Session {
  const k = key || 'default'
  let s = SESSIONS.get(k)
  if (!s) { s = { b: null, p: null, last: null, waiters: [], idle: Date.now() }; SESSIONS.set(k, s) }
  return s
}
// ---- 闲置实例回收(防每会话 Chrome 常驻吃内存, 2026-09-04) ----
// 仅回收非 default(&非刚创建) 且 idle>IDLE_MAX_ms 的会话；default 保留兼容调用；每 90s 扫一次。
const IDLE_MAX_MS = 10 * 60 * 1000
function auditIdle() {
  for (const [k, s] of SESSIONS) {
    if (k === 'default') continue
    if (!s.b && !s.p) continue // 从未真正起浏览器的 key 无需动作
    if (Date.now() - s.idle < IDLE_MAX_MS) continue
    void (async () => { try { await s.b?.close() } catch {} SESSIONS.delete(k) })()
  }
}
if (typeof setInterval === 'function') setInterval(auditIdle, 90 * 1000)
function notify(s: Session, f: BrowserSnapshot) {
  const ws = s.waiters; s.waiters = []
  ws.forEach((w) => { if ((f.ts || 0) > (w.afterTs || 0)) w.resolve(f); else s.waiters.push(w) })
}
async function getPage(s: Session): Promise<Page> {
  s.idle = Date.now()
  if (!s.p || s.p.isClosed()) {
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
  const n: BrowserSnapshot = { url: p.url() || 'about:blank', title: (await p.title().catch(() => '')) || '', screenshot: shot.length ? shot.toString('base64') : '', ts: Date.now() }
  s.last = n; notify(s, n)
  return n
}

// ---------- 每种动作默认走 'default'（兼容旧调用点，AI/browser单实例仍工作）----------
async function navigate(k: string, url: string) { const s = sess(k); const p = await getPage(s); await p.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {}); return snap(s, p) }
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
async function closeKey(k: string) { const s = SESSIONS.get(k); if (s) { try { await s.b?.close() } catch {} SESSIONS.delete(k) } }

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
