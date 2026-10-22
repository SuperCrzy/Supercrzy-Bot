/**
 * 硬沙箱可用性判定的不变量（2026-10-22）
 *
 * 起因（老板实机）：shell_exec 报「沙箱启动失败」，模型改用持久终端绕开。
 * 根因是探测假阳性：旧探针 `(version 1) (allow default)` 等于**不收紧**，
 * 在被外层沙箱包住的进程树里照样 exit 0，于是 sandboxed=true，真实执行时
 * `sandbox_apply: Operation not permitted`（exit 71）⇒ 每条命令都失败。
 *
 * 这里断言的是"判据本身"，不是 sandbox-exec 在本机能不能用（换机器结果会变）：
 *   - 探针**必须带一条收紧规则** —— 否则它证明不了"能应用真实策略"；
 *   - 运行期判定不可用后，本进程不再重复探测（避免每条命令都撞一次 71）。
 */
import { describe, it, expect } from 'vitest'
import { SANDBOX_PROBE_PROFILE, buildSandboxProfile, detectSandboxExec, markSandboxUnavailable } from './sandbox'

describe('hard sandbox probe', () => {
  it('探针必须含收紧规则（deny）：只有 allow default 的探针会假阳性', () => {
    expect(SANDBOX_PROBE_PROFILE).toMatch(/\(deny\s/)
    // 回归守卫：曾经就是这一串
    expect(SANDBOX_PROBE_PROFILE).not.toBe("(version 1) (allow default)")
  })

  it('真实 profile 既收紧 home 又放行项目根（否则要么没保护、要么跑不了）', () => {
    const p = buildSandboxProfile()
    expect(p).toMatch(/\(deny file-read\* \(subpath "/)
    expect(p).toMatch(/\(allow file-read\* \(subpath "/)
  })

  it('运行期判定不可用后 detectSandboxExec 恒为 false（不再重复撞沙箱）', async () => {
    markSandboxUnavailable('unit-test')
    expect(await detectSandboxExec()).toBe(false)
    // 幂等：再标一次也不炸
    markSandboxUnavailable('unit-test-again')
    expect(await detectSandboxExec()).toBe(false)
  })
})
