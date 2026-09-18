/**
 * 记忆后台队列（2026-08-28 加：把 syncTurnMemories / runReflection 从"每轮直接 fire-and-forget"
 * 收拢到单一后台 worker，串行执行 → 天然节流 LLM 提取调用，主回复流零额外 async 负担）。
 *
 * 设计：
 * - 全局单例 memoryWorker：FIFO 队列 + 单 worker 循环（同一时刻最多一个提取任务在跑）
 * - pushSync(userContent, assistantContent) / pushReflection(opts)：入队即返回，不阻塞主流程
 * - 串行执行（最大并发=1）避免多会话高频对话时每轮都开一个 LLM 提取调用（费用/限流/内存防护）
 * - 任务内 try/catch：失败只记日志，不阻塞后续任务
 * - 三种任务：sync（turn 提取）/ reflect（任务反思）/ consolidate（整理记忆，2026-09-18 #147 加）
 */
import { syncTurnMemories } from './memory-sync'
import { runReflection } from './reflection'
import { getDB } from './database'
import { consolidateMemories } from './memory-consolidate'

/** 单个后台任务 */
type Task =
  | { kind: 'sync'; userContent: string; assistantContent: string }
  | { kind: 'reflect'; userContent: string; toolCalls: string[]; summary: string }
  | { kind: 'consolidate' }

const queue: Task[] = []
let running = false

/** 自动整理的节流闸门：两次整理之间至少隔这么久（整理是 O(n²) 比词元，别每个任务都跑） */
const CONSOLIDATE_MIN_INTERVAL_MS = 10 * 60 * 1000
let lastConsolidateAt = 0

/**
 * 后台自动整理（2026-09-18 #147）
 *
 * 为什么必须有：写入侧的精确去重（同 key 覆盖）拦不住"同主题不同措辞"，
 * 而 reflection 的任务量决定了 experience 会随任务数增长。只靠用户手动喊"整理记忆"
 * 等于没有整理机制 —— 实测 208 条里有 21 条是同主题重复（news 类扎堆）。
 *
 * ⚠️ 只**入队**，不在调用方线程执行：`pushReflection` 是在任务收尾时被调用的，
 * 若在这里直接跑整理（O(n²) 词元比对），就把"后台队列让主流程免于阻塞"这个设计初衷
 * 又还回去了。整理必须跟其它任务一样排在队列里，由 worker 串行消费。
 *
 * 节流在**入队时**判定（防止刷屏队列），真正的执行在 worker 里。
 */
function maybeConsolidate() {
  if (!autoConsolidateEnabled()) return
  const now = Date.now()
  if (now - lastConsolidateAt < CONSOLIDATE_MIN_INTERVAL_MS) return
  lastConsolidateAt = now
  queue.push({ kind: 'consolidate' })
}

/** 整理含删除操作 → 必须让用户能关掉（设置 → 记忆 → 自动整理记忆）。默认开启。 */
function autoConsolidateEnabled(): boolean {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get('memoryAutoConsolidate') as any
    return row ? row.value !== 'false' : true
  } catch {
    return false // 读不到设置（DB 未初始化/异常）→ 保守不删
  }
}

/** 后台 worker 主循环：串行消费队列，一次一个提取任务 */
async function drain() {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const task = queue.shift()!
      try {
        if (task.kind === 'sync') {
          await syncTurnMemories(task.userContent, task.assistantContent)
        } else if (task.kind === 'reflect') {
          await runReflection({ userContent: task.userContent, toolCalls: task.toolCalls, summary: task.summary })
        } else {
          try {
            // 二次校验：入队与执行之间用户可能刚刚关掉了自动整理
            if (autoConsolidateEnabled()) {
              const rep = consolidateMemories(getDB(), {})
              if (rep.removed > 0) console.log(`[MemoryWorker] 自动整理：${rep.summary}`)
            }
          } catch (e: any) {
            console.log(`[MemoryWorker] 自动整理异常: ${e?.message || e}`)
          }
        }
      } catch (e) {
        console.log(`[MemoryWorker] 提取异常: ${(e as Error)?.message || e}`)
      }
    }
  } finally {
    running = false
  }
}

/** 入队：turn 记忆同步（不阻塞主流程，返回立即） */
export function pushMemorySync(userContent: string, assistantContent: string): void {
  queue.push({ kind: 'sync', userContent, assistantContent })
  void drain()
}

/** 入队：经验反思（无工具调用时 runReflection 内部返回 null，不沉淀） */
export function pushReflection(opts: { userContent: string; toolCalls: string[]; summary: string }): void {
  if (!opts.toolCalls || opts.toolCalls.length === 0) return // 无工具调用不反思（对齐原逻辑）
  queue.push({ kind: 'reflect', ...opts })
  maybeConsolidate()
  void drain()
}

/** 入队：手动整理（调试/测试用；正常路径由 maybeConsolidate 自动触发） */
export function pushConsolidate(): void {
  queue.push({ kind: 'consolidate' })
  void drain()
}

/** 调试/测试用：重置自动整理节流闸门（否则单测里第二次调用恒被节流挡掉） */
export function resetConsolidateThrottle(): void {
  lastConsolidateAt = 0
}

/** 调试/测试用：当前队列深度 */
export function memoryWorkerQueueLength(): number {
  return queue.length
}
