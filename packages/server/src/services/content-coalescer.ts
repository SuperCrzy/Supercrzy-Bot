/**
 * 正文合并窗口（2026-09-28，"正文真流式转发"配套）
 *
 * 背景：`agent.ts` 原先在 while 读循环**结束之后**才把整块 `contentBuffer` 按 8 字 / 4ms
 * 回放成 `content_chunk`。上游其实是**匀速**吐字的（实测 1375 字 / 6.58s / 208 字每秒 /
 * 875 个 delta，各段时间分布基本均匀），于是回放把全部正文推到了流尾 —— 客户端实测
 * "850 字挤在流最后 0.7 秒"。打字机与"边生成边朗读"都因此吃不到实时性。
 *
 * 现在改成边收边发。但**不能每个 delta 都直发**：一轮就有 ~875 个 delta，而
 * `services/chat.ts` 的注释明说"逐 token 转发是背压最重的路径"。所以需要合并窗口把
 * 写次数压回 ~170 次/轮（与原回放持平），同时不牺牲"边生成边到"。
 *
 * 窗口规则（两个阈值取先到者）：
 *   ① 累计 ≥ `maxChars`（默认 16）—— 快模型下的上界，保证不为了凑时间把字押住
 *   ② 距上次发送 ≥ `windowMs`（默认 40ms）—— 慢模型下的下界，保证写次数不被 delta 数放大
 *   ③ **首片无条件立即发**（`lastFlushAt === null`）—— 不让窗口把 TTFT 拖慢 40ms
 *
 * 抽成独立模块是为了可单测：这里的不变量（顺序无损 / 首片不押 / 写次数上界）在
 * `agent.ts` 那种 2500 行的异步函数里没法逐条钉住。
 */

/** 合并窗口时长（ms）：距上次发送超过它就必须发，哪怕只攒了 1 个字 */
export const CONTENT_FLUSH_MS = 40
/** 单批字数控量上限：攒够就发，不等窗口 */
export const CONTENT_FLUSH_CHARS = 16

export interface ContentCoalescerOptions {
  /** 覆盖默认窗口时长（测试用） */
  windowMs?: number
  /** 覆盖默认单批字数控量（测试用） */
  maxChars?: number
}

export interface ContentCoalescer {
  /**
   * 投入一段增量。返回**该发出的文本**（`null` = 继续攒着）。
   * `now` 可注入，便于在单测里用假时钟推进。
   */
  push(text: string, now?: number): string | null
  /** 流结束/换轮前把残留尾巴取出来。空则不产生事件（返回 `null`）。 */
  flush(now?: number): string | null
  /** 当前还押着多少字（未发） */
  readonly pendingLength: number
  /** 已发出多少批（写次数，供验收断言"没把写次数放大"） */
  readonly emittedBatches: number
}

export function createContentCoalescer(opts: ContentCoalescerOptions = {}): ContentCoalescer {
  const windowMs = opts.windowMs ?? CONTENT_FLUSH_MS
  const maxChars = opts.maxChars ?? CONTENT_FLUSH_CHARS

  let pending = ''
  // null = 本轮还没发过 ⇒ 首片无条件立即发。
  // ⚠️ 不能用 `0` 当哨兵：那样"首片立即发"就依赖 `Date.now()` 足够大，
  //    单测里任何小的时间戳都会让首片被押住（写测试时正是这么踩出来的）。
  let lastFlushAt: number | null = null
  let emittedBatches = 0

  function take(now: number): string | null {
    if (!pending) return null
    const out = pending
    pending = ''
    lastFlushAt = now
    emittedBatches += 1
    return out
  }

  return {
    push(text: string, now: number = Date.now()): string | null {
      if (!text) return null
      pending += text
      // 字数够 → 发；否则看窗口（本轮还没发过则视为必然过期）
      if (pending.length < maxChars && lastFlushAt !== null && now - lastFlushAt < windowMs) return null
      return take(now)
    },
    flush(now: number = Date.now()): string | null {
      return take(now)
    },
    get pendingLength() {
      return pending.length
    },
    get emittedBatches() {
      return emittedBatches
    },
  }
}
