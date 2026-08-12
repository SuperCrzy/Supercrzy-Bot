export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  thumbnailUrl?: string
}

// ===== ContentBlock 统一消息内容模型 =====
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ArtifactBlock
  | CodeBlock
  | DiffBlock
  | FileBlock
  | ImageBlock
  | SkillMatchBlock
  | QuestionBlock
  | DeliverySummaryBlock

// ---- 文本块 ----
export interface TextBlock {
  type: 'text'
  text: string
  /** 标记是否 Markdown 渲染 */
  format?: 'markdown' | 'plain'
}

// ---- 深度思考块 ----
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  turn?: number
  completed?: boolean
  /** 思考耗时（秒） */
  duration?: number
}

// ---- 工具调用块 ----
export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  args: string
  result?: string
  /** 状态机: pending → running → done/error */
  status: 'pending' | 'running' | 'done' | 'error'
  /** 执行耗时（毫秒） */
  duration?: number
  /** 工具调用开始时间（用于实时计时） */
  startedAt?: number
  /** 结果是否折叠（长结果自动折叠） */
  collapsed?: boolean
}

// ---- 产物块 (Artifact) ----
export interface ArtifactBlock {
  type: 'artifact'
  id: string
  name: string
  path: string
  mime: string
  size?: number
  /** 产物类型：用于路由预览组件 */
  artifactType: ArtifactType
  /** 生成时间 */
  createdAt?: string
  /** 内容摘要 */
  summary?: string
}

export type ArtifactType =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv'
  | 'image'
  | 'video'
  | 'code'
  | 'html'
  | 'json'
  | 'markdown'
  | 'unknown'

// ---- 代码块 ----
export interface CodeBlock {
  type: 'code'
  code: string
  language?: string
  /** 文件名（如有） */
  filename?: string
}

// ---- 代码差异块 ----
export interface DiffBlock {
  type: 'diff'
  filename?: string
  language?: string
  /** 旧内容 */
  oldText: string
  /** 新内容 */
  newText: string
}

// ---- 文件块（通用） ----
export interface FileBlock {
  type: 'file'
  name: string
  path: string
  mime: string
  size?: number
}

// ---- 图片块 ----
export interface ImageBlock {
  type: 'image'
  url: string
  alt?: string
  width?: number
  height?: number
}

// ---- Skill 匹配块 ----
export interface SkillMatchBlock {
  type: 'skill-match'
  name: string
}

// ---- 用户提问块 (AskUserQuestion) ----
export interface QuestionBlock {
  type: 'question'
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  toolCallId?: string
  answered?: boolean
}

// ---- 交付摘要块 ----
export interface DeliverySummaryBlock {
  type: 'delivery-summary'
  artifactCount: number
  artifacts: Array<{ name: string; path: string; mime: string }>
  toolCallCount: number
  turns: number
}

// ===== 消息状态 =====
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error'

// ===== ChatMessage =====
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  createdAt: string
  /** 消息状态 */
  status?: MessageStatus
  /** 错误时自动重试次数 */
  retryCount?: number
  /** 最大自动重试次数 */
  maxRetries?: number
  /** 错误信息 */
  errorMessage?: string
  /** 是否被用户中止 */
  isAborted?: boolean
  tokenCount?: number
  cost?: number
  attachments?: Attachment[]
}

// ===== SSE 事件协议 =====
export interface SSEEvent {
  type: 'text' | 'thinking' | 'tool-call' | 'tool-result' | 'content' | 'error' | 'done'
  content?: string
  message?: string
  turn?: number
  id?: string
  name?: string
  args?: string
  result?: string
  status?: string
  /** 流完成后的最终消息内容 */
  finalContent?: ContentBlock[]
}

// ===== 任务系统 =====
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface Task {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  /** 依赖的任务 ID 列表 */
  blockedBy?: string[]
  /** 被此任务阻塞的任务 ID 列表 */
  blocks?: string[]
  /** 归属的会话 ID */
  sessionId?: string
  metadata?: Record<string, any>
}

// ===== 向后兼容：辅助函数 =====
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

// ===== API 类型 =====
export interface ToolCallEvent {
  id: string
  name: string
  arguments: string
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface ApiRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: Tool[]
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

export interface StreamChunk {
  id: string
  choices: Array<{
    delta: {
      content?: string
      tool_calls?: any[]
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface Settings {
  apiKey: string
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
}

// ===== 模型管理类型 =====
export interface ModelProvider {
  id: string
  name: string
  providerKey: string
  baseUrl: string
  apiKey: string
  hasApiKey: boolean
  models: string[]
  capabilities: string[]
  enabled: boolean
  isPreset: boolean
  sortOrder: number
}

export interface CustomModel {
  id: string
  providerId: string
  providerName: string
  providerKey: string
  modelId: string
  displayName: string
  baseUrl: string
  hasApiKey: boolean
  enabled: boolean
  isDefault: boolean
  isAutoDerived?: boolean
  createdAt: string
  updatedAt: string
}

export interface AddModelForm {
  providerId: string
  modelId: string
  displayName: string
}

export interface ProviderConfigForm {
  apiKey: string
  baseUrl: string
}

// ===== 工作区文件类型 =====
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mime?: string
  children?: FileNode[]
}
