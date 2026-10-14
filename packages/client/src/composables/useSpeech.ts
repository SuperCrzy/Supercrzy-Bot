/**
 * useSpeech — AI 回复朗读（Pro: Edge TTS 神经网络音色 / Lite: 系统 TTS 兜底）。
 *
 * 双通道（2026-09-28 修订）：
 *  - **Pro**：后端 `/api/tts` 走 Edge TTS（微软神经网络，接近真人）。
 *    前端把文本**打包**（`packForTts`，一条正常回复通常只打成 1 包）→ 请求拿 mp3
 *    → `<audio>` 顺序播放，边播边预取下一包。
 *    ⚠️ 早先是"按句/按段逐句请求"，实测那是断档的根源：合成耗时由握手主导、
 *    几乎不随长度变（1900 字一次请求 4.3s 出 414s 音频），逐句切等于把固定成本
 *    付 N 次，且每包之间各等一次合成 → 听感"读完一段停几秒"。
 *    ⚠️ 服务端注释里写的"国内直连可达"**不成立**：2026-09-28 实测 `speech.platform.bing.com`
 *    的 wss 握手在本机网络约 3/4 次数被 RST。所以后端加了退避重试，前端这里加了冷却。
 *  - **Lite（兜底）**：浏览器原生 speechSynthesis。Pro 冷却期内/请求失败时回落，保证任何环境都能读。
 *
 * 通用约束：
 *  - 全局单例：同一时刻只读一条消息，读新的自动停旧的（防串音）
 *  - 三态：idle → speaking → paused（点按钮循环：朗读 → 暂停 → 继续）
 *  - **降级必须可见**：Pro 失败不只是"少一段音频"，听感会从神经音色变成系统拼接音色，
 *    所以暴露 `proDegraded` 让 UI 说明"正在用系统音色"，而不是让用户以为音色坏了
 *
 * 两条入口（2026-09-28）：
 *  - **整条**：`speak(id, text)` —— 文本已完整，交给 packForTts 尽量只发 1 次请求
 *  - **流式**：`beginStream(id)` → `appendStreamText(块)` × N → `endStream()`
 *    —— 文本还在生成就开始读（攒批逻辑在 utils/speech-text.ts 的 takeStreamChunk）
 */
import { ref, onBeforeUnmount } from 'vue'
import { packForTts } from '@/utils/speech-text'

export interface UseSpeechOptions {
  /** 音色（Pro 档）：返回 Edge TTS voice id，缺省用后端默认（晓晓） */
  voice?: () => string | undefined
  /** 语速（Pro 档）：返回 Edge TTS rate 串（'default' | '+20%' | '-10%'），缺省 default */
  rate?: () => string | undefined
}

/**
 * Pro 一次失败后的冷却时长（ms）。到期自动重试 Pro —— 这是"不永久回落"的落点。
 * 取 60s：够长到不把上游抖动期间的每一句都拖成"请求 → 等退避 → 再失败"，
 * 又够短到用户下一次朗读大概率已经恢复。
 */
export const PRO_COOLDOWN_MS = 60_000

/**
 * Lite 档音色优选顺序（名字子串匹配）。
 *
 * 2026-09-28 重排：原来首项是 `Tingting/婷婷`，而 macOS 上「婷婷」是**拼接式**老音色，
 * 听感最机械 —— 等于我们主动挑了最差的那个。实测本机 Chrome 暴露 18 个中文音色，
 * 其中 `Shelley / Sandy / Flo / Eddy / Reed / Rocko` 是 macOS 新代 Siri 神经音色，
 * 原来的优选表**一个都没列**。现在按「神经音色 → Google → 其它 → 拼接式老音色」排。
 */
const LITE_VOICE_PREFER = [
  // ① macOS 新代 Siri 神经音色（女性在前，跟默认的晓晓保持一致）
  'Shelley', 'Sandy', 'Flo',
  'Eddy', 'Reed', 'Rocko',
  // ② Google 系（装了才有）
  'Google 普通话', 'Google 國語',
  // ③ 其它常见中文音色
  'Meijia', '美嘉', 'Sinji', 'Li-mu', 'Yu-shu', 'Yaoyao', 'Xiaoxiao', '晓晓', 'Yunxi', 'Yunyang',
  // ④ 最后才是拼接式老音色：只在上面全都没有时才用
  'Tingting', '婷婷',
] as const

