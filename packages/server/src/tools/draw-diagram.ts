/**
 * draw_diagram — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'

const tool: ToolDef = {
  name: 'draw_diagram',
  description: '绘制矢量图（架构图/流程图/对比示意图）。直接给出完整 SVG 代码，会实时显示在对话中。适合解释概念、展示方案、画架构。viewBox 建议 0 0 680 420。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '图标题（简短）' },
      svg: { type: 'string', description: '完整 SVG 代码（以 <svg 开头，不含 xml 声明）' },
    },
    required: ['title', 'svg'],
  },
  async execute(args, ctx) {
    const title = String(args.title || 'diagram').slice(0, 60)
    const svg = String(args.svg || '').trim()
    if (!svg.startsWith('<svg')) return '❌ SVG 必须以 <svg> 开头（不含 xml 声明/DOCTYPE）'
    if (svg.length > 80000) return '❌ SVG 过大（超过 80K 字符），请精简'
    // 安全：只允许 SVG 元素与基础样式属性，禁止 script/外链
    if (/<script|on\w+=|javascript:|href=|<foreignObject/i.test(svg)) {
      return '❌ SVG 含不安全内容（script/事件/外链被禁止），请用纯图形元素'
    }
    // 流式画图（WorkBuddy 同款）：SVG 按标签边界切块推送 → 前端元素逐个闭合逐个绘制（"先画框 A 再画框 B"）
    // 先推空块让"画板"先出现，再逐块绘制
    if (ctx?.onDiagramChunk) {
      const chunks = chunkSvgByTag(svg, 140)
      const delay = chunks.length > 1 ? Math.max(30, Math.min(160, Math.round(1200 / chunks.length))) : 0
      if (delay > 0) ctx.onDiagramChunk('')
      for (const c of chunks) {
        ctx.onDiagramChunk(c)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      }
    }
    ctx?.onDiagram?.(title, svg)
    return `✅ 图表已生成：${title}`
  },
}

// ---- 本工具私有辅助（随工具一并从 services/tools.ts 迁出，供本文件内使用）----
/**
 * SVG 按标签边界切块（流式画图用）：优先在 `>` 标签闭合处切，保证每块是完整的元素前缀。
 * SVG 声明式渲染：块到达后已闭合元素立即绘制 → 前端呈现"逐框绘制"效果。
 */
function chunkSvgByTag(svg: string, targetChars = 140): string[] {
  const chunks: string[] = []
  let i = 0
  const len = svg.length
  while (i < len) {
    let end = Math.min(i + targetChars, len)
    if (end < len) {
      const gt = svg.indexOf('>', end)
      // 标签闭合处优先；若太远（超 3 倍预算）则按字符硬切（文本节点）
      if (gt !== -1 && gt - i <= targetChars * 3) end = gt + 1
    }
    chunks.push(svg.slice(i, end))
    i = end
  }
  return chunks
}

export default tool
