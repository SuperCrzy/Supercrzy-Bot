/**
 * AI 浏览器 attach 模式 — 接管判据与「绝不关掉 Electron」（2026-09-23）
 *
 * 为什么单开一个文件：本文件要 mock `playwright-core`，与 ai-browser.test.ts 的纯逻辑
 * 回归隔离，避免 mock 污染那 10 项。
 *
 * 这里锁的四件事，共同点是**症状极难从现象反推原因**：
 *  ① 空 URL 的 target 会让 connectOverCDP **卡 30 秒**（今天实测：那个 session 的
 *     Page.enable/Runtime.enable 一条 RECV 都没有）
 *  ② 宿主 UI 窗口是 http 地址 → 判据写成"只认 http(s)"就会把 App 自己的界面接管掉
 *  ③ 宿主排除**不能按 origin 一刀切**：原生视图的起始页与宿主 UI 同 origin（都在后端口上），
 *     按 origin 排除会把起始页也排掉 → attach 一个可接管页面都没有，而现象只是"找不到页面"
 *  ④ 🔴 attach 模式下 `browser.close()` 关的是 **Electron 本体** —— 用户主窗口直接消失。
 *     这条一旦回归，只有装机形态才会暴露，而那时损失最大。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const browserClose = vi.fn(async () => {})
  let pages: unknown[] = []
  const browser = {
    isConnected: () => true,
    contexts: () => [{ pages: () => pages }],
    newContext: async () => ({ newPage: async () => pages[0] }),
    close: browserClose,
  }
  return {
    browserClose,
    browser,
    setPages: (p: unknown[]) => { pages = p },
    launch: vi.fn(async () => browser),
    connectOverCDP: vi.fn(async () => browser),
  }
})

vi.mock('playwright-core', () => ({
  chromium: {
    launch: mocks.launch,
    connectOverCDP: mocks.connectOverCDP,
    executablePath: () => '',
  },
}))

const { browserSession, browserKey, browserMode, attachEndpoint, judgeUrl, closeAllBrowsers, browserStartPageUrl } =
  await import('./ai-browser')

const ENV_KEYS = ['BROWSER_MODE', 'PORT', 'SUPERCRZY_CDP_ENDPOINT', 'SUPERCRZY_CDP_EXCLUDE',
  'SUPERCRZY_CDP_PAGE_MATCH', 'SUPERCRZY_CHROME']
let saved: Record<string, string | undefined> = {}

/** 最小可用假页面：只需要截图链路用到的几个方法 */
const mkPage = (url: string) => ({
  url: () => url,
  isClosed: () => false,
  title: async () => 'title:' + url,
  screenshot: async () => Buffer.alloc(2000),
  evaluate: async () => ({ width: 1280, height: 720 }),
})

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(async () => {
  await closeAllBrowsers()
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  vi.clearAllMocks()
})

describe('attach 接管判据（judgeUrl）— 三条反直觉的排除', () => {
  it('空 URL 必须被挡掉（否则 connectOverCDP 会卡满 30s）', () => {
    expect(judgeUrl('').ok).toBe(false)
    expect(judgeUrl('').why).toContain('空 URL')
  })

  it('宿主 UI 的 SPA 入口必须被挡掉（生产里它就是 http，不是 data:）', () => {
    process.env.PORT = '3011'
    expect(judgeUrl('http://127.0.0.1:3011/').ok).toBe(false)
    expect(judgeUrl('http://localhost:3011/#/chat').ok).toBe(false)
    // 无尾斜杠 / 显式 index.html 也是同一个入口
    expect(judgeUrl('http://127.0.0.1:3011').ok).toBe(false)
    expect(judgeUrl('http://127.0.0.1:3011/index.html').ok).toBe(false)
    // dev 前端（vite 5173）同样要挡
    expect(judgeUrl('http://127.0.0.1:5173/').ok).toBe(false)
  })

  it('🔴 同 origin 但非 SPA 入口的页面**必须可接管**（否则起始页会被自己排掉，attach 整体报废）', () => {
    process.env.PORT = '3011'
    expect(judgeUrl('http://127.0.0.1:3011/browser-start.html').ok).toBe(true)
  })

  it('不变量：browserStartPageUrl() 必须自身可接管，且宿主入口同时被排除', () => {
    // 这两条必须**同时**成立 —— 只满足一条都意味着 attach 不可用
    process.env.PORT = '3011'
    const sp = browserStartPageUrl()
    expect(sp).toBe('http://127.0.0.1:3011/browser-start.html')
    expect(judgeUrl(sp).ok, `起始页不可接管：${sp}`).toBe(true)
    expect(judgeUrl('http://127.0.0.1:3011/').ok).toBe(false)
  })

  it('非 http(s) 一律不接管（启动占位页 / file: 的 client-dist）', () => {
    for (const u of ['data:text/html,x', 'about:blank', 'file:///a/index.html']) {
      expect(judgeUrl(u).ok, u).toBe(false)
    }
  })

  it('普通 http(s) 才接管', () => {
    expect(judgeUrl('http://127.0.0.1:5599/').ok).toBe(true)
    expect(judgeUrl('https://www.baidu.com/').ok).toBe(true)
  })

  it('SUPERCRZY_CDP_PAGE_MATCH 可精确定位（排障用）', () => {
    process.env.SUPERCRZY_CDP_PAGE_MATCH = 'example.com'
    expect(judgeUrl('http://other.test/').ok).toBe(false)
    expect(judgeUrl('http://example.com/a').ok).toBe(true)
  })
})

