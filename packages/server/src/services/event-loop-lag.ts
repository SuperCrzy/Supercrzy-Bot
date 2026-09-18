/**
 * 事件循环延迟采样（2026-09-18，SSE 卡顿排查收口）
 *
 * 背景：08-27 记录的"浏览器前端页活跃 + 并发 agent 请求 → SSE 卡住不推进"从未被证伪或证实，
 * 08-27 11:25 前台重测又判定为后台 curl 重定向造成的观测假象。两个结论互相矛盾，
 * 根因是**没有客观判据**——只能靠肉眼看流、靠字节数猜。
 *
 * 这个模块补上判据：任何"服务端卡住"都必须先在事件循环延迟上体现。
 * - 延迟正常而前端仍不推进 → 问题在传输层/客户端，别再去后端里翻（避免重复劳动）
 * - 延迟出现尖峰 → 直接定位到同步阻塞调用（execSync / 递归 readdirSync / readFileSync 大文件）
 *
 * 实现要点：perf_hooks.monitorEventLoopDelay 是**累计**直方图，累计值在长 uptime 下会摊平，
 * 看不出"刚才那一下"的尖峰。所以每秒快照一次并 reset，只保留最近 60 秒的滚窗。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'

const WINDOW_SIZE = 60 // 保留最近 60 秒

interface Bucket {
  t: number      // 快照时间戳
  max: number    // 该秒内最大延迟（ms）
  mean: number   // 该秒内平均延迟（ms）
  samples: number
}

let histogram: IntervalHistogram | null = null
let snapshotTimer: NodeJS.Timeout | null = null
let buckets: Bucket[] = []
let startedAt = 0

const nsToMs = (ns: number) => Math.round((ns / 1e6) * 100) / 100

/** 启动采样（幂等；app 启动时调一次） */
export function startEventLoopMonitor(resolutionMs = 20): void {
  if (histogram) return
  try {
    histogram = monitorEventLoopDelay({ resolution: resolutionMs })
    histogram.enable()
    startedAt = Date.now()
    snapshotTimer = setInterval(takeSnapshot, 1000)
    // 采样定时器不应阻止进程退出（CLI/测试场景）
    snapshotTimer.unref?.()
  } catch {
    histogram = null
  }
}

/** 每秒把累计直方图快照进滚窗并清零，避免累计值摊平尖峰 */
function takeSnapshot(): void {
  if (!histogram) return
  try {
    const count = histogram.count
    const max = nsToMs(histogram.max)
    const mean = nsToMs(histogram.mean)
    histogram.reset()
    if (!count) return // 该秒内无采样（进程空闲），不占窗口
    buckets.push({ t: Date.now(), max, mean, samples: count })
    if (buckets.length > WINDOW_SIZE) buckets = buckets.slice(-WINDOW_SIZE)
  } catch { /* 采样失败不影响主流程 */ }
}

export interface EventLoopStats {
  /** 采样是否可用（拿不到则为 null，调用方按"无数据"处理） */
  available: boolean
  /** 采样已运行秒数 */
  uptime_s: number
  /** 最近 10 秒最大延迟（ms）——"刚才卡不卡" */
  max_10s_ms: number
  /** 最近 60 秒最大延迟（ms）——"这一段有没有卡过" */
  max_60s_ms: number
  /** 最近 60 秒平均延迟（ms）——稳态负载水位 */
  mean_60s_ms: number
  /** 最近 60 秒采样点总数 */
  samples_60s: number
  /** 最近 60 秒逐秒最大延迟（ms，旧→新），供前端画曲线 */
  series: number[]
  /** 判读用的形态标签 */
  verdict: 'ok' | 'busy' | 'blocked'
}

/**
 * 读取事件循环健康度。
 *
 * verdict 判据（取下界包含，宁可少报也不误报）：
 * - ok      : 60 秒最大延迟 < 100ms —— 同步操作都在几十毫秒量级，流不该被后端拖住
 * - busy    : 100ms ≤ 最大延迟 < 1000ms —— 有同步阻塞调用在跑（如 git/ffmpeg 同步、递归扫盘）
 * - blocked : 最大延迟 ≥ 1000ms —— 单次同步操作把事件循环冻住 ≥1 秒，此时所有并发 SSE 都停止推进
 *
 * `available` 只表示采样器是否在跑（未启动 = 没有可信数据）；
 * 统计值始终按滚窗算，空窗即全 0 + verdict 'ok'——这样判读逻辑可被单测直接锁死。
 */
export function getEventLoopStats(): EventLoopStats {
  const recent10 = buckets.slice(-10)
  const max10 = recent10.reduce((m, b) => Math.max(m, b.max), 0)
  const max60 = buckets.reduce((m, b) => Math.max(m, b.max), 0)
  const samples = buckets.reduce((s, b) => s + b.samples, 0)
  const mean60 = samples
    ? Math.round((buckets.reduce((s, b) => s + b.mean * b.samples, 0) / samples) * 100) / 100
    : 0

  return {
    available: !!histogram,
    uptime_s: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    max_10s_ms: max10,
    max_60s_ms: max60,
    mean_60s_ms: mean60,
    samples_60s: samples,
    series: buckets.map((b) => b.max),
    verdict: max60 >= 1000 ? 'blocked' : max60 >= 100 ? 'busy' : 'ok',
  }
}

/** 清空滚窗（压测前调用，保证读数是本次压测的） */
export function resetEventLoopStats(): void {
  buckets = []
  try { histogram?.reset() } catch { /* ignore */ }
}

/** 仅测试用：注入快照（绕开真实定时器） */
export function __pushBucketForTest(b: Bucket): void {
  buckets.push(b)
  if (buckets.length > WINDOW_SIZE) buckets = buckets.slice(-WINDOW_SIZE)
}
