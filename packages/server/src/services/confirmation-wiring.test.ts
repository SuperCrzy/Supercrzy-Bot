/**
 * 「不可逆操作永不自动放行」的**接线**断言（2026-10-22）
 *
 * 纯函数测试只能证明 `resolveConfirmationWait` 会拒绝自动放行，**证明不了调用方传了
 * irreversible** —— 少传一个参数，单测全绿、线上照旧 5 秒后删库。这正是本项目
 * 反复踩过的"单测全绿 ≠ 集成正确"。
 *
 * 所以这里做源码级接线断言：读真实文件，检查关键调用点/条件表达式是否还在。
 * 这类断言脆弱（改格式会红），但红了只需人看一眼 —— 比静默失同步好。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { PERMISSION_TIERS as SERVER_TIERS } from './permission'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const AGENT = read('./agent.ts')
const TOOL_CALL_BLOCK = read('../../../client/src/components/chat/ToolCallBlock.vue')
const APPROVAL_FLOATING = read('../../../client/src/components/chat/ToolApprovalFloating.vue')
const FLOW_RENDERER = read('../../../client/src/components/chat/MessageFlowRenderer.vue')
const CLIENT_PERMISSION = read('../../../client/src/utils/permission.ts')

describe('后端接线：等待确认时传入 irreversible', () => {
  it('🔴 waitForToolConfirmation 的调用点必须带 irreversible（否则 5 秒后自动执行）', () => {
    const callLines = AGENT
      .split('\n')
      .filter((l) => /await waitForToolConfirmation\(/.test(l))
    expect(callLines.length, '找不到等待确认的调用点，可能是重命名了').toBeGreaterThan(0)
    for (const line of callLines) {
      expect(line, `调用点没传 irreversible：${line.trim()}`).toContain('irreversible')
    }
  })

  it('调用点同时传了超时常量（不允许某处偷偷用短超时）', () => {
    const callLines = AGENT.split('\n').filter((l) => /await waitForToolConfirmation\(/.test(l))
    for (const line of callLines) {
      expect(line).toContain('CONFIRMATION_TIMEOUT_MS')
    }
  })

  it('waitForToolConfirmation 内部走 resolveConfirmationWait（不再自己算 autoAllow）', () => {
    expect(AGENT).toContain('resolveConfirmationWait(')
    expect(AGENT, '旧的 `const autoAllow = autoSec > 0` 写法会绕过不可逆判断').not.toMatch(/const\s+autoAllow\s*=\s*autoSec\s*>\s*0/)
  })
})

describe('前端接线：不可逆不倒计时、不自动提交放行', () => {
  it('🔴 ToolCallBlock 倒计时条件排除 irreversible', () => {
    expect(TOOL_CALL_BLOCK).toMatch(/props\.autoApproveSeconds\s*>\s*0\s*&&\s*!props\.irreversible/)
  })

  it('🔴 ToolApprovalFloating 倒计时条件排除 high 风险', () => {
    expect(APPROVAL_FLOATING).toMatch(/props\.autoApproveSeconds\s*>\s*0\s*&&\s*riskLevel\.value\s*!==\s*'high'/)
  })

  it('MessageFlowRenderer 的 toolBlockAttrs 传了 irreversible（两处渲染共用此映射）', () => {
    const fn = FLOW_RENDERER.slice(FLOW_RENDERER.indexOf('function toolBlockAttrs'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body, 'toolBlockAttrs 是 ToolCallBlock props 的单一来源，漏了这里两处渲染都失效').toContain('irreversible')
  })
})

describe('两档定义双份拷贝不能失同步（G12/D4 老问题）', () => {
  it('initDatabase 真的调用了档位迁移（写了函数却没人调 = 存量 auto 永远不改）', () => {
    const DATABASE = read('./database.ts')
    expect(DATABASE).toMatch(/retireAutoPermissionTier\(db\)/)
  })

  it('客户端 PERMISSION_TIERS 与服务端一致', () => {
    const m = CLIENT_PERMISSION.match(/PERMISSION_TIERS[^=]*=\s*\[([^\]]*)\]/)
    expect(m, '客户端 utils/permission.ts 里找不到 PERMISSION_TIERS').toBeTruthy()
    const clientTiers = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    expect(clientTiers, '客户端与服务端档位数不一致').toEqual([...SERVER_TIERS])
  })

  it('两份拷贝都不含已废弃的 auto 档位', () => {
    expect([...SERVER_TIERS]).not.toContain('auto')
    expect(CLIENT_PERMISSION).not.toMatch(/PermissionTier\s*=\s*'readonly'\s*\|\s*'ask'\s*\|\s*'auto'/)
  })
})
