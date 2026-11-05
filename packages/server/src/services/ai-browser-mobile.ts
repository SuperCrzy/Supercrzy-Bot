/**
 * AI 浏览器 · DOM 模式（手机）。
 *
 * ## 为什么要有这条路
 *
 * 桌面那条路是「后端自己的 headless Chrome / 接管 Electron 里那个 WebContentsView」，
 * 两种都靠**截图**把画面搬给侧栏。搬到手机上就变成结构性故障：
 *
 *   · 手机上能接管的只有系统 Chrome，而聊天的那些时间里它永远在后台；
 *   · Android 会冻结后台 renderer ⇒ `page.screenshot()` 不是失败、是**超时**
 *     （真机实测：后台 8016ms / 0 字节，前台 1966ms / 890,526 字节）；
 *   · 截图超时被 `.catch(() => Buffer.alloc(0))` 吞成空帧 ⇒ 侧栏收到 `screenshot: ''`，
 *     于是永远是一个空画布，连"出错了"都看不见。
 *
 * 结论不是"修好截图"，而是**这台设备根本不该截图**：手机屏幕上同时摆「聊天」和
 * 「浏览器画面」放不下，与其挣扎着搬像素，不如把页面结构化之后放进侧栏。
 *
 * ## 这条路的实现
 *
 * 引擎是 App 内的一个 1×1 WebView（`BrowserHost.kt`，系统 WebView = 0MB 额外体积），
 * 通过 `data/device/req|resp` 文件通道收发命令。它只做三件事：
 * navigate → snapshot（正文 + 可点元素，元素带稳定序号） → click/type by index。
 *
 * ## 三个必须记住的点
 *
 * 1. **人和 AI 是同一个实例**。模块级的 `last` 缓存被侧栏长轮询与 `mobile_browser`
 *    工具共用 —— AI 动了，侧栏下一次 long-poll 立刻看到；反之亦然。不是两个浏览器。
 * 2. **不做坐标点击**。像素模式那套 `clickAt(x,y)` 在这里没有意义（没有像素）。
 *    走 `clickIndex(i)`，序号由后端注入的 `data-sc-idx` 决定，滚动/布局变化都不会错位。
 * 3. **导航要等到 ready**。`browser_navigate` 只是 `loadUrl`，立刻回 ack；
 *    不轮询就快照会拿到旧页面（或 about:blank），侧栏闪一下白再回来。
 */
import { callDevice, deviceBridgeReady } from './device-bridge'
import {
  normalizeUrl,
  type BrowserActionResult,
  type BrowserDomBlock,
  type BrowserDomElement,
  type BrowserSessionHandle,
  type BrowserSnapshot,
} from './ai-browser'

interface DeviceDomPayload {
  ok?: boolean
  url?: string
  title?: string
  ready?: string
  text?: string
  elements?: BrowserDomElement[]
  blocks?: BrowserDomBlock[]
  data?: unknown
  error?: string
}

/**
 * 是不是「这台设备上应该走 DOM 模式」。
 *
 * 两个条件都要成立：**没有桌面浏览器内核**（有内核就走原来的像素路，桌面行为
 * 一个字都不变）+ **App 的命令通道在**（否则会对着空气等 15 秒超时）。
 */
export function mobileBrowserAvailable(): boolean {
  return deviceBridgeReady()
}

/** 最近一帧（模块级，故意跨会话共用：手机上只有一个 WebView） */
let last: BrowserSnapshot | null = null

/** 最近一次点击/输入命中的元素序号，给「仅输入」按键用 */
let lastIndex = -1

export function mobileLastFrame(): BrowserSnapshot | null {
  return last
}

