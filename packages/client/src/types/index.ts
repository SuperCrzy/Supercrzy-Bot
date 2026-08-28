export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string
  /** 会话级工作目录（AI 在该文件夹里工作，可选） */
  workspaceDir?: string
  /** 会话级默认权限档位（workspace-only / sandbox / full，默认 sandbox） */
  permissionLevel?: 'workspace-only' | 'sandbox' | 'full'
  /** 归档标记（归档会话移出主列表，可恢复） */
  archived?: boolean
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  thumbnailUrl?: string
  /** 图片 OCR 识别出的文字（RapidOCR 本地识别，发消息时注入对话） */
  ocrTexts?: string[]
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
  /** 状态机: pending → approved → running/stream_executing → done/error；拒绝 → denied；跳过 → skipped */
  status: 'pending' | 'approved' | 'running' | 'stream_executing' | 'done' | 'error' | 'denied' | 'skipped'
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
  name_en?: string
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
  /** 兼容两种形态：流式过程中的字符串，历史消息的 ContentBlock[] */
  content: ContentBlock[] | string
  createdAt: string
  /** 消息状态 */
  status?: MessageStatus
  /** 错误时自动重试次数 */
  retryCount?: number
  /** 最大自动重试次数 */
  maxRetries?: number
  /** 错误信息 */
  errorMessage?: string
  /** 过程折叠：总结开始输出后，思考/工具过程自动收拢成摘要条（点击可展开）；undefined=流式中未触发 */
  processCollapsed?: boolean
  /** 折叠状态机信号（2026-08-25 重构，运行时字段、不持久化）：800ms 延迟确认定时器已触发 */
  _foldElapsed?: boolean
  /** 折叠状态机信号：流已结束（done/finally） */
  _hasEnd?: boolean
  /** 折叠状态机信号：用户手动折叠/展开覆盖（最高优先，展开后自动折叠让位） */
  _userFoldState?: 'folded' | 'expanded'
  /** 结构化停止原因（对齐 WorkBuddy MaxTurnsExceededError：轮次超限/空内容兜底/API 失败时让用户知道为什么停） */
  stopReason?: { reason: string; message: string; checkpointId?: string; toolCalls?: number; turns?: number }
  /** 是否被用户中止 */
  isAborted?: boolean
  tokenCount?: number
  cost?: number
  /** 真实 token 用量（DeepSeek usage 字段，usage 事件写入） */
  promptTokens?: number
  completionTokens?: number
  /** 发送时刻（计时起点，done 后清除） */
  startedAt?: number
  /** 任务完成耗时 ms（done 事件计算） */
  elapsedMs?: number
  /** TTFT：发送到首个内容/思考 chunk 的延迟 ms（对齐 Harness turn-metrics，2026-08-23） */
  firstTokenMs?: number
  /** 流式正文累计字符数（算打字速率 字符/s，2026-08-23） */
  streamChars?: number
  /** 用户反馈（AI 消息工具栏点赞/点踩，持久化到 messages.feedback） */
  feedback?: 'up' | 'down'
  /** Agent 结构化提问（ask_question 工具，pendingQuestion 答复后清除） */
  pendingQuestion?: { id: string; question: string; options: string[] }
  attachments?: Attachment[]
  /** 流式过程中的思考步骤（agent 模式） */
  thinking?: Array<{ turn?: number; message?: string; reasoning?: string; completed?: boolean }>
  /** 流式过程中的工具调用（agent 模式） */
  toolCalls?: ToolCallEvent[]
  /** 统一时序流：按事件到达顺序交错渲染（思考 → 工具 → 正文 → 下一轮） */
  flow?: ChatFlowNode[]
  /** 匹配到的技能 */
  skills?: Array<{ name: string; name_en?: string }>
  /** Planner 执行计划 */
  planner?: { steps: string[]; raw?: string }
  /** Planner 模式执行中（等待规划结果） */
  plannerPending?: boolean
  /** 重试提示（error 事件 retrying 时） */
  retrying?: string
  /** 应用的历史经验（playbook_used 事件） */
  playbookUsed?: Array<{ taskType: string; lesson: string }>
  /** AI 主动推荐保存为可复用流程（routine_suggest 事件，学 Grok"演示一次就学会"） */
  routineSuggestion?: { sessionId: string; title: string; toolSummary: string[]; toolCount: number; turnCount: number }  /** 角色分发（role_routed 事件） */
  roleRouted?: { roleId: string; roleName: string; matchedKeyword: string }
  /** AI 绘制的矢量图（draw_diagram 工具，diagram 事件） */
  diagrams?: Array<{ title: string; svg: string }>
  /** 交付摘要 */
  deliverySummary?: {
    artifactCount: number
    artifacts: Array<{ name: string; path: string; mime: string }>
    toolCallCount: number
    turns: number
  }
}

/** 聊天时序流节点（agent 模式实时渲染用）——统一块模型：每节点带 id（事件精确归属/断点恢复基础，对齐 WorkBuddy contentBlockId） */
export type ChatFlowNode =
  | { id?: string; kind: 'thinking'; turn?: number; message: string; reasoning: string; completed: boolean }
  | { id?: string; kind: 'tool'; tool: ToolCallEvent }
  | { id?: string; kind: 'text'; text: string }
  /** 图节点（WorkBuddy image-block 同款：按 flow 顺序渲染，文字不会把图推走；pending=流式绘制中） */
  | { id?: string; kind: 'diagram'; svg: string; title: string; pending?: boolean }
  /** 生成图节点（generate_image 工具：data 为 dataURL 或 URL，对话内 <img> 渲染） */
  | { id?: string; kind: 'image'; data: string; isUrl: boolean; title: string }

// ===== SSE 事件协议 =====
export interface SSEEvent {
  type: 'text' | 'thinking' | 'tool-call' | 'tool-result' | 'content' | 'error' | 'done' | 'diagram_chunk'
  content?: string
  message?: string
  turn?: number
  id?: string
  name?: string
  args?: string
  result?: string
  status?: string
  /** 画图流式块（diagram_chunk 事件：SVG 标签边界切块，逐块追加到流式中的图节点） */
  chunk?: string
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

// ===== 向后兼容：辅助函数（实现已移至 utils/content-blocks.ts）=====
export {
  normalizeContent,
  extractText,
  extractReasoning,
  extractToolCalls,
  extractArtifacts,
  extractFiles,
  extractSkillMatches,
  isMessageStreaming,
  isMessageError,
  isMessageComplete,
} from '../utils/content-blocks'

// ===== API 类型 =====
/**
 * 工具状态机（WorkBuddy ToolState 10 态对齐）：
 * idle → parsing → pending → stream_executing/full_executing → executed
 *                         ↘                    ↙
 *                            skipped / failed / cancelled / destroyed
 */
export type ToolStatus =
  | 'parsing'
  | 'pending'
  | 'approved'
  | 'running'
  | 'stream_executing'
  | 'done'
  | 'error'
  | 'denied'
  | 'skipped'
  | 'cancelled'
  | 'destroyed'

export interface ToolCallEvent {
  id: string
  name: string
  arguments: string
  result?: string
  status: ToolStatus
  /** 执行耗时（秒） */
  duration?: number
  /** 开始时间（实时计时用） */
  startedAt?: number
  /** 工具真实执行时刻（P0-7：历史重放耗时订正用，WorkBuddy tool-call createTime 同款） */
  createTime?: number
  /** 工具流式输出（执行中实时追加） */
  streamOutput?: string
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
