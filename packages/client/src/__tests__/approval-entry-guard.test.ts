/**
 * 授权入口守卫（#13，2026-10-14）
 *
 * #13 的根因不是"少写了一个 if"，而是**同一个概念在客户端被复制成了两份手写名单**：
 *   `ChatView.vue` 的 `SENSITIVE_TOOLS_SET`、`ToolCallBlock.vue` 的 `SENSITIVE_TOOLS`，
 *   两者都写死 3 项；而服务端 I2 之后由 `ToolDef.requiresApproval` 派生出 **7 项**
 *   （shell_exec / file_write / file_delete / memory_consolidate / multi_edit /
 *     skill_install / computer_use）。
 *
 * 失配的后果是一条静默故障链：
 *   服务端已把工具挂起等授权（`agent.ts` 下发 `status:'pending'`）
 *   → 客户端两个入口（浮动层 + 卡片内联按钮）都因名单不含该工具而**不渲染按钮**
 *   → 只能等 120s 超时 → 超时被当成 "deny" → 对模型说"用户拒绝执行此操作"
 *   → 模型换方案或放弃，用户只看到 BOT 卡了 2 分钟。
 * 实测损失：`computer_use` 被真实调用 30 次全部失败；`multi_edit` 还是常驻工具之一。
 *
 * 所以这条守卫锁的是**规则**：客户端不得再持有"敏感工具清单"这种派生数据，
 * 唯一真相只能是服务端下发的 `status`。
 */
import { describe, it, expect } from 'vitest'

import chatView from '../views/ChatView.vue?raw'
import toolCallBlock from '../components/chat/ToolCallBlock.vue?raw'

const FILES = [
  { name: 'views/ChatView.vue', src: chatView },
  { name: 'components/chat/ToolCallBlock.vue', src: toolCallBlock },
]

/** 去掉注释后再扫代码 —— 允许在注释里讨论这个历史概念 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('#13 授权入口守卫', () => {
  it('客户端不得再手写"敏感工具名单"（那会是服务端 7 项之外的第二份真相）', () => {
    const found: string[] = []
    for (const { name, src } of FILES) {
      const code = stripComments(src)
      for (const m of code.matchAll(/new Set\(\s*\[\s*['"]shell_exec/g)) {
        found.push(`${name}: ${m[0]}…`)
      }
      for (const m of code.matchAll(/(?:const|let|var)\s+SENSITIVE_TOOLS[A-Z_]*\s*=/g)) {
        found.push(`${name}: ${m[0]}`)
      }
    }
    expect(
      found,
      '客户端又出现了手写的敏感工具名单。它会与服务端的 7 项失配，' +
        '导致服务端已挂起的工具在界面上没有授权按钮（只能用超时兜底）。' +
        '判据应当只来自服务端下发的 status。',
    ).toEqual([])
  })

  it('两个授权入口都只按 pending 判（唯一真相来自服务端）', () => {
    expect(
      chatView,
      'ChatView 的待授权浮层不再按 status 判',
    ).toMatch(/n\.tool\.status\s*===\s*'pending'/)
    expect(
      toolCallBlock,
      'ToolCallBlock 的授权按钮不再按 status 判',
    ).toMatch(/v-if="status\s*===\s*'pending'"/)
  })

  it('授权按钮不得再叠名称白名单条件（反例守卫）', () => {
    // 若有人把 `&& isSensitive` / `&& SENSITIVE_TOOLS.has(...)` 加回来，这里变红
    const tpl = toolCallBlock.slice(0, toolCallBlock.indexOf('<script'))
    expect(tpl).toMatch(/v-if="status\s*===\s*'pending'"/)
    expect(tpl).not.toMatch(/v-if="status\s*===\s*'pending'\s*&&/)
  })
})
