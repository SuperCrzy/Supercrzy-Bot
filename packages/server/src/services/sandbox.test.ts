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
import { homedir } from 'os'
import { join } from 'path'
import { SANDBOX_PROBE_PROFILE, buildSandboxProfile, detectSandboxExec, markSandboxUnavailable, pathUnder, assertSafeFilePath, PROJECT_ROOT } from './sandbox'

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

/**
 * 权限档位的放行边界（2026-10-26）。
 *
 * 背景：Windows 实机报「full 权限下 file_write / file_read 全部路径越权」，
 * 真因是路径比较（见 pathUnder 用例）。但排查时又发现两个真正缺的放行项：
 *   - `~/.supercrzy`（任务日志与报告都写在这里）—— 不放行就意味着 agent 读不回
 *     自己刚写的东西，这正是报告里「读 .supercrzy 下自己刚写的报告被拦」；
 *   - `%TEMP%`（Windows 没有 /tmp）。
 *
 * 这里同时钉住**反向**约束：放行 home 下的内容目录，绝不能顺带放行 .ssh/.aws。
 * 只测"能放开"而不测"仍拦住"，等于给沙箱开了个后门还没人知道。
 */
describe('assertSafeFilePath：full 档放行边界', () => {
  const home = homedir()

  it('full 放行自己的运行期数据目录 ~/.supercrzy', () => {
    expect(assertSafeFilePath(join(home, '.supercrzy', 'logs', 'a.log'), { level: 'full' })).toBeNull()
  })

  it('full 放行 home 下的内容目录', () => {
    expect(assertSafeFilePath(join(home, 'Documents', 'a.md'), { level: 'full' })).toBeNull()
    expect(assertSafeFilePath(join(home, 'logs', 'a.log'), { level: 'full' })).toBeNull()
  })

  it('🔴 full 仍然拦住敏感目录（放行不等于放开）', () => {
    expect(assertSafeFilePath(join(home, '.ssh', 'id_rsa'), { level: 'full' })).not.toBeNull()
    expect(assertSafeFilePath(join(home, '.aws', 'credentials'), { level: 'full' })).not.toBeNull()
    expect(assertSafeFilePath(join(home, '.git', 'config'), { level: 'full' })).not.toBeNull()
  })

  it('🔴 full 仍然拦住凭据文件（任意位置）', () => {
    expect(assertSafeFilePath(join(home, 'Documents', '.env'), { level: 'full' })).not.toBeNull()
  })

  it('sandbox 档不放行 home 内容目录（只有 full 才放开）', () => {
    expect(assertSafeFilePath(join(home, 'Documents', 'a.md'), { level: 'sandbox' })).not.toBeNull()
  })

  it('项目根在 sandbox 档也放行（agent 的工作区）', () => {
    expect(assertSafeFilePath(join(PROJECT_ROOT, 'README.md'), { level: 'sandbox' })).toBeNull()
  })
})

/**
 * 大小写一致性（2026-10-26）。
 *
 * Windows 与 macOS(APFS 默认) 文件系统都**不敏感**：`.SSH` 与 `.ssh` 是同一个目录。
 * 修完路径比较后，`pathUnder` 在这些平台上按大小写不敏感比较 —— 若 SENSITIVE_DIR 还按
 * 敏感匹配，`.SSH` 就成了一条现成的绕过路径（比较放宽了、拦截没放宽）。
 * 两边必须同步放宽，这组用例钉住"放宽"与"仍有拦截"同时成立。
 */
describe('大小写：比较与拦截必须同宽', () => {
  const home = homedir()
  const ciFs = process.platform === 'win32' || process.platform === 'darwin'

  it('大小写变体的敏感目录同样拦住', () => {
    expect(assertSafeFilePath(join(home, '.SSH', 'id_rsa'), { level: 'full' })).not.toBeNull()
    expect(assertSafeFilePath(join(home, '.AWS', 'credentials'), { level: 'full' })).not.toBeNull()
  })

  it('大小写变体的凭据文件同样拦住', () => {
    expect(assertSafeFilePath(join(home, 'Documents', '.ENV'), { level: 'full' })).not.toBeNull()
  })

  it('大小写不敏感的平台上，路径变体不误判为越权', () => {
    if (!ciFs) return // Linux 大小写敏感，不适用
    expect(assertSafeFilePath(join(home, 'DOCUMENTS', 'a.md'), { level: 'full' })).toBeNull()
  })
})
