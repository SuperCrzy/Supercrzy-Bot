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

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  tokenCount?: number
  cost?: number
  toolCalls?: ToolCallEvent[]
  thinking?: string[]
  attachments?: Attachment[]
}

export interface ToolCallEvent {
  id: string
  name: string
  arguments: string
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface DeepSeekRequest {
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
