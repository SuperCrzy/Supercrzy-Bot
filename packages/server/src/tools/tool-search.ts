/**
 * tool_search — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { DEFERRED_TOOLS, getToolCatalog } from './deferred'

const tool: ToolDef = {
  name: 'tool_search',
  description: '发现按需加载的工具。核心工具已常驻无需搜索；当需要一个不在当前可用列表里的工具（如生成图片 generate_image、视频剪辑 video_edit、终端控制 terminal_*、桌面控制 computer_use、技能详情 skill_view 等）时，先用本工具搜索并加载其定义，随后即可正常调用。支持模糊匹配。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名或关键词，如 "image"、"terminal"、"git"；空则列出所有按需工具' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query || '').trim().toLowerCase()
    const DEFERRED_NAMES = [...DEFERRED_TOOLS]
    const matched = DEFERRED_NAMES.filter(n => !query || n.includes(query))

    if (matched.length === 0) {
      return '未找到匹配的按需工具。核心工具（file_read/file_write/shell_exec/web_search/web_fetch/deep_research 等）已常驻，无需搜索。可按需搜索：' + DEFERRED_NAMES.join(', ')
    }
    const lines = matched.map(n => {
      const def = getToolCatalog().find(t => t.name === n)
      return `- ${n}: ${def?.description || '无描述'}` + (def ? '' : '')
    })
    return `按需工具（已加载，可直接调用）：\n${lines.join('\n')}`
  },
}

export default tool
