/**
 * 授权决策真值表（I14，2026-09-24）
 *
 * 修掉的 bug（老板实机反馈"选了本窗口全部授权，可为什么一出来一个命令就弹授权框"）：
 *   · `auto` 档**完全不读**会话白名单 → 点过「本会话全部允许」照样逐个弹窗；
 *   · `accept-edits` 档 `loadSessionApprovals()` **调了但从不使用**返回值（死调用）；
 *   · 只有 `prompt` 档读白名单 → 同一个按钮在不同档位行为不一致。
 *
 * 断言方式：`decideToolApproval` 是纯函数 → **逐格**覆盖
 * 「档位 × 会话白名单 × 工具风险」三维，而不是只测一条快乐路径。
 * 一个"永远 allow"或"永远 confirm"的实现必须在这张表上挂掉。
 */
import { describe, it, expect } from 'vitest'
import { decideToolApproval, type ApprovalContext, type ToolRisk } from './permission'

const Risk = (r: ToolRisk) => (_n: string, _a: string): ToolRisk => r

function ctx(over: Partial<ApprovalContext> & { mode: ApprovalContext['mode'] }): ApprovalContext {
  return {
    mode: over.mode,
    permissionLevel: over.permissionLevel ?? 'sandbox',
    sessionApproved: over.sessionApproved ?? false,
    sessionBlockApproved: over.sessionBlockApproved ?? false,
    classify: over.classify ?? Risk('ask'),
  }
}

describe('decideToolApproval —— 只查看档（deny）', () => {
  it('一律拒绝，会话白名单也不能推翻', () => {
    expect(decideToolApproval('shell_exec', 'ls', ctx({ mode: 'deny' }))).toBe('deny')
    expect(decideToolApproval('shell_exec', 'ls', ctx({ mode: 'deny', sessionApproved: true }))).toBe('deny')
    expect(decideToolApproval('file_write', 'x', ctx({ mode: 'deny', permissionLevel: 'full' }))).toBe('deny')
  })
})

describe('decideToolApproval —— block 恒拦（放在白名单之前）', () => {
  const modes: ApprovalContext['mode'][] = ['auto', 'prompt', 'accept-edits']
  it.each(modes)('%s 档 + 白名单已批准 + block → 仍然 confirm', (mode) => {
    expect(
      decideToolApproval('file_delete', '{}', ctx({ mode, sessionApproved: true, classify: Risk('block') })),
    ).toBe('confirm')
  })
  it('full 权限 + block → 仍然 confirm', () => {
    expect(
      decideToolApproval('file_delete', '{}', ctx({ mode: 'auto', permissionLevel: 'full', classify: Risk('block') })),
    ).toBe('confirm')
  })
})

describe('decideToolApproval —— "拦一次后记住"（老板 2026-09-24 17:57 裁决）', () => {
  it('非删除的 block 类被显式允许过一次 → 本会话不再拦（任何档位）', () => {
    // 2026-10-18 起 file_delete 已移出"可记住"范围（下面单列），这里只覆盖非删除类
    expect(
      decideToolApproval('shell_exec', 'rm -rf /tmp/x', ctx({ mode: 'prompt', sessionBlockApproved: true, classify: Risk('block') })),
    ).toBe('allow')
    expect(
      decideToolApproval('skill_install', '{}', ctx({ mode: 'accept-edits', sessionBlockApproved: true, classify: Risk('block') })),
    ).toBe('allow')
  })

  it('🔴 删除类永不被"记住"放行 —— 任何档位都必须每次确认（老板 2026-10-18 裁决）', () => {
    // 这是不变量：删除是唯一不可逆操作，不能继承任何会话级记忆。
    // bug 存在时（旧逻辑 sessionBlockApproved 排在前）这里会返回 allow → 断言失败。
    for (const mode of ['auto', 'prompt', 'accept-edits'] as const) {
      expect(
        decideToolApproval('file_delete', '{}', ctx({ mode, sessionBlockApproved: true, sessionApproved: true, classify: Risk('block') })),
      ).toBe('confirm')
    }
    // 小写 delete 结尾的其它删除类工具同样恒问
    expect(
      decideToolApproval('bulk_delete', '{}', ctx({ mode: 'auto', sessionBlockApproved: true, classify: Risk('block') })),
    ).toBe('confirm')
  })

  it('deny 档仍拒绝（记住不能推翻"仅查看"）', () => {
    expect(
      decideToolApproval('file_delete', '{}', ctx({ mode: 'deny', sessionBlockApproved: true, classify: Risk('block') })),
    ).toBe('deny')
  })
  it('普通会话白名单（「本会话全部允许」按钮）不覆盖 block —— 两者是两种记录', () => {
    expect(
      decideToolApproval('file_delete', '{}', ctx({ mode: 'auto', sessionApproved: true, sessionBlockApproved: false, classify: Risk('block') })),
    ).toBe('confirm')
  })
  it('未记住（默认 undefined）→ block 仍 confirm', () => {
    expect(decideToolApproval('file_delete', '{}', ctx({ mode: 'auto', classify: Risk('block') }))).toBe('confirm')
  })
})

