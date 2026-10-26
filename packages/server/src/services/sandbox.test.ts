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
import { SANDBOX_PROBE_PROFILE, buildSandboxProfile, detectSandboxExec, markSandboxUnavailable, pathUnder } from './sandbox'

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

/**
 * 路径归属判定（2026-10-26）。
 *
 * 钉住的是 Windows 实机报的那个 bug：`resolved.startsWith(a + '/')` 在 Windows 上
 * 拿 `C:\...\Documents` 拼出 `C:\...\Documents/`（反斜杠 + 正斜杠），永远匹配不到，
 * 于是**每一个**文件路径都判越权 —— 包括项目根自己，且与 full 授权无关。
 *
 * 用纯字符串函数测，是因为 `resolve()` 会把 `C:\Users\x` 在 macOS/Linux 上解析成本地路径，
 * 真实 Windows 路径走不了完整链路。而 split-brain 恰恰只出在比较这一步。
 */
describe('pathUnder：跨平台路径归属', () => {
  it('Windows 反斜杠：子路径在父目录下', () => {
    expect(pathUnder('C:\\Users\\x\\Documents\\a.txt', 'C:\\Users\\x\\Documents')).toBe(true)
  })

  it('Windows：与父目录完全相同', () => {
    expect(pathUnder('C:\\Users\\x\\Documents', 'C:\\Users\\x\\Documents')).toBe(true)
  })

  it('Windows：分隔符混用（一半 \\ 一半 /）也应判定为在其下', () => {
    expect(pathUnder('C:/Users/x/Documents/a.txt', 'C:\\Users\\x\\Documents')).toBe(true)
    expect(pathUnder('C:\\Users\\x\\Documents\\a.txt', 'C:/Users/x/Documents')).toBe(true)
  })

  it('Windows：前缀相似但不同目录 —— 不能误判（x vs xy）', () => {
    expect(pathUnder('C:\\Users\\xy\\a.txt', 'C:\\Users\\x')).toBe(false)
  })

  it('POSIX：原有行为不变', () => {
    expect(pathUnder('/Users/x/proj/a.ts', '/Users/x/proj')).toBe(true)
    expect(pathUnder('/Users/x/proj', '/Users/x/proj')).toBe(true)
    expect(pathUnder('/Users/x/projx/a.ts', '/Users/x/proj')).toBe(false)
    expect(pathUnder('/etc/passwd', '/Users/x')).toBe(false)
  })

  it('结尾多余斜杠不影响判定', () => {
    expect(pathUnder('C:\\Users\\x\\a.txt', 'C:\\Users\\x\\')).toBe(true)
    expect(pathUnder('/Users/x/a.ts', '/Users/x/')).toBe(true)
  })

  it('空父目录一律不放行（不能因为空串而变成"匹配一切"）', () => {
    expect(pathUnder('/anything', '')).toBe(false)
    expect(pathUnder('', '')).toBe(false)
  })
})
