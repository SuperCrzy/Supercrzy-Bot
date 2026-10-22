/**
 * 模型上下文窗口（2026-10-22，A 项）
 *
 * 背景（老板：「上下文用量是不是可以设置默认 1M 的？显示不准确」）：
 *   DeepSeek-V4 全系官方 CONTEXT LENGTH = **1M**，而代码里 `/deepseek/i → 128_000`
 *   一刀切，且 `custom_models.context_window`（DB 值，优先级最高）存着 128000。
 *
 * 后果不只是显示：`shouldCompress` 阈值 = window × 0.55 ⇒ 70.4K 就压缩，
 * 1M 的能力只用了 7%。所以这组测试同时钉「映射对不对」和「压缩阈值真的跟着变」。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOWS,
  contextWindowFromTable,
  resolveContextWindow,
} from './model-context-window'
import { shouldCompress } from './context-compressor'

describe('内置映射：DeepSeek-V4 必须是 1M', () => {
  it('v4-pro / v4-flash 都是 1_048_576', () => {
    expect(contextWindowFromTable('deepseek-v4-pro')).toBe(1_048_576)
    expect(contextWindowFromTable('deepseek-v4-flash')).toBe(1_048_576)
  })

  it('legacy 全名 deepseek-v4-flash-vision-exp 也是 1M', () => {
    expect(contextWindowFromTable('deepseek-v4-flash-vision-exp')).toBe(1_048_576)
  })

  it('官方新名 deepseek-flash（= V4.1-Flash）也是 1M', () => {
    expect(contextWindowFromTable('deepseek-flash')).toBe(1_048_576)
  })

  it('🔴 旧世代不能被 V4 带飞：v3.2 / chat / r1 仍是 128K', () => {
    for (const m of ['deepseek-v3.2', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-v3.1-terminus']) {
      expect(contextWindowFromTable(m), `${m} 不该是 1M`).toBe(128_000)
    }
  })

  it('顺序是语义：v4 规则必须排在通用 deepseek 之前（否则永远轮不到）', () => {
    const idx = (re: RegExp) => MODEL_CONTEXT_WINDOWS.findIndex(([r]) => r.source === re.source)
    expect(idx(/deepseek-v4/i)).toBeLessThan(idx(/deepseek/i))
  })

  it('未收录模型返回 null（交给调用方兜底）', () => {
    expect(contextWindowFromTable('some-unknown-model')).toBeNull()
    expect(contextWindowFromTable('')).toBeNull()
  })
})

describe('优先级：DB 用户配置 > 内置映射 > 默认', () => {
  it('DB 值优先', () => {
    expect(resolveContextWindow('deepseek-v4-flash', 999_000)).toBe(999_000)
    expect(resolveContextWindow('some-unknown-model', 64_000)).toBe(64_000)
  })

  it('DB 值缺失 / 0 / 负数 / NaN ⇒ 回落内置映射（0 会让阈值变 0，必须排除）', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      expect(resolveContextWindow('deepseek-v4-flash', bad as any), `dbValue=${bad}`).toBe(1_048_576)
    }
  })

  it('全都没命中 ⇒ 默认 128K', () => {
    expect(resolveContextWindow('some-unknown-model', null)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('空模型名 ⇒ 默认（不抛异常）', () => {
    expect(resolveContextWindow('', null)).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('🔴 压缩阈值跟着窗口走（1M 真的解锁，不只是显示）', () => {
  // 中文按 2 tokens/字估算 ⇒ 这串约 10 万 tokens
  const hundredK = { role: 'user' as const, content: '测'.repeat(50_000) }

  it('128K 窗口：10 万 tokens 已超过 55% ⇒ 触发压缩', () => {
    expect(shouldCompress([hundredK], 128_000)).toBe(true)
  })

  it('1M 窗口：同样的 10 万 tokens 远未到 55% ⇒ 不压缩', () => {
    expect(shouldCompress([hundredK], 1_048_576)).toBe(false)
  })

  it('阈值数字对得上：128K → 70,400；1M → 576,717', () => {
    expect(Math.round(128_000 * 0.55)).toBe(70_400)
    expect(Math.round(1_048_576 * 0.55)).toBe(576_717)
  })
})

describe('存量迁移：custom_models 里的 128000 抬到 1M', () => {
  let Database: new (path: string) => any
  let upgrade: typeof import('./database').upgradeDeepseekV4ContextWindow

  beforeAll(async () => {
    Database = (await import('better-sqlite3') as any).default
    // config 在模块加载时读 env，必须在 import 前设
    process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'supercrzy-cw-ws-'))
    process.env.DB_PATH = join(tmpdir(), `supercrzy-cw-${Date.now()}.db`)
    upgrade = (await import('./database')).upgradeDeepseekV4ContextWindow
  })

  function memDb() {
    const mem = new Database(':memory:')
    mem.exec(`CREATE TABLE custom_models (id TEXT, model_id TEXT, context_window INTEGER)`)
    return mem
  }
  const insert = (mem: any, modelId: string, cw: number) =>
    mem.prepare('INSERT INTO custom_models (id, model_id, context_window) VALUES (?, ?, ?)').run(modelId, modelId, cw)
  const cwOf = (mem: any, modelId: string) =>
    (mem.prepare('SELECT context_window FROM custom_models WHERE model_id = ?').get(modelId) as any)?.context_window

  it('🔴 v4 系列 128000 → 1048576', () => {
    const mem = memDb()
    insert(mem, 'deepseek-v4-flash', 128000)
    insert(mem, 'deepseek-v4-pro', 128000)
    expect(upgrade(mem)).toBe(2)
    expect(cwOf(mem, 'deepseek-v4-flash')).toBe(1_048_576)
    expect(cwOf(mem, 'deepseek-v4-pro')).toBe(1_048_576)
    mem.close()
  })

  it('🔴 旧世代不动（它们真的是 128K）', () => {
    const mem = memDb()
    insert(mem, 'deepseek-v3.2', 128000)
    insert(mem, 'deepseek-chat', 128000)
    expect(upgrade(mem)).toBe(0)
    expect(cwOf(mem, 'deepseek-v3.2')).toBe(128000)
    mem.close()
  })

  it('用户手改过的其它值不覆盖（有意为之）', () => {
    const mem = memDb()
    insert(mem, 'deepseek-v4-flash', 200_000)
    expect(upgrade(mem)).toBe(0)
    expect(cwOf(mem, 'deepseek-v4-flash')).toBe(200_000)
    mem.close()
  })

  it('deepseek-flash（官方新名）也升级', () => {
    const mem = memDb()
    insert(mem, 'deepseek-flash', 128000)
    expect(upgrade(mem)).toBe(1)
    expect(cwOf(mem, 'deepseek-flash')).toBe(1_048_576)
    mem.close()
  })

  it('幂等：第二次改 0 行', () => {
    const mem = memDb()
    insert(mem, 'deepseek-v4-flash', 128000)
    expect(upgrade(mem)).toBe(1)
    expect(upgrade(mem)).toBe(0)
    mem.close()
  })

  it('表不存在时不抛异常', () => {
    const mem = new Database(':memory:')
    expect(() => upgrade(mem)).not.toThrow()
    expect(upgrade(mem)).toBe(0)
    mem.close()
  })
})