describe('decideToolApproval —— auto 档（自动执行：除 block 外全放行）', () => {
  it('ask 类直接放行（老板裁决"除删除外全放行"）', () => {
    expect(decideToolApproval('shell_exec', 'unknown-cmd', ctx({ mode: 'auto', classify: Risk('ask') }))).toBe('allow')
  })
  it('allow 类放行', () => {
    expect(decideToolApproval('shell_exec', 'ls', ctx({ mode: 'auto', classify: Risk('allow') }))).toBe('allow')
  })
  it('★ 白名单在 auto 档也生效（旧实现此处恒 confirm，就是老板报的 bug）', () => {
    expect(
      decideToolApproval('shell_exec', 'unknown-cmd', ctx({ mode: 'auto', sessionApproved: true, classify: Risk('ask') })),
    ).toBe('allow')
  })
})

describe('decideToolApproval —— ask 档（执行前询问）', () => {
  it('未授权：ask 类要确认（该档承诺"每个敏感操作都先问"）', () => {
    expect(decideToolApproval('shell_exec', 'unknown-cmd', ctx({ mode: 'prompt', classify: Risk('ask') }))).toBe('confirm')
    expect(decideToolApproval('shell_exec', 'ls', ctx({ mode: 'prompt', classify: Risk('allow') }))).toBe('confirm')
  })
  it('★ 「本会话全部允许」后：ask 类放行（按钮的语义就在这）', () => {
    expect(
      decideToolApproval('shell_exec', 'unknown-cmd', ctx({ mode: 'prompt', sessionApproved: true, classify: Risk('ask') })),
    ).toBe('allow')
  })
})

describe('decideToolApproval —— accept-edits 档', () => {
  it('文件编辑放行，命令要确认（旧行为回归）', () => {
    expect(decideToolApproval('file_write', '{}', ctx({ mode: 'accept-edits', classify: Risk('allow') }))).toBe('allow')
    expect(decideToolApproval('multi_edit', '{}', ctx({ mode: 'accept-edits', classify: Risk('allow') }))).toBe('allow')
    expect(decideToolApproval('shell_exec', 'npm run build', ctx({ mode: 'accept-edits', classify: Risk('allow') }))).toBe('confirm')
  })
  it('★ 白名单也生效（旧实现 loadSessionApprovals() 是死调用，白名单被忽略）', () => {
    expect(
      decideToolApproval('shell_exec', 'unknown-cmd', ctx({ mode: 'accept-edits', sessionApproved: true, classify: Risk('ask') })),
    ).toBe('allow')
  })
})

describe('decideToolApproval —— 会话权限档 full', () => {
  it('非 block 一律放行（prompt 档 + full 也一样，旧实现已如此）', () => {
    expect(
      decideToolApproval('shell_exec', 'ls', ctx({ mode: 'prompt', permissionLevel: 'full', classify: Risk('ask') })),
    ).toBe('allow')
    expect(
      decideToolApproval('file_write', '{}', ctx({ mode: 'prompt', permissionLevel: 'full', classify: Risk('allow') })),
    ).toBe('allow')
  })
})

describe('decideToolApproval —— 分类器必须被真的调用（防"忘了接上分类器"）', () => {
  it('把 classify 的入参原样转发给工具名与参数', () => {
    const seen: Array<[string, string]> = []
    decideToolApproval(
      'shell_exec',
      '{"command":"x"}',
      ctx({
        mode: 'auto',
        classify: (n, a) => {
          seen.push([n, a])
          return 'allow'
        },
      }),
    )
    expect(seen).toEqual([['shell_exec', '{"command":"x"}']])
  })
})