export function useSpeech(options: UseSpeechOptions = {}) {
  const nativeSupported =
    typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
  /** 只要有后端就可能走 Pro；native 不支持时仍可朗读 */
  const supported = ref(
    typeof window !== 'undefined' &&
      (nativeSupported || typeof fetch === 'function'),
  )

  const speakingId = ref<string | null>(null)
  const paused = ref(false)

  // ---- Pro 档内部状态 ----
  /**
   * Pro 冷却截止时间戳（ms）。
   *
   * 2026-09-28 改：原实现是「一次失败即 `proDisabled = true`，**本会话永久**失效」。
   * 后果是上游只要抖一下（实测 `speech.platform.bing.com` 握手约 3/4 次数被 RST），
   * 整个会话就固定用系统 TTS 朗读，听感机械，而且**没有任何提示** ——
   * 用户只会觉得"音色怎么这么机械"，不会想到"朗读降级了"。
   * 现在改成**有时限的冷却**：冷却期内直走 Lite，到期自动重试 Pro。
   */
  let proCooldownUntil = 0
  /** 是否正处于「Pro 不可用、已回落系统音色」的降级态；给 UI 提示用（ref 才有响应性） */
  const proDegraded = ref(false)
  /**
   * 是否正处于「已经发起播放、但还一声没出」的窗口。
   *
   * 2026-09-28 加。这段窗口原来**对用户完全不可见**：朗读条立刻显示"正在朗读"、
   * 按钮立刻变成"暂停朗读"，而声音要 3~19s 才来 —— 用户以为坏了就去重复点击，
   * 第二次点击又被 `toggle` 判成"暂停"（见 pause() 注释）⇒ 直接静默。
   * UI 现在据它显示"正在合成语音"并禁用暂停按钮，把这段等待变成有反馈的等待。
   */
  const synthesizing = ref(false)

  let queue: string[] = []
  let queueIndex = 0
  let currentAudio: HTMLAudioElement | null = null
  let currentUrl: string | null = null
  /**
   * 预取槽：记 **在途 promise**（而不是"等拿到 URL 才记"）。
   *
   * 2026-09-28 修：原来只在 `.then` 里写 `prefetch = {index, url}`，于是在途期间槽还是空的
   * ⇒ 当前包恰好在预取返回前播完时，`playProIndex` 会以为"没有预取"而**把同一个包再请求一次**。
   * 上游本来就是瓶颈，重复请求会让下一包更晚就绪（实测抓到一个包两次请求）。
   *
   * 同日起 `promise` 解析出的是**流式播放 URL**（不再是 blob URL）—— 预取内容从
   * "整段音频"变成"一张 6ms 的票据"，见 `ensurePrefetch`。
   */
  type PrefetchSlot = { index: number; promise: Promise<string>; used: boolean }
  let prefetch: PrefetchSlot | null = null
  let generation = 0 // 防竞态：每次 speak/stop 自增，异步回来时比对
  /**
   * 播放循环是否存活（正在播放 / 正在取音频）。
   *
   * 2026-09-28 为流式朗读引入：流式下队列会「播空但文本还在生成」，
   * 此时**不能**当成"整条读完"收尾，得留着等下一块。仅靠 `queue[queueIndex]` 取不到
   * 无法区分这两种状态（都是"空"），必须显式记一个标志。
   */
  let proBusy = false
  /** 流式模式：队列可追加，队列空时**不收尾**（等 appendStreamText 续上） */
  let streamMode = false
  /**
   * 当前这一块已经因为「一声没出」重试过几次。
   *
   * 2026-09-28 为 `<audio>` 直连流式 URL 引入。改造前"上游坏了"是在 `fetch` 阶段被捕获的，
   * 改造后音频绕开了前端 —— 请求变成换票（几乎不失败），**真正的失败只能在 `<audio>` 的
   * error 事件里看到**。而 error 事件拿不到 HTTP 状态码（MediaError 只有 code），
   * "票据过期（410，可自愈）"与"上游故障（502，该进冷却）"长得一模一样，
   * 所以这张唯一的宽容额度给票据类失败：换张新票重播同一块，还不成就当真的坏。
   */
  let blockRetries = 0

  // ---- Lite 档内部状态 ----
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null

  /** 丢掉预取槽。预取物只是"票据"，丢掉不占任何资源，无需释放 */
  function dropPrefetch() {
    prefetch = null
  }

  /**
   * 确保第 index 包已被预取 —— **预取的是"票据"，不是音频**。
   *
   * 2026-09-28 改。原来这里会把整段音频先下成 blob 再播（一条 5501 字回复切 3 包 ≈ 10MB），
   * 而播放其实只需要一个 URL，音频交给 `<audio>` 自己流式拉。预取于是退化成"提前换票"：
   * 一次 ~6ms 的 POST，换来"切到下一包时零等待"。
   *
   * 为什么不把下一包的 `<audio>` 提前建好：那等于把整包音频提前拉完（内存 + 上游并发合成），
   * 而**首声由上游首块决定（实测 335~602ms），提前拉并不会让声音更早出来**，只是多占资源。
   */
  function ensurePrefetch(index: number) {
    if (!queue[index]) return
    if (prefetch && prefetch.index === index) return
    dropPrefetch()
    const slot: PrefetchSlot = { index, promise: fetchTtsTicket(queue[index]), used: false }
    slot.promise.catch(() => { /* 预取失败无所谓，用到时现换票 */ })
    prefetch = slot
  }

  function clearKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
  }

  function resetPro() {
    queue = []
    queueIndex = 0
    proBusy = false
    streamMode = false
    synthesizing.value = false
    blockRetries = 0
    if (currentAudio) {
      currentAudio.onended = null
      currentAudio.onerror = null
      currentAudio.onplaying = null
      currentAudio.pause()
      // 🔴 流式 URL 必须**清掉 src** 才算真断开：`pause()` 只停播放，下载会继续把整段拉完
      //（等于上游白合成一整段、我们白占内存）。blob URL 时代没有这一步，所以容易被漏掉。
      try { currentAudio.removeAttribute('src'); currentAudio.load() } catch { /* 已经断开 */ }
      currentAudio = null
    }
    currentUrl = null
    dropPrefetch()
  }

  function finish(id: string) {
    if (speakingId.value !== id) return
    speakingId.value = null
    paused.value = false
    clearKeepAlive()
    resetPro()
  }

  // ===== Pro（Edge TTS）=====

  /**
   * 换一次性朗读票据（POST，只登记文本、不开始合成），返回 token。
   *
   * 2026-09-28 起 Pro 档的前置步骤：`<audio>` **无法携带自定义请求头**，所以不能把文本
   * 直接塞给它；文本先换成高熵短效 token，播放器再拿 token 去 GET `/api/tts/stream`。
   * 失败抛错 —— 调用方据此回落 Lite 或标记降级。
   */
  async function fetchTtsTicket(text: string): Promise<string> {
    const res = await fetch('/api/tts/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: options.voice?.(), rate: options.rate?.() }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        if (j?.error) msg = String(j.error)
      } catch { /* 非 JSON 错误体 */ }
      throw new Error(msg)
    }
    const token = String((await res.json())?.token || '')
    if (!token) throw new Error('未取到朗读票据')
    return token
  }

  /** 票据 → 流式播放 URL。音频由 `<audio>` 自己边收边播，前端不再中转 blob */
  function streamUrlFor(token: string): string {
    return `/api/tts/stream?t=${encodeURIComponent(token)}`
  }

  function playProIndex(id: string, gen: number) {
    const text = queue[queueIndex]
    if (speakingId.value !== id || gen !== generation) return
    if (!text) {
      proBusy = false
      // 流式：队列只是**暂时**空了（文本还在生成）→ 停车等 appendStreamText 续上，
      // 绝不能 finish —— 否则第一块播完就宣告"读完"，后面生成的正文再也读不到。
      if (streamMode) return
      finish(id)
      return
    }
    proBusy = true

    // 用预取的票据（若正好是这一包），否则现换 —— 两者都只是 ~6ms 的 POST，音频交给 <audio> 去流
    let urlPromise: Promise<string>
    if (prefetch && prefetch.index === queueIndex) {
      prefetch.used = true
      urlPromise = prefetch.promise
      prefetch = null
    } else {
      // 槽里是别的包（或空）→ 直接现换票，别把可能已落地的预取丢掉（稍后按新位置校正）
      urlPromise = fetchTtsTicket(text).then(streamUrlFor)
    }

    urlPromise
      .then((url) => {
        if (speakingId.value !== id || gen !== generation) return
        currentUrl = url
        const audio = new Audio(url)
        currentAudio = audio
        // 这一块**是否真的出过声**。`onerror` 能不能重试完全由它决定：
        // 出过声再重播就是叠音，一声没出才可能是票据失效这类可自愈的失败。
        let everPlayed = false
        // **真的出声**才算合成结束 —— 在此之前 UI 显示"正在合成语音"、暂停按钮不可用。
        // 这也是"点了朗读要等几秒"这段窗口唯一的可见信号。
        audio.onplaying = () => {
          if (speakingId.value !== id || gen !== generation) return
          everPlayed = true
          synthesizing.value = false
          // 能出声 = 上游是通的（冷却到期后的重试走到这里）→ 撤下降级提示。
          // 放在这里而不是"换票成功"时：换票只是本地一次 POST，**不能**证明上游通了；
          // 上游仍然挂着时票据照样能换到，那样提示会先消失再回来。
          proDegraded.value = false
        }
        audio.onended = () => {
          if (speakingId.value !== id || gen !== generation) return
          currentUrl = null
          currentAudio = null
          queueIndex += 1
          blockRetries = 0
          playProIndex(id, gen)
        }
        audio.onerror = () => {
          if (speakingId.value !== id || gen !== generation) return
          currentUrl = null
          currentAudio = null
          synthesizing.value = false
          // 一声没出 ⇒ 首块之前就断了，这个窗口里唯一**可自愈**的原因是票据失效
          // （TTL 60s / 最多 5 次；用户在合成期长按暂停再恢复最容易撞上）。
          // ⚠️ 严格限定"一声没出 + 只重试过一次"：出过声再重播是叠音，无限重试是死循环。
          if (!everPlayed && blockRetries < 1) {
            blockRetries += 1
            synthesizing.value = true
            playProIndex(id, gen) // queueIndex 不动 ⇒ 重播的就是同一块
            return
          }
          failPro(id, gen)
        }
        if (paused.value) {
          // 跨块延续的"暂停"：音频已就绪但不播。这里也要清掉合成态，
          // 否则会永远卡在"正在合成语音"（onplaying 不会触发）。
          synthesizing.value = false
          audio.pause()
        } else {
          audio.play().catch(() => { /* 自动播放被拦：等用户再点 */ })
        }

        // 预取下一块的票据（提升连贯性）。ensurePrefetch 记的是"在途 promise"，
        // 所以下一块播完时若预取仍在途，也不会把同一块再换一次票。
        ensurePrefetch(queueIndex + 1)
      })
      .catch(() => failPro(id, gen))
  }

  /**
   * 本轮 Pro 朗读失败（两条入口共用：换票失败的 `.catch`、`<audio>` 的 error 事件）。
   *
   * 三件事：① 进冷却（**有时限**，不再永久封死）② 亮降级提示 ③ 按模式决定怎么收场。
   *
   * ⚠️ 非流式回落 Lite 读的是 `queue.slice(queueIndex)` —— **包含当前这一块**。
   * 于是"播到一半断流"时，这一块已听过的部分会被重念一遍。这是刻意选的：
   * 宁可重复，也不能静默丢掉这一块的尾巴（跳过会把"没听到的内容"变成不可见的数据丢失）。
   */
  function failPro(id: string, gen: number) {
    if (speakingId.value !== id || gen !== generation) return
    proCooldownUntil = Date.now() + PRO_COOLDOWN_MS
    proDegraded.value = true
    const wasStream = streamMode
    const rest = queue.slice(queueIndex).join('')
    resetPro()
    if (wasStream) {
      // 流式中途失败：**已经念出去的部分撤不回来**，所以既不能重读 rest、
      // 也不能让 turnEnd 再整条读一遍（两者都是重复朗读）。直接收尾本轮。
      // 覆盖场景有限：冷却期内的整轮本来就不会走流式（见 beginStream），
      // 能走到这里只有"开播成功之后上游才抖"。
      if (speakingId.value === id) {
        speakingId.value = null
        paused.value = false
      }
      return
    }
    speakLite(id, rest)
  }

  function speakPro(id: string, text: string): boolean {
    // packForTts：**整条尽量只发 1 次请求**。按句/按段切会让每段之间各等一次合成，
    // 听感就是"读完一段停几秒" —— 详见 speech-text.ts 的实测表。
    //
    // ⚠️ 分包上限（TTS_PACK_MAX_CHARS = 2000）**必须保留**：它是**长度安全**，不是性能取舍。
    // 服务端 `/api/tts*` 对 >2000 字直接回 400，整条超限会让 Pro 整轮回落成系统音色。
    // 2026-09-28 起每包都是**独立的流**，所以"多包"带来的不再是 3.9s 的空档，而是 ~0.6s。
    const packs = packForTts(text)
    if (!packs.length) return false
    queue = packs
    queueIndex = 0
    generation += 1
    const gen = generation
    speakingId.value = id
    paused.value = false
    synthesizing.value = true
    playProIndex(id, gen)
    return true
  }

  // ===== 流式（边生成边朗读，2026-09-28）=====
  //
  // 与 speakPro 的关系：同一个播放队列、同一个 playProIndex，区别只有两点 ——
  //   ① 队列是**边播边追加**的（speakPro 是一次性赋值）
  //   ② 队列播空时**不收尾**（proBusy=false + streamMode=true → 停车等下一块）

  /**
   * 进入流式模式：清空队列、占住 speakingId，等 `appendStreamText` 喂块。
   *
   * 返回 `false` = 本轮走不了流式，调用方应**放弃流式**回落到「完成后整条读」：
   *   · Pro 冷却中（上游刚抖过）→ 只能走 Lite，而**系统 TTS 无法增量**，
   *     强行流式只会得到机械音色 + 每块一次 `speechSynthesis.speak` 的拼接感
   *   · 环境不支持朗读
   */
  function beginStream(id: string): boolean {
    if (!supported.value || !id) return false
    if (Date.now() < proCooldownUntil) return false
    stopInternal()
    generation += 1
    speakingId.value = id
    paused.value = false
    streamMode = true
    return true
  }

  /** 追加一块（已清洗的）可朗读文本；当前没在播就立刻起播 */
  function appendStreamText(text: string) {
    if (!streamMode || !text) return
    queue.push(text)
    if (!proBusy) playProIndex(speakingId.value || '', generation)
    // 队列增长时**立刻**为"当前正在播的那一包之后"取音频，不要等当前包播完。
    //
    // 2026-09-28 修（配合正文真流式转发）：`ensurePrefetch` 原先**只**在上一包音频取回后
    // 触发一次（playProIndex 的 then 里）。那时队尾还没长出来，`if (!queue[index]) return`
    // 直接返回。于是流式下唯一能取到下一块的时机变成"当前块播完的 onended" ——
    // 而第 0 块是 204 字 ≈ 40s 音频，第 1 块要 40s 后才开始合成（握手主导 ≈3.4s，
    // 上游 ~3/4 概率 RST 时还要叠加退避重试）⇒ **每块之间必然插一段可听的静音空档**，
    // 首块提早上声的收益被后面的空档吃掉一半。实测复现：连续两次验收里
    // 一次只发出 1 个请求（第 2 块根本没到窗口内）。
    //
    // 幂等性：`ensurePrefetch` 按 index 去重、复用"在途 promise"，所以每次 push 都调它不会
    // 重复请求同一包；我们只按 `queueIndex + 1` 取（不取队尾），因此也不会把已经在途的
    // 有用预取 drop 掉 —— 传更后面的索引才会触发 dropPrefetch，这里刻意不这么做。
    else ensurePrefetch(queueIndex + 1)
  }

  /** 流结束：队列里的块播完后自然收尾（此后不再追加） */
  function endStream() {
    if (!streamMode) return
    streamMode = false
    const id = speakingId.value
    if (!id) return
    if (!proBusy) {
      if (queueIndex < queue.length) playProIndex(id, generation)
      else finish(id)
    }
  }

  // ===== Lite（系统 TTS 兜底）=====

  function pickVoice(): SpeechSynthesisVoice | null {
    if (!nativeSupported) return null
    const voices = window.speechSynthesis.getVoices()
    if (!voices.length) return null
    const zh = voices.filter((v) => /^zh/i.test(v.lang) || /Chinese|中文|普通话/i.test(v.name))
    if (!zh.length) return null
    // 大陆优先：同一音色名常常同时有 zh-CN 与 zh-TW 两份（如 "Shelley (中文（中国大陆）)"），
    // 不先筛一次就会随机拿到台湾腔那版。
    const pools = [zh.filter((v) => /^zh[-_]CN/i.test(v.lang)), zh]
    for (const pool of pools) {
      for (const name of LITE_VOICE_PREFER) {
        const hit = pool.find((v) => v.name.includes(name))
        if (hit) return hit
      }
    }
    return zh[0]
  }

  function speakLite(id: string, text: string) {
    // 系统 TTS 没有"合成期"这个概念，一 speak 就出声 → 顺手清掉合成态
    synthesizing.value = false
    if (!nativeSupported || !text || !text.trim()) {
      finish(id)
      return
    }
    window.speechSynthesis.cancel()
    clearKeepAlive()

    const u = new SpeechSynthesisUtterance(text)
    const voice = pickVoice()
    if (voice) {
      u.voice = voice
      u.lang = voice.lang
    } else {
      u.lang = 'zh-CN'
    }
    u.rate = 1
    u.pitch = 1
    u.onend = () => finish(id)
    u.onerror = () => finish(id)

    speakingId.value = id
    paused.value = false
    window.speechSynthesis.speak(u)

    // 长文本保活：规避 Chrome「长句静音卡死」
    keepAliveTimer = setInterval(() => {
      if (paused.value || !speakingId.value) return
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause()
        window.speechSynthesis.resume()
      }
    }, 10000)
  }

  // ===== 对外 API =====

  function speak(id: string, text: string) {
    if (!supported.value || !text || !text.trim()) return
    stopInternal()
    generation += 1
    if (Date.now() >= proCooldownUntil) {
      if (speakPro(id, text)) return
    }
    speakLite(id, text)
  }

  /** Pro 档此刻是否可用（冷却中 = false）。注意这是**时间函数**，别拿它做响应式渲染 */
  function isPro() {
    return Date.now() >= proCooldownUntil
  }

  /**
   * 暂停。**只在真的暂停到某个东西时才置 `paused`**。
   *
   * 2026-09-28 修的真机 bug（4 个 case 里复现 2 个）：原来的实现无条件 `paused.value = true`。
   * 而"已经点了一次朗读、但音频还在合成"时，`speakingId` 早已被占用、`currentAudio` 却还没建出来
   * ⇒ 第二次点击被 `toggle` 判成"暂停" → `paused = true` 而**没有任何对象被暂停**；
   * 等音频到达时 `playProIndex` 走 `if (paused.value) { 就位不播 }`，**一次 `play()` 都不调**
   * ⇒ 永久静音，界面却显示"朗读已暂停"。实测：合成中 2.5s 后点第二次、250ms 快速双击，
   * 两种都是 `play 调用 = [] / 出声 = []`；再点第三次才出声（11531ms）。
   *
   * 修法就是这条不变量：`paused === true` 必须意味着**有一个真实存在的音频/朗读被按住了**。
   * 合成期点击因此变成空操作 —— UI 侧同步把暂停按钮禁用，让"点了没用"变成"按钮本来就是灰的"。
   */
  function pause() {
    if (!speakingId.value) return
    if (currentAudio) {
      currentAudio.pause()
      paused.value = true
      return
    }
    if (nativeSupported && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause()
      paused.value = true
    }
    // 合成中（或系统 TTS 未在播）→ 无可暂停对象，保持原状态。
    // 这里兜住键盘快捷键/程序化调用；UI 上合成期按钮本就禁用。
  }

  function resume() {
    if (!speakingId.value) return
    if (currentAudio) currentAudio.play().catch(() => { /* 等用户再点 */ })
    else if (nativeSupported) window.speechSynthesis.resume()
    paused.value = false
  }

  /** 内部停止（不清 speakingId，供 speak 内部替换用） */
  function stopInternal() {
    generation += 1
    if (nativeSupported) window.speechSynthesis.cancel()
    clearKeepAlive()
    resetPro()
  }

  function stop() {
    stopInternal()
    speakingId.value = null
    paused.value = false
  }

  /** 便捷开关：同一条消息 播放 → 暂停 → 继续；换消息则重读 */
  function toggle(id: string, text: string) {
    if (speakingId.value === id) {
      if (paused.value) resume()
      else pause()
      return
    }
    if (!text) return
    speak(id, text)
  }

  onBeforeUnmount(() => {
    stop()
  })

  return {
    supported,
    speakingId,
    paused,
    /** 处于「Pro 不可用，已回落系统音色」的降级态 —— UI 据此提示（响应式） */
    proDegraded,
    /**
     * 处于「已点朗读、但还一声没出」的合成窗口 —— UI 据此显示"正在合成语音"并禁用暂停。
     * 这是"启动慢"这段等待**唯一**的可见信号，没有它用户就会重复点击。
     */
    synthesizing,
    /** Pro 档此刻是否仍在用（false = 冷却中，已回落 Lite） */
    isPro,
    speak,
    /** 流式（边生成边朗读）：beginStream → appendStreamText* → endStream */
    beginStream,
    appendStreamText,
    endStream,
    pause,
    resume,
    stop,
    toggle,
  }
}
