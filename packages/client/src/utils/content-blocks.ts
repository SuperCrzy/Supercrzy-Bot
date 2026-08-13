/**
 * 内容块辅助函数 — 运行时纯逻辑
 * 从 types/index.ts 抽出（types 路径会被 vite-node 特殊外部化，不适合放运行时函数）
 * types/index.ts re-export 保持向后兼容
 */
import type {
  TextBlock,
  ReasoningBlock,
  ToolCallBlock,
  ArtifactBlock,
  FileBlock,
  SkillMatchBlock,
  ContentBlock,
  ChatMessage,
} from '../types'

/**
 * 归一化历史消息 content（兼容旧版双重 JSON 序列化数据）
 * 旧版消息入库时 content 被 JSON.stringify 了两次：
 *   "\\\"以下是...\\\\n\\\\n| 类别 |"  （带转义引号 + 字面 \\n）
 * 解一层 JSON.parse 后才是真正的 markdown 文本。
 * 安全策略：仅当字符串以 " 开头且 JSON.parse 成功且结果是 string 时解一层。
 */
export function normalizeContent(raw: string): string {
  if (typeof raw !== 'string' || !raw) return raw
  let s = raw.trimStart()
  if (!s.startsWith('"')) return raw
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') {
      // 解一层后如果还是带转义的字符串（罕见双重），递归再解一层
      return normalizeContent(parsed)
    }
  } catch { /* 不是 JSON，保持原样 */ }
  return raw
}

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => normalizeContent(b.text))
    .join('\n')
}

export function extractReasoning(blocks: ContentBlock[]): ReasoningBlock[] {
  return blocks.filter((b): b is ReasoningBlock => b.type === 'reasoning')
}

export function extractToolCalls(blocks: ContentBlock[]): ToolCallBlock[] {
  return blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
}

export function extractArtifacts(blocks: ContentBlock[]): ArtifactBlock[] {
  return blocks.filter((b): b is ArtifactBlock => b.type === 'artifact')
}

export function extractFiles(blocks: ContentBlock[]): FileBlock[] {
  return blocks.filter((b): b is FileBlock => b.type === 'file')
}

export function extractSkillMatches(blocks: ContentBlock[]): SkillMatchBlock[] {
  return blocks.filter((b): b is SkillMatchBlock => b.type === 'skill-match')
}

/** 消息是否在生成中 */
export function isMessageStreaming(msg: ChatMessage): boolean {
  return msg.status === 'streaming' || msg.status === 'pending'
}

/** 消息是否有错误 */
export function isMessageError(msg: ChatMessage): boolean {
  return msg.status === 'error'
}

/** 消息是否已完成 */
export function isMessageComplete(msg: ChatMessage): boolean {
  return msg.status === 'complete'
}
