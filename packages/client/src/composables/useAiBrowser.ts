/**
 * AI 浏览器的全部客户端状态与传输层（2026-09-24 从 DetailPanel.vue 抽离）。
 *
 * ## 为什么抽出来
 *
 * 抽离前这段逻辑（原 716–1046，331 行）和 DetailPanel 的"文件树 / 产物 / diff / 预览"混在
 * 同一个 setup 作用域里 —— 于是 DetailPanel 涨到 1403 行、撞上体量闸门（上限 1180）红灯。
 * 两者**零共享状态**，只是碰巧住在一起。AI 浏览器是独立子系统，就该有自己的边界。
 *
 * ## 边界怎么划
 *
 * 本模块**不碰任何 store**：会话 id 与"现在要不要跑"都由调用方以 getter 传进来。
 * 这样它可以在单测里被驱动，也让 ChatView / DetailPanel 谁挂载它都不需要改这里。
 *
 * ## 两条模式（互斥，由后端 `mode` + 桌面桥共同决定）
 *
 * - **截图流**（默认）：后端自己起 headless Chrome，每帧变 base64 JPEG 回来，前端贴 `<img>`。
 *   人在这个 `<img>` 上点/滚，前端把归一化坐标乘**页面视口**再回抛给后端。
 * - **原生视图**：桌面形态 + 后端 `attach`，画面是主进程的一层 `WebContentsView`（真网页本体），
 *   盖在 `.browser-canvas` 的位置上。人用真键盘鼠标操作，AI 那侧天生同步（同一份 DOM）。
 *
 * ## 三个必须记住的坑（都是修过的 bug，别改回去）
 *
 * 1. **坐标不能用 `img.naturalWidth` 换算**：retina 下截图被放大 2 倍，用它算坐标会整体偏一倍。
 *    必须用后端随帧带回的 `viewport`（见 `ai-browser.ts` 的 `BrowserSnapshot.viewport`）。
 * 2. **原生视图的矩形只能"量出来报上去"**：它不在 DOM 里，尺寸完全等于我们交给主进程的矩形。
 *    面板收起/宽度动画中间态会给出 1px 级矩形 → 必须丢掉（`< 24`），否则视图被摆成一条缝。
 * 3. **首次 `show` 才带 `url`**：之后每次 `show` 都带会把页面顶回起始页。
 *    另外 `hide()` 用隐藏而非销毁 —— 视图里可能已导航到某页，销毁等于把 AI 正在看的页丢掉。
 */

import { ref, nextTick, watch, onMounted, onUnmounted } from 'vue'

export interface AiBrowserOptions {
  /** 当前会话 id。切会话要释放上一个会话的浏览器实例。无会话时可能为 null / undefined。 */
  sessionId: () => string | null | undefined
  /** 是否"该跑"：面板可见 **且** 当前停在浏览器 tab。只在 true 时点火长轮询与原生视图同步。 */
  active: () => boolean
}