function toSnapshot(p: DeviceDomPayload, fallbackUrl = ''): BrowserSnapshot {
  const elements = Array.isArray(p.elements) ? p.elements : []
  const snap: BrowserSnapshot = {
    url: p.url || fallbackUrl || 'about:blank',
    title: p.title || '',
    // DOM 模式永远没有像素。前端据此切渲染器（见 AiBrowserPanel.vue）。
    screenshot: '',
    ts: Date.now(),
    dom: {
      ready: p.ready || '',
      text: String(p.text || ''),
      elements,
      blocks: Array.isArray(p.blocks) ? p.blocks : [],
    },
  }
  last = snap
  return snap
}

async function deviceSnapshot(): Promise<BrowserSnapshot> {
  const r = await callDevice('browser_snapshot', {}, 15000)
  return toSnapshot((r.data || {}) as DeviceDomPayload)
}

/**
 * 等页面进入可用状态再快照。
 *
 * `readyState === 'complete'` 是最省事的稳妥判据；拿不到（老 WebView / JS 被拦）就
 * 退成「有没有元素」，再不行就按时间兜底 —— 绝不能因为一次 `ready` 判据不合就
 * 卡满 12 秒，那会让侧栏看起来"点了没反应"。
 */
async function waitReady(deadlineMs = 12000): Promise<BrowserSnapshot> {
  const deadline = Date.now() + deadlineMs
  let snap = await deviceSnapshot()
  while (Date.now() < deadline) {
    const ready = snap.dom?.ready || ''
    const hasContent = (snap.dom?.elements.length || 0) > 0 || (snap.dom?.text.length || 0) > 0
    if (ready === 'complete' || ready === 'interactive') return snap
    if (ready === '' && hasContent) return snap
    await new Promise((r) => setTimeout(r, 350))
    snap = await deviceSnapshot()
  }
  return snap
}

async function navigate(rawUrl: string, force = false): Promise<BrowserSnapshot> {
  const target = normalizeUrl(rawUrl)
  // 同一个地址就别重载（重载会丢表单/滚动位置，人正在读的页会跳回顶部）。
  // `force` 是刷新用的：刷新本来就该重载，别被这条去重吃掉。
  if (!force && last?.url && last.url === target) {
    return waitReady()
  }
  await callDevice('browser_navigate', { url: target }, 20000)
  return waitReady()
}

