/**
 * humanizeApiError 文案契约（2026-10-22，问题 A2 / A1 回归防线）
 *
 * 为什么必须有：分类器给 `connection` / `timeout` / `tool_sequence` / `unknown` 标的是
 * `retryable: true`（会退避重试 3 次），而历史文案把它们塞进 default：
 * 「这类错误重试不会变好」——**提示与行为自相矛盾**，用户照提示停手，实际系统正在重试。
 * 断言写成不变量：只要是可重试的 reason，文案里就不许出现"重试不会变好"这类断言。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { humanizeApiError } from './agent.js'
import { classifyApiError, type FailoverReason } from './error-classifier.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 9 类 reason 的最小样本（触发分类器的真实形态） */
const SAMPLES: Record<FailoverReason, unknown> = {
  billing: Object.assign(new Error('402 Payment Required: Insufficient Balance'), { status: 402 }),
  auth: Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 }),
  rate_limit: Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
  context_overflow: Object.assign(new Error('maximum context length exceeded'), { status: 413 }),
  server_error: Object.assign(new Error('502 Bad Gateway'), { status: 502 }),
  timeout: new Error('request timeout'),
  connection: new Error('fetch failed: ENOTFOUND api.example.com'),
  tool_sequence: new Error('An assistant message with tool_calls must be followed by tool messages'),
  unknown: new Error('something odd happened'),
}

describe('humanizeApiError 文案契约', () => {
  it('9 类 reason 都能给出非空提示，且都带详情行', () => {
    for (const reason of Object.keys(SAMPLES) as FailoverReason[]) {
      const classified = classifyApiError(SAMPLES[reason])
      expect(classified.reason, `样本应被分类为 ${reason}`).toBe(reason)
      const text = humanizeApiError(classified)
      expect(text.trim().length, `${reason} 文案为空`).toBeGreaterThan(10)
      expect(text, `${reason} 缺少详情行`).toContain('详情:')
    }
  })

  it('不变量：可重试的错误，文案不许说"重试不会变好"', () => {
    for (const reason of Object.keys(SAMPLES) as FailoverReason[]) {
      const classified = classifyApiError(SAMPLES[reason])
      if (!classified.retryable) continue
      const text = humanizeApiError(classified)
      expect(text, `${reason} 可重试，文案却断言重试无效`).not.toMatch(/重试(也)?不会变好|重试没有用|不要重试/)
    }
  })

  it('网络类错误必须指向网络/代理，而不是"请求被拒绝"', () => {
    const conn = humanizeApiError(classifyApiError(SAMPLES.connection))
    expect(conn).toMatch(/网络|代理/)
    expect(conn).not.toContain('请求被拒绝')

    const timeout = humanizeApiError(classifyApiError(SAMPLES.timeout))
    expect(timeout).toMatch(/超时/)
    expect(timeout).not.toContain('请求被拒绝')
  })

  it('余额不足必须给出"充值 / 换 Key"的出路', () => {
    const text = humanizeApiError(classifyApiError(SAMPLES.billing))
    expect(text).toMatch(/余额不足|额度已用尽/)
    expect(text).toMatch(/充值|换一个可用额度/)
  })
})

describe('A1 回归防线：错误提示不得走 content 通道', () => {
  /**
   * 为什么用源码断言：这三个 emit 点都在 agent 主循环深处（需要真实 LLM 才能跑到），
   * 单测无法触发。但回归形态是**确定的文本**——只要重新出现 `'content'` + `error: true`
   * 的组合，就说明有人把提示又写回了正文通道（会顶掉本轮答案）。
   */
  it("agent.ts 里不得出现 `emitSSE(ctx, 'content', { ... error: true })`", () => {
    const src = readFileSync(join(HERE, 'agent.ts'), 'utf8')
    // 去掉注释行后再匹配，避免把说明文字当实现
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    const bad = /emitSSE\(\s*ctx\s*,\s*['"]content['"]\s*,\s*\{[\s\S]{0,200}?error\s*:\s*true/.test(code)
    expect(bad, '错误提示又回到 content 通道了：会把已产出的答案覆盖成错误文案').toBe(false)
  })

  it('错误提示随 error 事件下发 hint（三处都应带 hint 字段）', () => {
    const src = readFileSync(join(HERE, 'agent.ts'), 'utf8')
    const hints = src.match(/hint:\s*humanizeApiError\(/g) || []
    const hintsJoined = src.match(/hint:\s*\[/g) || []
    expect(hints.length + hintsJoined.length, '至少 3 处 error 事件应携带 hint').toBeGreaterThanOrEqual(3)
  })
})
