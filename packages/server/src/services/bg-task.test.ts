/**
 * Invariants for the background task registry.
 *
 * These are state-machine assertions, not "does the command work" tests: the interesting failures
 * are (a) a cancelled task later being recorded as failed, (b) an incremental read returning the
 * same bytes twice, (c) the registry growing past its cap. Real short-lived processes are used on
 * purpose — a mocked spawn would not prove the exit path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startBgTask,
  getBgTask,
  listBgTasks,
  readBgTaskOutput,
  cancelBgTask,
  clearFinishedBgTasks,
  deleteBgTask,
  onBgTaskDone,
  __resetBgTasksForTest,
  BG_MAX_LIVE_TASKS,
  BG_MAX_BUFFER,
} from './bg-task'

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

beforeEach(() => __resetBgTasksForTest())
afterEach(() => __resetBgTasksForTest())

describe('bg-task 状态机', () => {
  it('启动立即返回（不阻塞），命令在后台跑完 → done + exitCode 0', async () => {
    const t0 = Date.now()
    const id = startBgTask({
      sessionId: 's1',
      title: '慢命令',
      command: 'sleep 0.4; echo BG_DONE_MARK',
      cwd: process.cwd(),
    })
    const startMs = Date.now() - t0
    // 关键：启动本身不能等命令（0.4s 的命令，启动必须在 300ms 内返回）
    expect(startMs).toBeLessThan(300)
    expect(getBgTask(id)?.status).toBe('running')

    const ok = await waitFor(() => getBgTask(id)?.status === 'done')
    expect(ok).toBe(true)
    const t = getBgTask(id)!
    expect(t.exitCode).toBe(0)
    expect(t.endedAt).not.toBeNull()
    expect(t.buffer).toContain('BG_DONE_MARK')
  })

  it('非零退出 → failed 且保留 exitCode', async () => {
    const id = startBgTask({
      sessionId: 's1', title: '失败命令', command: 'echo boom; exit 3', cwd: process.cwd(),
    })
    expect(await waitFor(() => getBgTask(id)?.status === 'failed')).toBe(true)
    const t = getBgTask(id)!
    expect(t.exitCode).toBe(3)
    expect(t.buffer).toContain('boom')
  })

  it('取消后状态保持 cancelled —— 迟到的 exit 事件不得把它改写成 failed', async () => {
    const id = startBgTask({
      sessionId: 's1', title: '长任务', command: 'sleep 5', cwd: process.cwd(),
    })
    expect(getBgTask(id)?.status).toBe('running')
    expect(cancelBgTask(id).ok).toBe(true)
    expect(getBgTask(id)?.status).toBe('cancelled')

    // 进程真的收到 SIGTERM 后会再触发 exit（code 143/null）。
    // settle 必须幂等：晚到的事件不能覆盖 cancelled。
    await new Promise((r) => setTimeout(r, 300))
    expect(getBgTask(id)?.status).toBe('cancelled')
  })

  it('增量读不重复：cursor 之后的字节才返回', async () => {
    const id = startBgTask({
      sessionId: 's1', title: '分段输出', command: 'echo ONE; sleep 0.25; echo TWO', cwd: process.cwd(),
    })
    expect(await waitFor(() => (getBgTask(id)?.buffer || '').includes('ONE'))).toBe(true)
    const first = readBgTaskOutput(id, 0)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.text).toContain('ONE')
    const cursor = first.next

    const second = readBgTaskOutput(id, cursor)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.text).not.toContain('ONE')

    expect(await waitFor(() => (getBgTask(id)?.buffer || '').includes('TWO'))).toBe(true)
    const third = readBgTaskOutput(id, cursor)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    // 从同一 cursor 再读：拿到 TWO，且绝不重复 ONE
    expect(third.text).toContain('TWO')
    expect(third.text).not.toContain('ONE')
  })

  it('lastOutputAt 随输出推进（"在跑 vs 卡住"的唯一信号；没输出就一直等于启动时刻）', async () => {
    const id = startBgTask({
      sessionId: 's1', title: 't', command: 'sleep 0.3; echo X; sleep 0.3; echo Y', cwd: process.cwd(),
    })
    const created = getBgTask(id)!.lastOutputAt
    expect(await waitFor(() => (getBgTask(id)?.buffer || '').includes('X'))).toBe(true)
    expect(getBgTask(id)!.lastOutputAt).toBeGreaterThan(created)
  })

  it('并发上限：超过上限抛错，且不静默排队', async () => {
    const ids: string[] = []
    for (let i = 0; i < BG_MAX_LIVE_TASKS; i++) {
      ids.push(startBgTask({ sessionId: 's1', title: `t${i}`, command: 'sleep 5', cwd: process.cwd() }))
    }
    expect(() =>
      startBgTask({ sessionId: 's1', title: 'over', command: 'sleep 5', cwd: process.cwd() }),
    ).toThrow(/上限/)

    for (const id of ids) cancelBgTask(id)
  })

  it('输出缓冲有上限：超长输出只保留尾部', async () => {
    // 写 150KB（> 100KB 上限），末尾带标记
    const id = startBgTask({
      sessionId: 's1',
      title: '大输出',
      command: `yes 0123456789 | head -c 150000; echo TAIL_MARK`,
      cwd: process.cwd(),
    })
    expect(await waitFor(() => getBgTask(id)?.status === 'done')).toBe(true)
    const t = getBgTask(id)!
    expect(t.buffer.length).toBeLessThanOrEqual(BG_MAX_BUFFER)
    expect(t.buffer).toContain('TAIL_MARK')
    // 累计字节数不受裁剪影响
    expect(t.bytes).toBeGreaterThan(BG_MAX_BUFFER)
  })

  it('完成事件带上任务视图（P2 续跑的信号源）', async () => {
    const seen: string[] = []
    const off = onBgTaskDone((v) => seen.push(`${v.id}:${v.status}`))
    const id = startBgTask({ sessionId: 's1', title: 'x', command: 'true', cwd: process.cwd() })
    expect(await waitFor(() => seen.length > 0)).toBe(true)
    off()
    expect(seen[0]).toBe(`${id}:done`)
  })

  it('列表按会话过滤，且新任务在前', () => {
    const a = startBgTask({ sessionId: 'sa', title: 'A', command: 'sleep 5', cwd: process.cwd() })
    const b = startBgTask({ sessionId: 'sb', title: 'B', command: 'sleep 5', cwd: process.cwd() })
    const onlyA = listBgTasks('sa')
    expect(onlyA.map((t) => t.id)).toEqual([a])
    expect(listBgTasks().map((t) => t.id)).toEqual([b, a])
    cancelBgTask(a)
    cancelBgTask(b)
  })

  it('删除运行中的任务 → 进程真的被杀，记录消失（不能留孤儿进程）', async () => {
    const id = startBgTask({ sessionId: 's1', title: 'x', command: 'sleep 5', cwd: process.cwd() })
    const proc = getBgTask(id)!.proc!
    expect(deleteBgTask(id).ok).toBe(true)
    expect(getBgTask(id)).toBeUndefined()
    // 进程必须收到信号：kill 后 300ms 内应已退出
    expect(await waitFor(() => proc.killed || proc.exitCode !== null || proc.signalCode !== null, 1500)).toBe(true)
  })

  it('删除已结束任务 → 只删记录；删不存在的任务 → 报错而不是静默成功', async () => {
    const id = startBgTask({ sessionId: 's1', title: 'x', command: 'true', cwd: process.cwd() })
    expect(await waitFor(() => getBgTask(id)?.status === 'done')).toBe(true)
    expect(deleteBgTask(id).ok).toBe(true)
    expect(getBgTask(id)).toBeUndefined()
    expect(deleteBgTask('no-such-id').ok).toBe(false)
  })

  it('清理只删已结束的任务', async () => {
    const running = startBgTask({ sessionId: 's1', title: 'r', command: 'sleep 5', cwd: process.cwd() })
    const done = startBgTask({ sessionId: 's1', title: 'd', command: 'true', cwd: process.cwd() })
    expect(await waitFor(() => getBgTask(done)?.status === 'done')).toBe(true)
    expect(clearFinishedBgTasks()).toBe(1)
    expect(getBgTask(done)).toBeUndefined()
    expect(getBgTask(running)?.status).toBe('running')
    cancelBgTask(running)
  })
})