async function clickIndex(i: number): Promise<BrowserActionResult> {
  try {
    await callDevice('browser_click', { index: i }, 15000)
    lastIndex = i
    const snap = await deviceSnapshot()
    return { ok: true, url: snap.url, title: snap.title }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function typeInto(i: number, text: string): Promise<BrowserActionResult> {
  try {
    await callDevice('browser_type', { index: i, text }, 15000)
    const snap = await deviceSnapshot()
    return { ok: true, url: snap.url, title: snap.title }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function pressKey(keyName: string): Promise<BrowserActionResult> {
  try {
    // 手机上能可靠做的只有「后退」：Enter/Tab 这些页面级按键在 WebView 里
    // 没有等价的原生注入，硬做只能伪造 DOM 事件 —— 那对 React 站点是假动作。
    if (keyName === 'Escape') {
      await callDevice('browser_back', {}, 10000)
    }
    const snap = await deviceSnapshot()
    return { ok: true, url: snap.url, title: snap.title }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function clickText(text: string): Promise<BrowserActionResult> {
  const needle = String(text || '').trim()
  if (!needle) return { ok: false, error: 'text required' }
  const snap = await deviceSnapshot()
  const els = snap.dom?.elements || []
  const hit =
    els.find((e) => e.text === needle && !e.disabled) ||
    els.find((e) => e.text.includes(needle) && !e.disabled)
  if (!hit) return { ok: false, error: `no clickable element labelled "${needle}"` }
  return clickIndex(hit.i)
}

async function goBack(): Promise<BrowserActionResult> {
  try {
    await callDevice('browser_back', {}, 10000)
    const snap = await waitReady(6000)
    return { ok: true, url: snap.url, title: snap.title }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 长轮询：有新帧立刻回，没有就等。
 *
 * 只读模块缓存、**不碰设备** —— 每条 `waitAfter` 都去 WebView 跑一遍快照 JS 的话，
 * 侧栏挂在那里就是每秒一次 DOM 全量遍历，纯属拿电池换空转。
 */
function waitAfter(afterTs: number, timeoutMs = 15000): Promise<BrowserSnapshot | null> {
  if (last && last.ts > afterTs) return Promise.resolve(last)
  return new Promise((res) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (last && last.ts > afterTs) return res(last)
      if (Date.now() >= deadline) return res(last)
      setTimeout(tick, 250)
    }
    tick()
  })
}

/** DOM 模式暴露给侧栏/AI 的会话句柄（结构上与像素模式一致，缺的方法逐个给明确错误） */
export function mobileBrowserSession(): BrowserSessionHandle {
  return {
    navigate: (u) => navigate(u),
    screenshot: () => deviceSnapshot(),
    refresh: () => (last?.url ? navigate(last.url, true) : deviceSnapshot()),
    read: async (maxChars = 20000) => {
      const snap = await deviceSnapshot()
      return { url: snap.url, title: snap.title, text: (snap.dom?.text || '').slice(0, maxChars) }
    },
    evalJS: async () => {
      // DOM 模式不开放任意 JS：真正的注入面在 App 侧，后端拿不到。
      return null
    },
    clickAt: async () => ({
      ok: false,
      error: 'no coordinate clicks in DOM mode — use the element index (click_idx)',
    }),
    clickIndex: (i) => clickIndex(i),
    typeInto: (i, t) => typeInto(i, t),
    clickText: (t) => clickText(t),
    typeText: async (t: string, into?: string) => {
      // `into` 在这里是"占位符文字"（像素模式的语义），DOM 模式按元素序号更准；
      // 没给序号就退回上一次点过的元素 —— 这正是人在侧栏"先点输入框、再打字"的自然顺序。
      if (typeof into === 'string' && into) {
        const snap = await deviceSnapshot()
        const hit = (snap.dom?.elements || []).find((e) => e.text.includes(into))
        if (hit) return typeInto(hit.i, t)
      }
      if (lastIndex < 0) {
        return { ok: false, error: 'pick a field first — tap it in the panel, or pass its index' }
      }
      return typeInto(lastIndex, t)
    },
    press: (k) => pressKey(k),
    goBack: () => goBack(),
    wheel: async () => ({ ok: true }),
    interactive: async () => {
      const snap = last || (await deviceSnapshot())
      return (snap.dom?.elements || []).map(
        (e) => `${e.tag} | ${e.href || ''} | ${e.text} | ${(e.rect || []).join(',')}`,
      )
    },
    lastFrame: () => last,
    waitAfter: (at) => waitAfter(at),
    close: async () => {
      // 不销毁 WebView：App 侧只有一个实例，销毁等于把 AI 正在看的页丢掉。
      // 只清"最后一次帧"，让侧栏下一次拿到干净状态。
      last = null
      lastIndex = -1
    },
  }
}

/** 给 `mobile_browser` 工具用：一次调用 = 一个动作 + 最新快照 */
export async function mobileBrowserCall(
  action: string,
  args: Record<string, unknown>,
): Promise<BrowserSnapshot> {
  const s = mobileBrowserSession()
  const text = String(args.text ?? '')
  switch (action) {
    case 'open':
      return s.navigate(String(args.url || ''))
    case 'back':
      await s.goBack()
      return (last as BrowserSnapshot) || (await s.screenshot())
    case 'click':
      await s.clickIndex?.(Number(args.index))
      return (last as BrowserSnapshot) || (await s.screenshot())
    case 'type':
      await s.typeInto?.(Number(args.index), text)
      return (last as BrowserSnapshot) || (await s.screenshot())
    case 'click_text':
      await s.clickText(text)
      return (last as BrowserSnapshot) || (await s.screenshot())
    case 'snapshot':
    default:
      return s.screenshot()
  }
}
