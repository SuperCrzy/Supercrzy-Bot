/**
 * computer_use — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'

const tool: ToolDef = {
    name: 'computer_use',
    description: '操控用户电脑（截屏/点击/输入/按键/滚动/打开应用）。仅 full 权限可用，调用前需用户确认。action 可选：screenshot(截屏)/click(点击 x,y)/type(输入文本)/key(按键 combo)/scroll(滚动)/move(移动鼠标)/open(打开应用)。',
    category: 'system',
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作：screenshot / click / type / key / scroll / move / open' },
        args: { type: 'object', description: '参数：click 需 {x,y}；type 需 {text}；key 需 {combo}；scroll 需 {clicks}；move 需 {x,y}；open 需 {name}' },
      },
      required: ['action'],
    },
  async execute(args, ctx) {
    if (ctx?.permissionLevel !== 'full') {
      return '⛔ computer_use 需要 full 权限（设置中把会话权限调到「完全访问」才能操控电脑）\n\n授权路径：对话输入区下方权限选择器 → 选「完全访问」→ 重新发送消息'
    }
    const { callComputerUse } = await import('../services/computer-use')
    const action = String(args.action || '').trim()
    if (!action) return '❌ computer_use 需要提供 action（screenshot/click/type/key/scroll/move/open）'
    const params = { ...(args.args || {}) }
    try {
      const result = await callComputerUse(action, params)
      return result
    } catch (err: any) {
      const msg = String(err?.message || '')
      // macOS 权限不足（录屏/辅助功能）→ 给出具体授权步骤
      if (/permission|denied|screen recording|accessibility|TCC|not authorized/i.test(msg)) {
        return `❌ computer_use 需要 macOS 权限授权（当前被系统拒绝）\n\n授权步骤：\n1. 打开「系统设置 → 隐私与安全性」\n2. 录屏与屏幕录制：把 SUPERCRZY BOT 加入并开启\n3. 辅助功能：把 SUPERCRZY BOT 加入并开启\n4. 重启应用后重试`
      }
      return `❌ computer_use 调用失败: ${msg}`
    }
  },
}

export default tool
