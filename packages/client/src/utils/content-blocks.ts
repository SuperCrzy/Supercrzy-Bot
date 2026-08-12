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

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
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
