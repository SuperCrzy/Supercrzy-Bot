/**
 * 从 AI 回复里提取内联 SVG（"模型不调 draw_diagram 也能出图"）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。纯函数，无响应式依赖，可直接单测。
 *
 * 三条实战约束（都是踩出来的）：
 *   · 模型经常把 SVG 包在 ```svg / ```xml 代码块里，也可能**直接裸贴**在正文 → 两种都要扫
 *   · 代码块里的内容常常**缺 `<svg>` 起始标签**（输出被截断/不规范）→ 不能直接丢，
 *     补一个带 viewBox 的外壳仍能渲染，比裸露一段 XML 好
 *   · flow 里已经有 diagram 节点时不能再从正文重复提取 —— 图按 flow 顺序渲染，
 *     重复提取会让同一张图出现两次
 */
import { normalizeContent, type ChatMessage } from '@/types'

/** ```svg / ```xml 语言代码块整体（不要求含 <svg> 标签 —— 模型输出可能缺起始标签） */
export const SVG_CODE_BLOCK_RE = /```(?:svg|xml)\s*[\s\S]*?```/g
/** 正文中的裸 <svg>...</svg> */
export const SVG_BARE_RE = /<svg[\s\S]*?<\/svg>/g

/** 缺起始标签时的补头（与项目里图表统一 viewBox 对齐） */
export const SVG_FALLBACK_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 470" width="100%">'

/** 从文本中提取所有 SVG（代码块内 + 裸标签），图卡片渲染用 */
export function extractSvgs(text: string): string[] {
  const svgs: string[] = []
  for (const block of text.match(SVG_CODE_BLOCK_RE) || []) {
    const inner = block.replace(/^```(?:svg|xml)\s*\n?/, '').replace(/```$/, '').trim()
    // 完整 <svg>...</svg> 直接取
    const full = inner.match(/<svg[\s\S]*?<\/svg>/)
    if (full) svgs.push(full[0])
    // 缺 <svg> 起始标签（模型输出截断/不规范）→ 补头尝试渲染，避免裸露
    else if (inner.startsWith('<') && inner.includes('</')) {
      svgs.push(SVG_FALLBACK_HEAD + inner + '</svg>')
    }
  }
  for (const svg of text.replace(SVG_CODE_BLOCK_RE, '').match(SVG_BARE_RE) || []) {
    svgs.push(svg)
  }
  return svgs
}

/** 消息 flow 中已有的图（diagram 节点）svg 集合 —— 兜底渲染时过滤，避免与 flow 内联图重复 */
export function flowDiagramSet(msg: ChatMessage): Set<string> {
  const s = new Set<string>()
  if (msg.flow) for (const n of msg.flow) if (n.kind === 'diagram') s.add(n.svg)
  return s
}

/**
 * 从消息内容/flow 文本中提取 SVG → `msg.diagrams`（就地追加）。
 * 返回**新增的图数量**（便于调用方判断"这一轮有没有新图"）。
 */
export function autoExtractDiagrams(msg: ChatMessage): number {
  const texts: string[] = []
  if (typeof msg.content === 'string') {
    texts.push(normalizeContent(msg.content))
  } else if (Array.isArray(msg.content)) {
    // 历史消息经 store normalizeContent 转成 ContentBlock[]（{type:'text', text}）——逐个提取并解开 JSON 转义
    for (const b of msg.content) {
      if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') {
        texts.push(normalizeContent((b as any).text))
      }
    }
  }
  if (msg.flow) {
    for (const n of msg.flow) if (n.kind === 'text' && typeof n.text === 'string') texts.push(n.text)
  }
  if (!texts.some((t) => t.includes('<svg'))) return 0

  const flowSvgSet = flowDiagramSet(msg)
  if (!msg.diagrams) msg.diagrams = []
  let added = 0
  for (const text of texts) {
    for (const svg of extractSvgs(text)) {
      if (flowSvgSet.has(svg)) continue
      if (!msg.diagrams.some((d) => d.svg === svg)) {
        msg.diagrams.push({ title: '', svg })
        added++
      }
    }
  }
  return added
}