export function useAiBrowser(opts: AiBrowserOptions) {
  const browserStatus = ref('待机')
  const browserFailHint = ref('')
  const browserUrl = ref('')
  const browserUrlInput = ref('')
  const browserScreenshotBase64 = ref('')
  const browserLoading = ref(false)
  const browserLog = ref<string[]>([])

  // 页面视口的 CSS 尺寸，由后端随每帧带回（见 ai-browser.ts 的 BrowserSnapshot.viewport 注释）。
  // 旧代码硬编码 1000×700 —— 那是 launch 模式写死的 viewport；attach 后视图尺寸随窗口变，
  // 且 retina 下截图会被放大 2 倍，用图片尺寸反推坐标必然点偏。
  const browserViewport = ref({ width: 1000, height: 700 })
  function applyViewport(v?: { width?: number; height?: number } | null) {
    if (v && v.width && v.height) browserViewport.value = { width: v.width, height: v.height }
  }

  // 人工操作用的输入
  const browserTypeText = ref('')
  const browserClickText = ref('')

  // ---- 原生视图模式 ----
  // 触发条件是**两个**同时成立：后端 `mode === 'attach'`（它在接管 Electron 的页面）
  // 且桌面桥存在（纯 Web 形态没有 WebContentsView，必须继续走截图流）。
  //
  // 为什么高度要做成固定比例：原生视图不在 DOM 里，它的尺寸完全等于"我们量出来交给主进程的矩形"。
  // 没有 <img> 撑着时 `.browser-canvas` 会塌成 min-height，视图就只有一条缝 —— 所以给一个
  // aspect-ratio 让它自己长高。注意这条**只影响好不好看，不影响对不对齐**：无论 CSS 怎么算，
  // 原生视图都精确盖在量出来的那个矩形上。
  const browserNative = ref(false)
  const browserNativeReady = ref(false)
  const browserStartPageUrl = ref('')
  const browserCanvasEl = ref<HTMLElement | null>(null)
  const desktopBridge = () => (window as { supercrzyDesktop?: { browserView?: any } }).supercrzyDesktop?.browserView
  let nativeRaf = 0
  let nativeShown = false
  let nativeUrlTimer: ReturnType<typeof setInterval> | null = null
  let lastSentRect = ''

  /** 量矩形 → 上报。原生层不在 DOM 里，位置尺寸只能这么同步。 */
  function syncNativeBounds() {
    const bridge = desktopBridge()
    const el = browserCanvasEl.value
    if (!bridge || !el) return
    const r = el.getBoundingClientRect()
    // 面板收起/宽度动画中间态会给出一像素级矩形 —— 上报它会把视图摆成一条缝，
    // 而且动画结束前每帧都在变、白白刷 IPC。等矩形稳定下来再说。
    if (r.width < 24 || r.height < 24) return
    const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (key === lastSentRect) return
    lastSentRect = key
    if (!nativeShown) {
      nativeShown = true
      // 首次 show 才带起始页地址：之后每次 show 都带会把页面顶回起始页（见 browser-view-wiring.cjs）
      bridge.show({ bounds: rect, url: browserStartPageUrl.value }).then((st: { attached?: boolean; error?: string }) => {
        browserNativeReady.value = !!st?.attached
        if (st?.error) browserFailHint.value = String(st.error)
      }).catch((e: unknown) => {
        browserNativeReady.value = false
        browserFailHint.value = '原生视图不可用：' + ((e as Error)?.message || String(e))
      })
    } else {
      bridge.bounds(rect)
    }
  }

  function startNativeSync() {
    if (nativeRaf) return
    const tick = () => { syncNativeBounds(); nativeRaf = requestAnimationFrame(tick) }
    nativeRaf = requestAnimationFrame(tick)
    // 地址栏信息来自原生视图（截图流在原生模式下不跑了，不补这个会一直停在旧地址）
    if (!nativeUrlTimer) {
      nativeUrlTimer = setInterval(() => {
        const bridge = desktopBridge()
        if (!bridge) return
        bridge.state().then((st: { url?: string }) => { if (st?.url) browserUrl.value = st.url }).catch(() => { /* 视图不在 */ })
      }, 1000)
    }
  }

  function stopNativeSync() {
    if (nativeRaf) cancelAnimationFrame(nativeRaf)
    nativeRaf = 0
    if (nativeUrlTimer) { clearInterval(nativeUrlTimer); nativeUrlTimer = null }
    lastSentRect = ''
    const bridge = desktopBridge()
    const wasShown = nativeShown
    nativeShown = false
    browserNativeReady.value = false
    // 只隐藏、不销毁：原生视图里可能已经导航到某页，销毁等于把 AI 正在看的页面丢掉
    if (bridge && wasShown) bridge.hide().catch(() => { /* 窗口在关 */ })
  }

  /** 探测该走哪条路（后端 mode + 有没有桌面桥）。后端没起时静默，保持截图流的原状。 */
  async function detectBrowserMode() {
    try {
      const r = await fetch('/api/collab/browser/sessions')
      if (!r.ok) return
      const d = await r.json() as { mode?: string; startPageUrl?: string }
      const on = d?.mode === 'attach' && !!desktopBridge()
      if (on !== browserNative.value) browserLog.value.push(on ? '原生视图模式（与 AI 共用同一个页面）' : '截图模式')
      browserNative.value = on
      if (on) {
        browserStartPageUrl.value = d.startPageUrl || ''
        browserStatus.value = '原生视图 · 人机共用'
        browserScreenshotBase64.value = ''  // 清掉旧截图：否则会在原生视图出现前的缝隙里闪一下
        if (opts.active()) startNativeSync()
      } else {
        stopNativeSync()
      }
    } catch { /* 静默 */ }
  }

  function bkHdr(extra?: Record<string, string>) {
    const e = extra || {}
    try { const sid = opts.sessionId(); if (sid) e['X-Browser-Key'] = sid } catch { /* ignore */ }
    return e
  }

  async function goToUrl() {
    const url = browserUrlInput.value.trim()
    if (!url) return
    browserLoading.value = true
    browserStatus.value = '导航中'
    browserLog.value.push('导航 ' + url)
    try {
      const r = await fetch('/api/collab/browser/navigate', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bkHdr()), body: JSON.stringify({ url }),
      })
      if (r.ok) {
        const d = await r.json()
        applyViewport(d.viewport)
        if (d.error) {
          // 后端把导航失败的原因带回来了 —— 旧实现是静默吞掉，用户只能看到白屏，
          // 连"是不是网址写错了"都判断不了（2026-09-23 修）。
          browserUrl.value = d.url && d.url !== 'about:blank' ? d.url : url
          browserScreenshotBase64.value = d.screenshot || ''
          browserStatus.value = '失败'
          browserFailHint.value = '打不开这个地址：' + d.error
          browserLog.value.push('失败 ' + d.error)
        } else {
          browserUrl.value = d.url || url
          browserUrlInput.value = d.url || url
          browserScreenshotBase64.value = d.screenshot || ''
          browserStatus.value = '实时'
          browserFailHint.value = ''
        }
      } else { browserStatus.value = '失败'; browserFailHint.value = '后端返回错误 ' + r.status + '，无法打开网页' }
    } catch {
      browserStatus.value = '断开'
      browserFailHint.value = '未能连到浏览器服务(后端 3000)。请先启动后端再打开网页'
    }
    browserLoading.value = false
    // 自动滑动到最新
    await nextTick()
  }

  async function refreshPage() {
    browserLoading.value = true
    browserStatus.value = '刷新中'
    try {
      const r = await fetch('/api/collab/browser/refresh', { method: 'POST', headers: bkHdr() })
      if (r.ok) {
        const d = await r.json()
        browserUrl.value = d.url || browserUrl.value
        browserScreenshotBase64.value = d.screenshot || ''
        applyViewport(d.viewport)
        browserStatus.value = '实时'
      } else { browserStatus.value = '失败' }
    } catch { browserStatus.value = '断开' }
    browserLoading.value = false
  }

  async function doAct(body: Record<string, unknown>) {
    browserLoading.value = true
    try {
      const r = await fetch('/api/collab/browser/act', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bkHdr()), body: JSON.stringify(body) })
      if (r.ok) {
        const d = await r.json()
        if (d?.snapshot?.screenshot) { browserScreenshotBase64.value = d.snapshot.screenshot; browserUrl.value = d.snapshot.url || browserUrl.value }
        applyViewport(d?.snapshot?.viewport)
        // 返回成败：调用方要据此给用户反馈。
        // 旧实现不返回任何东西 → 调用方只能猜，很容易写出"恒真的失败提示"（那是假信号）。
        if (d?.result?.error) {
          browserStatus.value = '动作失败'
          browserFailHint.value = String(d.result.error).slice(0, 200)
          browserLoading.value = false
          return false
        }
        browserFailHint.value = ''
        browserLoading.value = false
        return true
      }
      browserStatus.value = '失败'
      browserLoading.value = false
      return false
    } catch { browserStatus.value = '断开'; browserLoading.value = false; return false }
  }

  // AI 浏览器 L2：点画面 = 替 AI 浏览器点击（真网页化后同一个人机操作面）
  const browserClickMode = ref<'auto' | 'off'>('auto')

  async function clickPage(e: MouseEvent) {
    const t = e.target as HTMLElement
    const img = t.closest('img')
    if (!img) return
    const r = img.getBoundingClientRect()
    if (!r.width || !r.height) return
    // 归一化到 0..1，再乘**页面自己的视口尺寸**。
    // 不要用 img.naturalWidth 参与换算：retina 下截图被放大 2 倍（naturalWidth = CSS 宽 × 2），
    // 用它算出来的坐标会整体偏移一倍。旧代码还额外乘了硬编码的 1000，attach 后视图尺寸可变，必然点偏。
    const vp = browserViewport.value
    const x = Math.round(((e.clientX - r.left) / r.width) * vp.width)
    const y = Math.round(((e.clientY - r.top) / r.height) * vp.height)
    await doAct({ action: 'click_at', x, y })
    browserLog.value.push(`点击 ${x},${y}`)
  }
  async function browserGoBack() { await doAct({ action: 'back' }); browserLog.value.push('后退') }

  // ---- 人工操作：打字 / 按键 / 滚动 / 按文字点击（2026-09-23 补齐）----
  // 后端这 4 个动作早就实现了（routes/collab.ts 的 /browser/act），前端一直没接 →
  // 人在右栏只能点、不能打字、不能滚动，"自己接管一下"根本做不到。
  async function doType(withEnter: boolean) {
    const text = browserTypeText.value
    if (!text) return
    const ok = await doAct({ action: 'type', text })
    const ok2 = withEnter ? await doAct({ action: 'key', key: 'Enter' }) : true
    const label = text.length > 18 ? text.slice(0, 18) + '…' : text
    browserLog.value.push(ok && ok2 ? `输入「${label}」${withEnter ? ' + 回车' : ''}` : `输入「${label}」失败`)
    // 只在成功时清空：失败时保留内容，让人能直接重试（清除等于让人重打一遍）
    if (ok && ok2) browserTypeText.value = ''
  }
  async function doKey(key: string) {
    await doAct({ action: 'key', key })
    browserLog.value.push(`按键 ${key}`)
  }
  async function doClickText() {
    const text = browserClickText.value.trim()
    if (!text) return
    await doAct({ action: 'click_text', text })
    browserLog.value.push(`按文字点击「${text}」`)
    browserClickText.value = ''
  }

  // 画面上滚轮 → 页面滚动。节流 220ms：滚一下会连发几十个 wheel 事件，
  // 不节流会把后端打满（每次都要截图回帧）。
  let wheelAt = 0
  async function onCanvasWheel(e: WheelEvent) {
    e.preventDefault()
    const now = Date.now()
    if (now - wheelAt < 220) return
    wheelAt = now
    const dy = Math.max(-1200, Math.min(1200, Math.round(e.deltaY)))
    if (!dy) return
    await doAct({ action: 'scroll', deltaY: dy })
  }

  // labelKey/titleKey 交给组件用 t() 渲染；label 只放语言无关的键位符号
  const keyButtons: Array<{ key: string; label: string; titleKey: string }> = [
    { key: 'Enter', label: '', titleKey: 'aiBrowser.keyEnterTitle' },
    { key: 'Escape', label: 'Esc', titleKey: 'aiBrowser.keyEscTitle' },
    { key: 'Tab', label: 'Tab', titleKey: 'aiBrowser.keyTabTitle' },
    { key: 'ArrowUp', label: '\u2191', titleKey: 'aiBrowser.keyUp' },
    { key: 'ArrowDown', label: '\u2193', titleKey: 'aiBrowser.keyDown' },
    { key: 'ArrowLeft', label: '\u2190', titleKey: 'aiBrowser.keyLeft' },
    { key: 'ArrowRight', label: '\u2192', titleKey: 'aiBrowser.keyRight' },
  ]

  let lastFrameTs = 0
  let liveStop = false
  let livePolling = false
  // 画面实时(2026-09-04 长轮询): 服务端在 /browser/latest?after= 上较帧缓存至有新帧或~12s，
  // 前端只在 AI/人手动作产生新帧时收到 → 立即同步贴画面；无变化不空转(无周期轮询)
  async function pollLiveFrame() {
    if (!opts.active() || liveStop || livePolling) return
    // 原生视图模式下整条截图流都不跑：画面由原生视图给，
    // 再每帧搬一张 base64 JPEG 纯属白烧带宽与 CPU。
    // （这个 return 在 try 之外，所以不会经 finally 再点火 → 不会变成空转自旋）
    if (browserNative.value) return
    livePolling = true
    try {
      const r = await fetch(`/api/collab/browser/latest?after=${lastFrameTs}`, { headers: bkHdr() })
      if (!r.ok) return
      const f = await r.json()
      if (f?.ts) {
        const changed = f.ts !== lastFrameTs
        lastFrameTs = f.ts
        if (changed && f.screenshot) { browserScreenshotBase64.value = f.screenshot; if (f.url) browserUrl.value = f.url; applyViewport(f.viewport) }
      } else if (lastFrameTs !== 0) {
        // ts=0 = 服务端该会话已无实例（任务结束自动清理 / 手动关闭）
        // → 清掉冻结的旧图，否则用户看不出浏览器已经被释放了
        lastFrameTs = 0
        browserScreenshotBase64.value = ''
        browserUrl.value = ''
        browserStatus.value = '已释放'
      }
    } catch { /* 静默 */ }
    finally {
      livePolling = false
      if (opts.active() && !liveStop) pollLiveFrame()
    }
  }

  // 点火时机（2026-09-23 修复）：此前只在 onMounted 调一次 pollLiveFrame，
  // 而那一刻 activeTab 还是默认的 deliverables → 守卫直接 return，且无人再点火
  // → 长轮询从来没跑过（实测切到浏览器 tab 后零个 /browser/latest 请求），
  // 表现为"AI 操作时右栏画面不动"。改为在「面板可见 × 当前是浏览器 tab」两个条件变化时点火/停火。
  watch(
    () => opts.active(),
    (on) => {
      if (on) {
        // 先问后端"这台机器走哪条路"（原生视图 / 截图流），再决定点火哪一套
        void detectBrowserMode()
        liveStop = false; lastFrameTs = 0; void pollLiveFrame()
      } else {
        liveStop = true
        // 原生视图是**盖在 App 界面之上**的一层，离开浏览器 tab 必须收起，
        // 否则它会一直挡住下面的界面（而且挡的还是别人 tab 的位置）。
        stopNativeSync()
      }
    },
  )

  // 切走会话时释放上一个会话的浏览器实例（服务端任务结束时也会清；这里兜住"任务早已结束但用户还停在浏览器 tab"）
  watch(
    () => { try { return opts.sessionId() } catch { return '' } },
    async (sid, prev) => {
      if (!prev || prev === sid) return
      try {
        await fetch('/api/collab/browser/close', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, { 'X-Browser-Key': String(prev) }),
          body: '{}',
        })
      } catch { /* 静默：清理失败不影响使用 */ }
      lastFrameTs = 0; browserScreenshotBase64.value = ''; browserUrl.value = ''; browserStatus.value = '待机'
    },
  )

  onMounted(() => { lastFrameTs = 0; liveStop = false; void detectBrowserMode(); void pollLiveFrame() })
  onUnmounted(() => { liveStop = true; stopNativeSync() })

  return {
    // 状态
    browserStatus, browserFailHint, browserUrl, browserUrlInput,
    browserScreenshotBase64, browserLoading, browserLog, browserViewport,
    browserTypeText, browserClickText, browserClickMode,
    browserNative, browserNativeReady, browserCanvasEl,
    // 动作
    goToUrl, refreshPage, browserGoBack, clickPage, onCanvasWheel,
    doType, doKey, doClickText, doAct, detectBrowserMode,
    startNativeSync, stopNativeSync, syncNativeBounds,
    // 常量
    keyButtons,
  }
}
