/**
 * AI 浏览器（超级协作平台 P3，2026-09-01 实接）
 * 基于 playwright-core + 系统 Google Chrome（无需下载 Chromium）。
 * 受控单例：AI 执行时通过 navigate/screenshot 打开网页并截图，
 * 截图 base64 经 collab 任务/WS 推给前端 DetailPanel browser tab 实时显示。
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { existsSync } from 'fs'

/**
 * 自动探测可用的浏览器内核（2026-09-03）：别再写死单个 mac 路径，
 * 让 mac/Windows 上"装了任意 Chromium 系或没装系统 Chrome"都能跑。优先级：
 *   ① 环境变量 SUPERCRZY_CHROME / CHROME_PATH（显式指定最强）
 *   ② playwright-core 自带的 Chromium（executablePath 已含内核时）
 *   ③ 系统 Chrome/Chromium 系各家常见安装路径（mac + win + linux）
 */
export function detectBrowserPath(): string {
  for (const env of ['SUPERCRZY_CHROME', 'CHROME_PATH']) {
    const v = process.env[env]
    if (v && existsSync(v)) return v
  }
  // playwright-core 自带内核（若安装过），比依赖系统 Chrome 更稳
  try {
    const ep = chromium.executablePath()
    if (ep && existsSync(ep)) return ep
  } catch { /* ignore, 走系统候选 */ }
  const isWin = process.platform === 'win32'
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates: string[] = []
  if (isWin) {
    for (const p of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
      const base = process.env[p]
      if (!base) continue
      candidates.push(
        `${base}\\Google\\Chrome\\Application\\chrome.exe`,
        `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${base}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    )
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return ''
}

let browser: Browser | null = null
let page: Page | null = null

async function getPage(): Promise<Page> {
  if (!page || page.isClosed()) {
    if (!browser || !browser.isConnected()) {
      const exe = detectBrowserPath()
      if (!exe) throw new Error('未找到可用的 Chrome/Chromium 浏览器内核。请安装 Chrome 或 Chromium，或用环境变量 SUPERCRZY_CHROME 指定浏览器路径。')
      browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] })
    }
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } })
    page = await ctx.newPage()
  }
  return page
}

export interface BrowserSnapshot {
  url: string
  title: string
  screenshot: string   // base64 JPEG
  ts: number
}

/** 打开 URL，返回标题 + 截图 */
export async function browserNavigate(url: string): Promise<BrowserSnapshot> {
  const p = await getPage()
  await p.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {})
  return snapshot(p)
}

/** 刷新当前页并截图 */
export async function browserRefresh(): Promise<BrowserSnapshot> {
  const p = await getPage()
  await p.reload({ timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {})
  return snapshot(p)
}

/** 返回当前页截图（不导航） */
export async function browserScreenshot(): Promise<BrowserSnapshot> {
  return snapshot(await getPage())
}

/** 读取当前页可读文本（内容工厂抓正文用）：优先正文容器，回退 body innerText，截前 maxChars */
export async function browserReadText(maxChars = 20000): Promise<{ url: string; title: string; text: string }> {
  const p = await getPage()
  // 传源码字符串经 new Function 构造纯函数，避免传会被 tsx 用浏览器缺失的 __name 包装的函数
  const bodySrc = `var sels=['article','main','#content','.article-content','.post-content','.article','.content'];
    var t='',el,i,s;
    for(i=0;i<sels.length;i++){ el=document.querySelector(sels[i]); if(el){ s=(el.innerText||'').trim(); if(s.length>80){ t=s; break; } } }
    if(!t && document.body) t=(document.body.innerText||'').trim();
    return { text:t.slice(0,limit), title:document.title||'' };`
  const fn = new Function('limit', bodySrc) // eslint-disable-line no-new-func
  const info = await p.evaluate(fn as any, maxChars)
  return { url: p.url(), title: (info as any)?.title || '', text: (info as any)?.text || '' }
}

/** 在当前已开页面执行一段 JS（arg 为参数）。返回 JSON 化结果或 null。
 *  用源码串 new Function，规避 tsx __name 包装在浏览器缺失的坑。 */
export async function browserEvalJS<A>(bodySrc: string, arg?: A): Promise<unknown> {
  const p = await getPage()
  const fn = new Function('arg', bodySrc) // eslint-disable-line no-new-func
  try { return await p.evaluate(fn as any, arg) } catch { return null }
}

async function snapshot(p: Page): Promise<BrowserSnapshot> {
  const shot = await p.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => Buffer.alloc(0))
  return {
    url: p.url() || 'about:blank',
    title: (await p.title().catch(() => '')) || '',
    screenshot: shot.length ? shot.toString('base64') : '',
    ts: Date.now(),
  }
}

/** 关闭浏览器实例 */
export async function closeBrowser(): Promise<void> {
  try { await browser?.close() } catch { /* ignore */ }
  browser = null
  page = null
}
