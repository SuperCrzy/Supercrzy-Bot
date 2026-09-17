/**
 * 消息纯文本提取（P1-04 从 ChatView.vue 下沉，2026-09-17）
 *
 * 三种 content 形态需要统一处理：纯字符串 / ContentBlock[] / 旧数据。
 * 这些逻辑此前埋在 ChatView 里，复制、导出、搜索三处各写一遍。
 */
import { extractText, normalizeContent } from '@/types'
import type { ChatMessage } from '@/types'

/** content → 纯文本（兼容 string / ContentBlock[]） */
export function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return normalizeContent(content)
  return extractText(content as never)
}

/** 消息 → 纯文本（对 content 可能缺失的消息更宽容） */
export function messagePlainText(m: { content?: unknown } | null | undefined): string {
  const raw = m?.content
  if (typeof raw === 'string') return normalizeContent(raw)
  if (Array.isArray(raw)) return extractText(raw as never)
  return ''
}

/** 搜索结果摘要（截断到 200 字符） */
export function searchContent(content: unknown): string {
  if (typeof content !== 'string') return ''
  const text = normalizeContent(content)
  return text.length > 200 ? text.slice(0, 200) + '...' : text
}
