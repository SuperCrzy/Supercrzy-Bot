/**
 * AI 浏览器（超级协作平台 P3，2026-09-01 实接）
 * 基于 playwright-core + 系统 Google Chrome（无需下载 Chromium）。
 * 受控单例：AI 执行时通过 navigate/screenshot 打开网页并截图，
 * 截图 base64 经 collab 任务/WS 推给前端 DetailPanel browser tab 实时显示。
 */
import { chromium, type Browser, type Page } from 'playwright-core'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let browser: Browser | null = null
let page: Page | null = null

async function getPage(): Promise<Page> {
  if (!page || page.isClosed()) {
    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox'] })
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
