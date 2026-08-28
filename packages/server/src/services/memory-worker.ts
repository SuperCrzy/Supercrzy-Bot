/**
 * 记忆后台队列（2026-08-28 加：把 syncTurnMemories / runReflection 从"每轮直接 fire-and-forget"
 * 收拢到单一后台 worker，串行执行 → 天然节流 LLM 提取调用，主回复流零额外 async 负担）。
 *
 * 设计：
 * - 全局单例 memoryWorker：FIFO 队列 + 单 worker 循环（同一时刻最多一个提取任务在跑）
 * - pushSync(userContent, assistantContent) / pushReflection(opts)：入队即返回，不阻塞主流程
 * - 串行执行（最大并发=1）避免多会话高频对话时每轮都开一个 LLM 提取调用（费用/限流/内存防护）
 * - 任务内 try/catch：失败只记日志，不阻塞后续任务
 */
import { syncTurnMemories } from './memory-sync'
import { runReflection } from './reflection'

/** 单个后台任务 */
type Task = { kind: 'sync'; userContent: string; assistantContent: string } | { kind: 'reflect'; userContent: string; toolCalls: string[]; summary: string }

const queue: Task[] = []
let running = false

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
        } else {
          await runReflection({ userContent: task.userContent, toolCalls: task.toolCalls, summary: task.summary })
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
  void drain()
}

/** 调试/测试用：当前队列深度 */
export function memoryWorkerQueueLength(): number {
  return queue.length
}