describe('模式默认值 — 默认必须是 launch', () => {
  it('未设置 / 非法值都落到 launch（attach 依赖 desktop 先开 CDP 端口，改默认会让浏览器整体不可用）', () => {
    expect(browserMode()).toBe('launch')
    process.env.BROWSER_MODE = 'attach'
    expect(browserMode()).toBe('attach')
    process.env.BROWSER_MODE = 'ATTACH'
    expect(browserMode()).toBe('attach')
    process.env.BROWSER_MODE = 'weird'
    expect(browserMode()).toBe('launch')
  })

  it('attachEndpoint 去掉尾部斜杠（避免拼出 //devtools）', () => {
    process.env.SUPERCRZY_CDP_ENDPOINT = 'http://127.0.0.1:9333///'
    expect(attachEndpoint()).toBe('http://127.0.0.1:9333')
  })
})

describe('端到端接管路径（假 browser 注入）', () => {
  it('在多个 target 中挑中"视图里的真网页"，并带回视口尺寸', async () => {
    process.env.BROWSER_MODE = 'attach'
    process.env.PORT = '3011'
    mocks.setPages([
      mkPage(''),                            // 宿主窗口尚未加载 → 必须跳过（会卡 30s）
      mkPage('http://127.0.0.1:3011/'),      // 宿主 UI → 必须跳过
      mkPage('http://127.0.0.1:5599/'),      // 真网页 → 应当被接管
    ])
    const snap = await browserSession(browserKey('t-adopt')).screenshot()
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(1)
    expect(snap.url).toBe('http://127.0.0.1:5599/')
    // 视口必须随帧带回：前端要按它换算点击坐标（旧代码硬编码 1000×700，attach 后必然点偏）
    expect(snap.viewport).toEqual({ width: 1280, height: 720 })
  })

  it('📌 生产形态：宿主窗口(空) + 宿主 SPA + 原生视图起始页 → 接管起始页', async () => {
    // 这是 desktop 接线后 CDP target 列表的**真实顺序与真实内容**：
    //   1) 宿主 BrowserWindow 尚未 loadURL → 空 URL
    //   2) 宿主窗口加载 App UI      → SPA 入口，必须跳过
    //   3) WebContentsView 起始页   → 必须接管（这就是"AI 浏览器的那一页"）
    process.env.BROWSER_MODE = 'attach'
    process.env.PORT = '3011'
    mocks.setPages([
      mkPage(''),
      mkPage('http://localhost:3011/'),
      mkPage(browserStartPageUrl()),
    ])
    const snap = await browserSession(browserKey('t-prod-shape')).screenshot()
    expect(snap.url).toBe(browserStartPageUrl())
  })

  it('没有可接管页面时给出可排障的错误（带上候选清单）', async () => {
    process.env.BROWSER_MODE = 'attach'
    mocks.setPages([mkPage(''), mkPage('about:blank')])
    await expect(browserSession(browserKey('t-none')).screenshot()).rejects.toThrow(/找不到可接管的真网页/)
  })

  it('🔴 attach 模式下 close() 绝不能关闭 browser（那就是 Electron 本体）', async () => {
    process.env.BROWSER_MODE = 'attach'
    mocks.setPages([mkPage('http://x.test/')])
    const h = browserSession(browserKey('t-close-attach'))
    await h.screenshot()
    await h.close()
    expect(mocks.browserClose).not.toHaveBeenCalled()
  })

  it('launch 模式下 close() 必须真的关（否则会退化成"永不回收"的老 bug）', async () => {
    process.env.SUPERCRZY_CHROME = '/bin/ls' // detectBrowserPath 要求路径真实存在
    mocks.setPages([mkPage('about:blank')])
    const h = browserSession(browserKey('t-close-launch'))
    await h.screenshot()
    await h.close()
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.browserClose).toHaveBeenCalledTimes(1)
  })
})
