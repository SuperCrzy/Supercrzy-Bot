/**
 * 权限档位只有一个决策点（D4，2026-10-22）
 *
 * 缺陷形态：同一套「存库值/历史值 → 用户可见档位」的映射在两端各写了一份
 * （server `services/permission.ts` 与 client `utils/permission.ts`）。
 * 两边是独立实现，改一处忘另一处就漂移 —— 而漂移的表现是
 * **界面显示"仅查看"，实际按"执行前询问"跑**（或反之）：用户以为锁上了其实没锁，
 * 从 UI 上完全看不出来。上一版靠注释"两处都要改"约束，等于靠人记。
 *
 * 现在的契约：
 *   1. 服务端 `resolveEffectiveTier` 是唯一决策点；
 *   2. `GET /api/settings` 直接把生效档位算好返回，三种历史写法（auto / deny / 空）
 *      都要被正确投影，前端拿到的就是最终值；
 *   3. 前端文件里**不许**再出现历史档位名（出现即说明映射被抄回去了）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-tier-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-tier-${Date.now()}.db`)

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const here = dirname(fileURLToPath(import.meta.url))
// src/routes → src → packages/server → packages ⇒ 前端 utils 的绝对路径
const CLIENT_PERMISSION_TS = join(here, '..', '..', '..', 'client', 'src', 'utils', 'permission.ts')

let app: Koa

beforeAll(async () => {
  const { initDatabase } = await import('../services/database')
  initDatabase()
  const { settingsRouter } = await import('../routes/settings')
  app = new Koa()
  app.use(bodyParser())
  app.use(settingsRouter.routes()).use(settingsRouter.allowedMethods())
})

afterAll(() => {
  rmSync(wsRoot, { recursive: true, force: true })
})

const setSetting = async (key: string, value: string) => {
  const { getDB } = await import('../services/database')
  getDB()
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run(key, value)
}

const getSettings = async () => {
  const res = await request(app.callback()).get('/api/settings')
  expect(res.status).toBe(200)
  return res.body
}

describe('resolveEffectiveTier —— 唯一决策点', () => {
  it('合法两档原样返回', async () => {
    const { resolveEffectiveTier } = await import('../services/permission')
    expect(resolveEffectiveTier('readonly')).toBe('readonly')
    expect(resolveEffectiveTier('ask')).toBe('ask')
  })

  it('历史值投影：deny → readonly；auto/accept-edits/prompt → ask', async () => {
    const { resolveEffectiveTier } = await import('../services/permission')
    expect(resolveEffectiveTier('deny')).toBe('readonly')
    expect(resolveEffectiveTier('auto')).toBe('ask')
    expect(resolveEffectiveTier('accept-edits')).toBe('ask')
    expect(resolveEffectiveTier('prompt')).toBe('ask')
  })

  it('没存档位时回退历史 toolApprovalMode；都没有 → ask（默认不锁）', async () => {
    const { resolveEffectiveTier } = await import('../services/permission')
    expect(resolveEffectiveTier(undefined, 'deny')).toBe('readonly')
    expect(resolveEffectiveTier(null, 'prompt')).toBe('ask')
    expect(resolveEffectiveTier(undefined, undefined)).toBe('ask')
    expect(resolveEffectiveTier('', '')).toBe('ask')
  })

  it('不认识的值不被当成档位（防止把垃圾值直接回显给用户）', async () => {
    const { resolveEffectiveTier } = await import('../services/permission')
    expect(resolveEffectiveTier('full')).toBe('ask')
    expect(resolveEffectiveTier(123)).toBe('ask')
  })
})

describe('显示与执行必须由同一套判断得出（防漂移的真正不变量）', () => {
  it('🔴 任意组合下：界面显示的档位与实际执行的档位，授权结果逐格一致', async () => {
    const { resolveEffectiveTier, resolveApprovalMode, tierToLegacyMode, decideToolApproval } =
      await import('../services/permission')
    const stored = [undefined, null, '', 'readonly', 'ask', 'deny', 'auto', 'accept-edits', 'prompt', '垃圾值']
    const legacy = [undefined, null, '', 'deny', 'auto', 'prompt', 'accept-edits']
    // 只比字符串会被历史别名绊住（'auto' 与 'prompt' 是同一行为，但字面不同），
    // 所以直接比**授权结果**：显示的档位与执行的档位，对同一批调用必须给出同样的 allow/confirm/deny。
    const cases: Array<{ tool: string; risk: 'allow' | 'ask' | 'block'; remembered: boolean }> = []
    for (const tool of ['file_read', 'shell_exec', 'file_delete', 'computer_use']) {
      for (const risk of ['allow', 'ask', 'block'] as const) {
        for (const remembered of [false, true]) cases.push({ tool, risk, remembered })
      }
    }
    const verdict = (mode: any, c: (typeof cases)[number]) =>
      decideToolApproval(c.tool, '{}', {
        mode,
        sessionApproved: false,
        sessionBlockApproved: c.remembered,
        classify: () => c.risk,
      })

    for (const s of stored as any[]) {
      for (const l of legacy as any[]) {
        const shown = resolveEffectiveTier(s, l) // 设置页显示的档位
        const enforced = resolveApprovalMode(s, l) // agent 实际按这个档位跑
        for (const c of cases) {
          expect(
            verdict(tierToLegacyMode(shown), c),
            `存 ${JSON.stringify(s)} / 历史 ${JSON.stringify(l)}：界面显示「${shown}」，` +
              `实际按「${enforced}」，对 ${c.tool}(${c.risk}) 的裁决不一致`,
          ).toBe(verdict(enforced, c))
        }
      }
    }
  })

  it('permissionTier 列里残留的 deny 永不被另一列解封（deny 优先）', async () => {
    const { resolveApprovalMode, resolveEffectiveTier } = await import('../services/permission')
    // 4 档时代：用户在 permissionTier 位置选了"一律拒绝"，toolApprovalMode 可能还是 auto
    expect(resolveApprovalMode('deny', 'auto')).toBe('deny')
    expect(resolveEffectiveTier('deny', 'auto')).toBe('readonly')
    // 反向同理：另一列写着 deny 时，这一列的宽容值不能把它顶掉
    expect(resolveApprovalMode('prompt', 'deny')).toBe('deny')
    expect(resolveEffectiveTier('ask', 'deny')).toBe('readonly')
  })
})

describe('GET /api/settings 直接返回生效档位（前端不再本地推算）', () => {
  it('存的是合法档位 → 原样返回', async () => {
    await setSetting('permissionTier', 'readonly')
    await setSetting('toolApprovalMode', 'prompt')
    expect((await getSettings()).permissionTier).toBe('readonly')
  })

  it('🔴 存的是历史值 deny → 返回 readonly（不是 deny、也不是 ask）', async () => {
    await setSetting('permissionTier', 'deny')
    const body = await getSettings()
    expect(body.permissionTier).toBe('readonly')
  })

  it('存的是历史值 auto → 返回 ask', async () => {
    await setSetting('permissionTier', 'auto')
    expect((await getSettings()).permissionTier).toBe('ask')
  })

  it('没有 permissionTier、只有 toolApprovalMode=deny → 返回 readonly', async () => {
    const { getDB } = await import('../services/database')
    getDB().prepare("DELETE FROM settings WHERE key = 'permissionTier'").run()
    await setSetting('toolApprovalMode', 'deny')
    expect((await getSettings()).permissionTier).toBe('readonly')
  })
})

describe('前端文件不得再抄一份映射（漂移免疫）', () => {
  it('client/src/utils/permission.ts 里不许出现历史档位名', () => {
    const src = readFileSync(CLIENT_PERMISSION_TS, 'utf8')
    // 历史档位名出现在前端 = 有人在本地又写了一遍映射（本轮 D4 删掉的正是这份）
    for (const legacy of ['accept-edits', "'deny'", '"deny"', "'auto'", '"auto"']) {
      expect(src.includes(legacy), `前端又出现了历史档位 ${legacy}，说明档位映射被抄回去了`).toBe(false)
    }
    // 决策入口不许再出现在前端
    expect(src).not.toMatch(/function\s+resolvePermissionTier/)
  })
})
