/**
 * SSE 流健康：活跃流计数 + 写保护（2026-09-18，SSE 卡顿排查收口）
 *
 * 为什么必须收口：agent.ts / chat.ts 里原本是裸 `ctx.res.write(...)`，两个问题都真实存在——
 *
 * 1. **忽略背压**：`res.write()` 返回 false 表示内核/用户态缓冲已满。客户端慢（浏览器主线程
 *    被大量渲染占住）时事件会持续堆在服务端内存里，用户看到的就是"流卡住不推进"——
 *    服务端却认为一切正常。这是"后端看起来没问题、前端就是不动"这类现象的真实来源之一。
 * 2. **不判断连**：客户端断开后继续写会拿到 ERR_STREAM_WRITE_AFTER_END / EPIPE。
 *    `ctx.respond = false` 后 Koa 不再管这个响应，`res` 上若没有 'error' 监听，
 *    Node 会把它抛成未捕获异常 → 整个后端退出。长任务跑到一半断网就会踩到。
 *
 * 这里统一提供 safeWriteSse + 计数。计数暴露给 /api/health，让"卡不卡"有客观数字，
 * 不再靠肉眼盯流和字节数猜（08-27 那次的误判就是没数字可看导致的）。
 */
import type { Context } from 'koa'

interface StreamRec {
  label: string
  openedAt: number
  writes: number
  backpressured: number
  released: boolean
}

/** key 用 res 对象本身：一个响应就是一个流，天然一对一 */
const STREAMS = new Map<any, StreamRec>()

let totalWrites = 0
let totalDropped = 0
let totalBackpressure = 0

/** 响应是否还能写（已 end / 已销毁 / 已 finish 都不该再写） */
function isWritable(res: any): boolean {
  if (!res) return false
  if (res.writableEnded || res.writableFinished) return false
  if (res.destroyed) return false
  return typeof res.write === 'function'
}

/**
 * 注册一条 SSE 流（写完响应头后调一次）。
 *
 * 三个释放路径都要挂：'close'（客户端断开）、'finish'（正常写完）、'error'（写失败）。
 * 少挂一个，"活跃流"计数就会只增不减，指标随即失效——指标失效比没有指标更糟。
 */
export function registerSseStream(ctx: Context | any, label = 'sse'): () => void {
  const res = ctx?.res
  if (!res || STREAMS.has(res)) return () => {}
  const rec: StreamRec = { label, openedAt: Date.now(), writes: 0, backpressured: 0, released: false }
  STREAMS.set(res, rec)

  const release = () => {
    if (rec.released) return
    rec.released = true
    STREAMS.delete(res)
  }
  // 'error' 监听同时起两个作用：释放计数 + 把 EPIPE 这类错误吃掉（无监听会抛穿进程）
  res.on?.('close', release)
  res.on?.('finish', release)
  res.on?.('error', release)
  return release
}

/**
 * 写 SSE 分片。返回是否写入成功（false = 已丢弃：断连或该响应不可写）。
 *
 * 注意：返回 true 不等于客户端已收到——只表示交给了 socket。背压（返回 false 的 write）
 * 会被计入 backpressured，可用 /api/health 观察。
 */
export function safeWriteSse(ctx: Context | any, chunk: string): boolean {
  const res = ctx?.res
  if (!isWritable(res)) {
    totalDropped++
    return false
  }
  try {
    const ok = res.write(chunk)
    totalWrites++
    const rec = STREAMS.get(res)
    if (rec) {
      rec.writes++
      if (!ok) rec.backpressured++
    }
    if (!ok) totalBackpressure++
    return true
  } catch {
    // write 抛错（多为断连后的 EPIPE）→ 计入丢弃，不让它冒泡
    totalDropped++
    return false
  }
}

/** 结束一条 SSE 流（替代裸 res.end()，保证计数释放） */
export function endSseStream(ctx: Context | any): void {
  const res = ctx?.res
  STREAMS.delete(res)
  try { res?.end?.() } catch { /* 已关闭则忽略 */ }
}

export interface SseStats {
  /** 当前活跃 SSE 流数（长任务在跑时会 >0；持续不降说明有泄漏） */
  active: number
  /** 进程启动至今累计写入分片数 */
  writes: number
  /** 累计丢弃数（客户端已断开/响应不可写） */
  dropped: number
  /** 累计背压次数（write 返回 false）——数字大说明客户端消费跟不上 */
  backpressured: number
  /** 活跃流的明细（label + 存活时长 + 各自写入/背压） */
  streams: Array<{ label: string; age_s: number; writes: number; backpressured: number }>
}

export function getSseStats(): SseStats {
  const now = Date.now()
  return {
    active: STREAMS.size,
    writes: totalWrites,
    dropped: totalDropped,
    backpressured: totalBackpressure,
    streams: Array.from(STREAMS.values()).map((r) => ({
      label: r.label,
      age_s: Math.round((now - r.openedAt) / 1000),
      writes: r.writes,
      backpressured: r.backpressured,
    })),
  }
}

/** 清零累计计数（压测前调用；活跃流明细不受影响） */
export function resetSseStats(): void {
  totalWrites = 0
  totalDropped = 0
  totalBackpressure = 0
}

/** 仅测试用：清空流注册表，避免用例间互相污染 */
export function __clearStreamsForTest(): void {
  STREAMS.clear()
  resetSseStats()
}
