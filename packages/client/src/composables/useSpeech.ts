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
 *
 * 2026-10-21 由 **60s → 15s**。原值 60s 的致命副作用不是"少读一段"，而是
 * `beginStream()` 在冷却期内直接返回 false ⇒ `useChatSpeech` 里的 `streamGaveUp = true`
 * ⇒ **本轮彻底放弃边生成边朗读**，退化成"等输出完再整条读"。
 * 于是"偶发一次失败"被放大成"接下来一分钟全部不流式"，用户观感就是
 * 「为什么每次都要等 AI 全说完才开始读」。
 * 15s 仍能挡住上游抖动期内的连环请求（一个失败回合本身就要 3~16s），
 * 又不至于把下一次朗读也一起拖下水。
 */
export const PRO_COOLDOWN_MS = 15_000

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
   * 本 composable 创建过、且可能仍在播的所有 `<audio>`。
   *
   * 🔴 2026-10-20 修老板实机 bug「上一段还在朗读，下一段回答已生成并开始朗读，
   *    两个语音重叠在一起」。
   *
   * 根因：`currentAudio` 是**单指针，只指向最新那个**。两轮朗读交叠时（上一轮还在播、
   * 下一轮已经把 `currentAudio` 覆盖掉），旧的那个就**永久失去句柄** —— 之后任何
   * `stop` / `resetPro` 都只停得到新的那个，旧的会一直播到自然结束。
   * 只靠单指针无法表达"同时存在多个"这个事实，所以改用集合兜住全部。
   *
   * 不变量：**任何时刻只要调用 stop/resetPro，liveAudios 必须被清空**。
   */
  const liveAudios = new Set<HTMLAudioElement>()

  /** 彻底关掉一个 audio：摘事件 → 停播 → 断流（不清 src 的话下载会继续把整段拉完） */
  function killAudio(a: HTMLAudioElement) {
    a.onended = null
    a.onerror = null
    a.onplaying = null
    try { a.pause() } catch { /* 已断开 */ }
    try { a.removeAttribute('src'); a.load() } catch { /* 已断开 */ }
    liveAudios.delete(a)
  }

  /** 兜底全停 —— 不管哪条路径漏了 stop，这一步保证"不会再有两个声音同时响" */
  function killAllAudios() {
    for (const a of [...liveAudios]) killAudio(a)
    liveAudios.clear()
  }

  /**
   * 预取槽：记 **在途 promise**（而不是"等拿到 URL 才记"）。
   *
   * 2026-09-28 修：原来只在 `.then` 里写 `prefetch = {index, url}`，于是在途期间槽还是空的
   * ⇒ 当前包恰好在预取返回前播完时，`playProIndex` 会以为"没有预取"而**把同一个包再请求一次**。
   * 上游本来就是瓶颈，重复请求会让下一包更晚就绪（实测抓到一个包两次请求）。
   *
   * 2026-10-21 第二次改：预取物从「票据 URL」变成「**已经 load() 过的 `<audio>`**」。
   * 旧实现只提前换票，音频流要等上一段播完（`onended` → `playProIndex`）才真正开始拉，
   * 于是每段之间必然空等一次"握手 + 首个音频块"。手机实测这段是 **7.5 / 9.4 / 10.6s**，
   * 长回复切 5 段 ⇒ 中间夹 40 秒静音（就是用户说的"卡壳"）。
   * 现在提前把下一段的 `<audio>` 建好并 `preload='auto'; load()` —— 上一段播放的
   * 几十上百秒里，下一段早已缓冲完成，切段时几乎零等待。
   */
  type PrefetchSlot = { index: number; el: Promise<HTMLAudioElement>; used: boolean }
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
  /**
   * 本轮是否已经用过「整条一次请求」的重试额度。
   *
   * 2026-10-21 加。旧逻辑是 Pro 失败 ⇒ **立刻**换系统音色（`speakLite`）并进冷却。
   * 那条路径的问题是"音色换了"这件事用户第一耳就听出来，却往往只是一次握手抖动
   * （手机端 TLS 1.3~6.1s 抖动，实测 502 后手动再点一次就成功）。
   * 现在改成**先换成整条一次请求再试一次 Pro**，只有这次也失败才降到系统音色 ——
   * 换音色应该是最后手段，而不是第一次失败的反应。
   * 额度**每轮一次**（在 speak / beginStream 里复位），避免变成无限重试。
   */
  let wholeRetried = false
  /**
   * **当前这一块**是否已经真的出过声。
   *
   * 2026-10-21 随「整条重试」一起加：整条重试的前提是"这一轮用户还什么都没听到"。
   * 若已经出过声再重读整条，听到的就是**同一段被念第二遍** —— 那比降级更糟。
   * 粒度必须是"块"而不是"轮"：第 0 块播完、第 1 块失败时，重试第 1 块起的内容是**正确的**
   * （没重复），所以每进入一个新块就复位。
   */
  let blockHeard = false

  // ---- Lite 档内部状态 ----
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null

  /** 丢掉预取槽：**未使用的那条音频要真的掐掉**，否则它会继续在后台拉流占带宽 */
  function dropPrefetch() {
    const p = prefetch
    prefetch = null
    if (!p) return
    p.el
      .then((a) => { if (!p.used) killAudio(a) })
      .catch(() => { /* 换票失败，本来就没元素 */ })
  }

  /**
   * 换票 → 立刻建 `<audio>` 并开始缓冲，返回**尚未挂钩子**的元素。
   *
   * 关键在 `preload='auto'` + `load()`：这两步让浏览器马上发起请求，
   * 而不是等我们调 `play()` 才去握手。段间那 7~10 秒就是靠这个提前量填掉的。
   * 元素一建好就进 `liveAudios`，保证任何 stop/resetPro 都能停到它（防"两段同时响"）。
   */
  async function createAudioFor(text: string): Promise<HTMLAudioElement> {
    const token = await fetchTtsTicket(text)
    const a = new Audio(streamUrlFor(token))
    a.preload = 'auto'
    liveAudios.add(a)
    try { a.load() } catch { /* 某些环境不支持预加载，退回被动拉流 */ }
    return a
  }

  /**
   * 确保第 index 包已被预取 —— 预取的是**真正在缓冲的音频元素**。
   *
   * 2026-10-21 从"只换票"改成"提前拉流"：换票只要 6ms，省不下任何时间；
   * 真正贵的是上游握手 + 首块（手机 7~10s）。必须让音频**在上段播放期间就开始流**，
   * 否则每段之间必然空一次。
   */
  function ensurePrefetch(index: number) {
    if (!queue[index]) return
    if (prefetch && prefetch.index === index) return
    dropPrefetch()
    const slot: PrefetchSlot = { index, el: createAudioFor(queue[index]), used: false }
    slot.el.catch(() => { /* 预取失败无所谓，用到时现建 */ })
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
    // 会话式流：把 <audio> 掐掉就等于断开会话（服务端在线路 close 时会 destroy），
    // 所以这里只需要清指针，不需要额外发请求。
    liveToken = null
    liveAudio = null
    // Drop the live push queue too: the session is gone, queued text is meaningless
    // (prevents endLive from draining leftovers of a dead session)
    livePushQueue = []
    livePushedChars = 0
    // ⚠️ liveFailed is deliberately **not** cleared here: turnEnd inspects it **after** the audio
    // ended (and may also query status), and a natural end runs finish → resetPro, so clearing
    // here would wipe a failure that was just recorded. Its lifecycle is "clear at the start of
    // each beginLive" instead (see beginLive).
    // 全停：不只 currentAudio，而是**所有活着的 audio**（漏停的那个会被这里兜住）。
    // 原来的 `if (currentAudio) { pause(); removeAttribute('src') }` 在"两轮交叠、
    // currentAudio 已指向新的"时停不到旧的 —— 那就是重叠朗读的来源。
    killAllAudios()
    currentAudio = null
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
    // 每取一个新块 = 用户此刻还没听到它 → 允许"整条重试"（见 blockHeard 注释）
    blockHeard = false

    // 用预取的**音频元素**（若正好是这一包），否则现场建一个
    // 2026-10-21：预取物从"票据 URL"改成"已经 set preload=auto 并 load() 过的 <audio>"。
    let elPromise: Promise<HTMLAudioElement>
    if (prefetch && prefetch.index === queueIndex) {
      prefetch.used = true
      elPromise = prefetch.el
      prefetch = null
    } else {
      // 槽里是别的包（或空）→ 直接现建，别把可能已落地的预取丢掉（稍后按新位置校正）
      elPromise = createAudioFor(text)
    }

    elPromise
      .then((audio) => {
        if (speakingId.value !== id || gen !== generation) return
        currentUrl = audio.src
        // liveAudios 已在 createAudioFor 里登记（预取时提前建的元素也必须在集合里，
        // 否则 stop/resetPro 停不到它 —— 那就是"两段同时响"的老 bug）。
        liveAudios.add(audio)
        currentAudio = audio
        // 这一块**是否真的出过声**。`onerror` 能不能重试完全由它决定：
        // 出过声再重播就是叠音，一声没出才可能是票据失效这类可自愈的失败。
        let everPlayed = false
        // **真的出声**才算合成结束 —— 在此之前 UI 显示"正在合成语音"、暂停按钮不可用。
        // 这也是"点了朗读要等几秒"这段窗口唯一的可见信号。
        audio.onplaying = () => {
          if (speakingId.value !== id || gen !== generation) return
          everPlayed = true
          blockHeard = true
          synthesizing.value = false
          // 能出声 = 上游是通的（冷却到期后的重试走到这里）→ 撤下降级提示。
          // 放在这里而不是"换票成功"时：换票只是本地一次 POST，**不能**证明上游通了；
          // 上游仍然挂着时票据照样能换到，那样提示会先消失再回来。
          proDegraded.value = false
        }
        audio.onended = () => {
          // 先摘登记再判过期：这一块已经播完，无论本轮回调是否还有效（gen 可能已过期），
          // 都不该继续留在 liveAudios 里 —— 否则引用不释放，killAllAudios 还会重复处理。
          liveAudios.delete(audio)
          if (speakingId.value !== id || gen !== generation) return
          currentUrl = null
          currentAudio = null
          queueIndex += 1
          blockRetries = 0
          playProIndex(id, gen)
        }
        audio.onerror = () => {
          liveAudios.delete(audio)
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
    const wasStream = streamMode
    const rest = queue.slice(queueIndex).join('')
    // ① **先别换音色**：非流式路径下，用「整条一次请求」再试一次 Pro。
    //    一次握手抖动不值得把神经音色换成系统拼接音色 —— 实测（手机）
    //    同一句 502 之后手动再点一次就成功，说明失败是握手层而非内容层。
    if (!wasStream && !wholeRetried && !blockHeard && rest) {
      wholeRetried = true
      resetPro()
      // ⚠️ 必须写在 resetPro() **之后**：resetPro 会把 blockRetries 归零。
      // 整条重试已是第二次机会，再给它一份块内宽容额度就变成 4 次上游握手的尝试。
      blockRetries = 1
      if (speakPro(id, rest)) return
    }
    // ② 这一步才真的降级：进冷却 + 亮提示 + 按模式收场
    proCooldownUntil = Date.now() + PRO_COOLDOWN_MS
    proDegraded.value = true
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
    wholeRetried = false // 新的一轮 → 归还额度
    generation += 1
    speakingId.value = id
    paused.value = false
    streamMode = true
    return true
  }

  // ===== 会话式朗读（2026-10-21，一条消息一条流）=====
  //
  // 与上面的「逐段流式」是**两条互斥的路**：
  //   · 逐段：客户端切块 → 每块一个 `<audio>`（历史方案，留作回退）
  //   · 会话：一个 `<audio>` 连着一条永不换连接的 mp3 流 ← 段间零空档
  //
  // 为什么能做到：上游同一条 ws 能连续多轮合成，且 96k mp3 是**无 ID3 头的纯帧流**
  // （首 4 字节 fff3），多轮音频拼起来就是一条连续 mp3（已实测 afinfo 解出 7.68s 连续时长）。
  let liveToken: string | null = null
  let liveAudio: HTMLAudioElement | null = null

  // ---- Serialized live push queue ----
  //
  // The old `pushLive`/`endLive` were `void fetch` without await — measured: end arrives at the
  // server **before** the last push (a 150~366ms jitter on a direct local link is enough to
  // reorder them) and the server silently drops a "push that arrives after end" (it answers 200
  // with `{ok:false}`), leaving audio that stops halfway. That was one of the four root causes
  // behind "it stops in the middle and never finishes the sentence".
  //
  // Now: push enqueues → a single pump sends them one by one (order preserved + failures
  // visible) → `endLive` waits for the queue to **drain** before sending end.
  // Invariant: once `endLive` resolves, every push has been acknowledged by the server.
  let livePushQueue: string[] = []
  /** Chars the server actually acknowledged (failures not counted) — fallback for unplayed seconds */
  let livePushedChars = 0
  /** Whether this session saw a push failure / audio interruption (drives the UI hint + resume) */
  const liveFailed = ref(false)

  /** Real success/failure of one push (non-ok / ok:false both count — HTTP 200 does not mean
   *  accepted) */
  async function postLivePush(token: string, text: string): Promise<boolean> {
    try {
      const res = await fetch('/api/tts/live/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, text }),
      })
      if (!res.ok) return false
      const j: any = await res.json().catch(() => null)
      return !j || j.ok !== false
    } catch {
      return false
    }
  }

  let livePumpInFlight: Promise<void> | null = null

  /**
   * Push pump. **Repeat calls return the same in-flight promise** — otherwise `await pumpLive()`
   * inside `endLive` returns immediately while the pump is still running, the token is cleared
   * too early and the pump discards the whole remaining queue (a race the unit test caught:
   * push x2 + end back-to-back used to send only 1 push).
   */
  function pumpLive(): Promise<void> {
    if (livePumpInFlight) return livePumpInFlight
    const p = (async () => {
      while (livePushQueue.length) {
        const text = livePushQueue[0]
        const token = liveToken
        if (!token) return // session closed by stop: leftover text dies with it (resetPro cleared)
        const ok = await postLivePush(token, text)
        if (!liveToken || liveToken !== token) return // closed while draining
        livePushQueue.shift()
        if (ok) {
          livePushedChars += text.length
        } else {
          // ⚠️ **No retry**: push is not idempotent. If the server actually accepted the text
          // and only the response was lost, resending reads the same passage twice (worse than
          // losing it). Set failed instead — the client shows "interrupted / resume" so the user
          // can continue from the gap; the gap itself is not hidden.
          liveFailed.value = true
        }
      }
    })()
    livePumpInFlight = p
    void p.finally(() => { if (livePumpInFlight === p) livePumpInFlight = null })
    return p
  }

  /**
   * Currently unplayed audio seconds — the **control value** for live batching (seconds, not
   * chars).
   *
   * Truth first: end of the `audio.buffered` range covering currentTime, minus currentTime.
   * When the truth is unavailable (some environments / not buffered yet) fall back to a computed
   * value: acknowledged chars ÷ playback rate (measured 4.8 chars/s) converted to seconds, minus
   * elapsed playback time.
   */
  function liveAheadSec(): number {
    const a = liveAudio
    if (!a) return 0
    const t = a.currentTime || 0
    try {
      for (let i = 0; i < a.buffered.length; i++) {
        if (a.buffered.start(i) - 0.5 <= t && t <= a.buffered.end(i)) {
          return Math.max(0, a.buffered.end(i) - t)
        }
      }
    } catch { /* buffered unavailable → use computed value */ }
    const rate = liteRate() || 1
    return Math.max(0, livePushedChars / (4.8 * rate) - t)
  }

  /**
   * 会话流的码率档（'96' | '48'），**自适应**。
   *
   * 为什么需要降档：96k 音频 = 12KB/s，实测弱网（手机热点）出口只有 13KB/s，
   * 缓冲必然见底；48k 只要 6KB/s，同样的链路就有一倍余量。
   * 触发条件是**真的播起来之后**出现 `waiting`/`stalled`（缓冲见底），
   * 不在首次加载阶段误判 —— 那时候等缓冲是正常的。
   * 恢复策略：连续 3 轮无 underrun 才升回 96k，避免"抖动一下就永久降质"。
   */
  type LiveQuality = '96' | '48'
  const QUALITY_KEY = 'supercrzy:ttsQuality'
  function readQuality(): LiveQuality {
    try { return localStorage.getItem(QUALITY_KEY) === '48' ? '48' : '96' } catch { return '96' }
  }
  let liveQuality: LiveQuality = readQuality()

  /**
   * 「开会话 → 真的出声」的耗时（EWMA，2026-10-21）。
   *
   * 用途不是显示，而是给 `useChatSpeech` 算**首段该攒多少字**：
   * 快链路 0.5s ⇒ 8 字就能开读；弱网 2.3s ⇒ 要 16 字以上才不会断粮。
   * 冷启动没有历史值时用 1200ms 兜底（既不激进也不拖沓）。
   */
  const LATENCY_KEY = 'supercrzy:ttsLatencyMs'
  function readLatency(): number {
    try {
      const v = Number(localStorage.getItem(LATENCY_KEY))
      return Number.isFinite(v) && v >= 200 && v <= 5000 ? v : 1200
    } catch { return 1200 }
  }
  let latencyEwma = readLatency()
  function latencyMs(): number { return latencyEwma }
  function noteLatency(ms: number): void {
    const v = Math.min(5000, Math.max(200, ms))
    latencyEwma = Math.round(latencyEwma * 0.6 + v * 0.4)
    try { localStorage.setItem(LATENCY_KEY, String(latencyEwma)) } catch { /* 忽略 */ }
  }
  let goodTurns = 0

  function setLiveQuality(q: LiveQuality): void {
    if (liveQuality === q) return
    liveQuality = q
    goodTurns = 0
    try { localStorage.setItem(QUALITY_KEY, q) } catch { /* 隐私模式写不了，忽略 */ }
  }

  /**
   * 开一条会话流。返回 `false` = 走不通，调用方应回退到逐段流式 / 整条读。
   *
   * 成功即代表：一个新的 `<audio>` 已经指向 `/api/tts/live/stream`，之后所有
   * `pushLive()` 的文本都会合成进**同一条流**里，段间没有新连接、没有新 mp3 头。
   */
  async function beginLive(id: string): Promise<boolean> {
    if (!supported.value || !id) return false
    if (Date.now() < proCooldownUntil) return false
    stopInternal()
    // New session: clear the previous turn's failure flag (resetPro deliberately leaves it)
    liveFailed.value = false
    wholeRetried = false
    generation += 1
    const gen = generation
    const t0 = Date.now()
    let latencyNoted = false
    try {
      const res = await fetch('/api/tts/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: options.voice?.(), rate: options.rate?.(), quality: liveQuality }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j: any = await res.json()
      const token = String(j?.token || '')
      if (!token) throw new Error('未取到朗读会话')
      if (gen !== generation) return false // 期间被 stop/换轮次
      liveToken = token
      const a = new Audio(String(j?.url || `/api/tts/live/stream?t=${token}`))
      a.preload = 'auto'
      liveAudio = a
      liveAudios.add(a)
      currentAudio = a
      speakingId.value = id
      paused.value = false
      synthesizing.value = true
      let playedOnce = false
      let underran = false
      a.onplaying = () => {
        if (gen !== generation) return
        if (!latencyNoted) {
          latencyNoted = true
          noteLatency(Date.now() - t0) // 「开会话 → 出声」的真实耗时，供自适应切块用
        }
        playedOnce = true
        synthesizing.value = false
        proDegraded.value = false
      }
      /** 播起来之后又断粮 = 链路带宽不够 → 下一轮降档 */
      const onUnderrun = () => {
        if (gen !== generation || !playedOnce || underran) return
        underran = true
        setLiveQuality('48')
      }
      a.onwaiting = onUnderrun
      a.onstalled = onUnderrun
      a.onended = () => {
        if (gen !== generation) return
        // 这一轮全程没断粮 → 计入"可以尝试升回 96k"
        if (!underran && liveQuality === '48') {
          goodTurns += 1
          if (goodTurns >= 3) setLiveQuality('96')
        }
        finish(id)
      }
      a.onerror = () => {
        if (gen !== generation) return
        // 流已经吐过音频就不该重播（会叠音）——这里只做降级收尾
        proCooldownUntil = Date.now() + PRO_COOLDOWN_MS
        proDegraded.value = true
        resetPro()
        // ⚠️ Must come **after** resetPro(): resetPro zeroes liveFailed.
        // Setting failed lets the caller (useChatSpeech) know this turn was interrupted and take
        // the "interrupted / resume" path instead of silently pretending it finished.
        liveFailed.value = true
        if (speakingId.value === id) { speakingId.value = null; paused.value = false }
      }
      try { a.load() } catch { /* 不支持预加载 */ }
      a.play().catch(() => { /* 自动播放被拦：等用户再点 */ })
      return true
    } catch {
      return false
    }
  }

  /** Append text to the current session: enqueued and sent serially by the single pump
   *  (order preserved, see pumpLive) */
  function pushLive(text: string): void {
    const t = String(text || '').trim()
    if (!liveToken || !t) return
    livePushQueue.push(t)
    void pumpLive()
  }

  /**
   * Text is done: **wait for the push queue to drain** before asking the server to end the
   * stream (which makes the client receive the audio `ended` event).
   *
   * Returns a Promise — the caller (useChatSpeech) must await it before treating "all pushes for
   * this turn have landed", and only then is it safe to query status to detect a dropped tail.
   */
  async function endLive(): Promise<void> {
    const token = liveToken
    if (!token) return
    // 🔴 Must drain first: end overtaking the last push = the tail is silently dropped (reproducible)
    await pumpLive()
    if (liveToken === token) liveToken = null
    try {
      await fetch('/api/tts/live/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token }),
      })
    } catch { /* network failure: the server's idle timeout will reclaim the session */ }
  }

  /** 当前是否处于会话流模式 */
  function isLive(): boolean {
    return liveToken !== null
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

  /**
   * 把 Pro 的 rate 串（`'default' | '+20%' | '-10%'`）折算成 Web Speech 的倍率。
   *
   * 2026-10-21 修：`speakLite` 原来硬写 `u.rate = 1`，于是**降级时连语速都变了**
   * （用户在设置里调了 +20%，回落系统音色后回到正常速度）。音色变了 + 语速变了两件事
   * 同时发生，听感就是"这不是同一个朗读功能"。
   * 夹在 [0.5, 2]：Web Speech 对极端值行为不一致（Safari 会把 >2 当 2，Chrome 可能报错）。
   */
  function liteRate(): number {
    const raw = String(options.rate?.() || '')
    const m = raw.match(/([+-]?\d+(?:\.\d+)?)\s*%/)
    if (!m) return 1
    const pct = Number(m[1])
    if (!Number.isFinite(pct)) return 1
    return Math.min(2, Math.max(0.5, 1 + pct / 100))
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
    u.rate = liteRate()
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
    wholeRetried = false // 新的一轮 → 归还「整条重试」额度
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
    /** Live mode (one stream per message): beginLive → pushLive* → endLive (resolves after the
     *  push queue drains) */
    beginLive,
    pushLive,
    endLive,
    isLive,
    /** Whether this session saw a push failure / audio interruption (reactive; drives the UI hint) */
    liveFailed,
    /** Currently unplayed audio seconds (audio.buffered truth first, computed fallback) — the
     *  batching control value */
    liveAheadSec,
    /** Chars the server acknowledged (failures not counted) */
    livePushedChars: () => livePushedChars,
    /** Current session token (flushLive keeps a copy before endLive clears it, to query status) */
    liveTokenNow: () => liveToken,
    /** 实测「开会话→出声」的 EWMA（ms），供自适应切块算首段门槛 */
    latencyMs,
    pause,
    resume,
    stop,
    toggle,
  }
}
