/**
 * tool_search — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 *
 * 2026-10-23：检索从「name.includes(query)」换成 BM25（见 services/tool-search-index.ts）。
 * 旧实现在中文 query 上必然 0 命中（工具名全英文），且无命中时把 34 条按需工具**全量倒给模型**，
 * 等于让模型自己读长名单 —— 这是"工具装着却调不到"的根因。
 */
import type { ToolDef } from './types'
import { DEFERRED_TOOLS, getToolCatalog } from './deferred'
import { getToolIndex, searchIndex, type ToolDoc } from '../services/tool-search-index'

/** 未命中时只给几个最常用的示例，绝不倾倒全量清单 */
const FALLBACK_EXAMPLES = ['terminal_open', 'generate_image', 'draw_diagram', 'bg_task', 'git_commit']

/**
 * 按需工具召回的**唯一数据源**（G2，2026-10-23）。
 *
 * 存在的理由：此前"哪些工具被 tool_search 激活"靠 agent.ts 对返回文案做正则
 * （`txt.includes('已加载，可直接调用')` + `/-\s+([a-z][a-z0-9_]*)\s*:/gi`）——
 * 改一个字，按需工具**永久调不到且不报错**（静默失能）。
 * 现在文案渲染与本函数共用同一份检索结果：文案纯给人看/给模型看，
 * 激活走数据（agent.ts 用同参调用本函数），两边从此不可能漂移。
 *
 * 空 query 返回 []（旧行为：列清单不触发激活）。
 */
export function resolveToolSearchHits(query: string, limit = 8): string[] {
  const q = String(query || '').trim()
  if (!q) return []
  const DEFERRED_NAMES = [...DEFERRED_TOOLS]
  const catalog = getToolCatalog()
  const docs: ToolDoc[] = DEFERRED_NAMES.map((name) => ({
    name,
    description: catalog.find((t) => t.name === name)?.description || '',
  }))
  return searchIndex(getToolIndex(docs), q, limit).map((h) => h.name)
}

const tool: ToolDef = {
  name: 'tool_search',
  description: '发现按需加载的工具。核心工具已常驻无需搜索；当需要一个不在当前可用列表里的工具（如生成图片 generate_image、视频剪辑 video_edit、终端控制 terminal_*、桌面控制 computer_use、技能详情 skill_view 等）时，先用本工具搜索并加载其定义，随后即可正常调用。支持中英文关键词与模糊匹配。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，中英皆可，如 "后台任务"、"生成图片"、"terminal"、"git"；留空则列出所有按需工具名' },
      limit: { type: 'number', description: '最多返回几条，默认 8，上限 50' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query || '').trim()
    const limit = Number(args.limit) || 8
    const DEFERRED_NAMES = [...DEFERRED_TOOLS]

    // 空 query：仍是"列全部"（显式要清单的场景），但只给名字，不铺描述
    if (!query) {
      return `按需工具（${DEFERRED_NAMES.length} 个，可直接调用）：\n${DEFERRED_NAMES.join(', ')}`
    }

    // 渲染与激活共用 resolveToolSearchHits（见其注释）：文案可以随便改，激活不受影响
    const hits = resolveToolSearchHits(query, limit)
    if (!hits.length) {
      return [
        `未找到与「${query}」匹配的按需工具。`,
        '可以换更短的关键词（中英皆可），或者用工具名的一部分搜索。',
        `常用示例：${FALLBACK_EXAMPLES.join(', ')}`,
      ].join('\n')
    }

    const catalog = getToolCatalog()
    const lines = hits.map((name) => {
      const def = catalog.find((t) => t.name === name)
      return `- ${name}: ${def?.description || '无描述'}`
    })
    return `按需工具（已加载，可直接调用）：\n${lines.join('\n')}`
  },
}

export default tool
