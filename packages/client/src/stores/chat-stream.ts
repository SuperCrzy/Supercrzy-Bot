/**
 * 聊天流式处理核心（SSE 事件 → 消息 flow 更新 + 打字机引擎）。
 *
 * 目标（单轨化铺垫）：
 * 1. 打字机引擎（utils/typewriter.ts，WorkBuddy streaming-text 同款）从 ChatView 抽出，
 *    正文/思考共用，可多实例（幽灵模式多 agent 并行流复用）。
 * 2. SSE 事件对消息的更新逻辑集中于此（flow 节点增改），ChatView 只留 UI 副作用。
 *
 * 用法：
 *   const stream = createChatStream(assistantMsg)
 *   stream.pushText(chunk)        // 正文流式 chunk（打字机缓冲渲染）
 *   stream.pushReasoning(chunk)   // 思考流式 chunk
 *   stream.appendDiagramChunk(c)  // 图块（流式画图）
 *   stream.completeDiagram(svg, title)
 *   stream.flushTextNow()         // 工具插入前立即刷完正文
 *   stream.markThinkingDone()
 *   stream.finish()               // 流结束（加速收尾播完，非瞬间）
 */
import type { ChatFlowNode, ChatMessage } from '@/types'
import {
  DEFAULT_TYPING_CONFIG,
  advanceReveal,
  createTypewriterState,
  type TypewriterState,
} from '@/utils/typewriter'

export interface ChatStream {
  /** 当前流目标消息 */
  target: ChatMessage | null
  /** 正文 chunk 到达：累积到打字机缓冲并调度渲染 */
  pushText(text: string): void
  /** 思考 chunk 到达：累积到打字机缓冲并调度渲染 */
  pushReasoning(text: string): void
  /** 图块（diagram_chunk，流式画图"先出画板再逐框绘制"）：追加到进行中的图节点 */
  appendDiagramChunk(chunk: string): void
  /** 完成图（diagram 事件）：覆盖 pending 节点或新建 */
  completeDiagram(svg: string, title: string): void
  /** 立即刷完剩余正文（工具插入前调用，防止打字机把正文劈成两段夹着工具卡片） */
  flushTextNow(): void
  /** 标记所有 thinking 节点完成 */
  markThinkingDone(): void
  /** 流结束：加速收尾播完残留（24ms/16 字符，保留打字机收尾感，不瞬间全出） */
  finish(): void
  /** 销毁别名 */
  dispose(): void
}

export interface ChatStreamOptions {
  /** thinking 节点 message 文案 */
  thinkingMessage?: string
  /** 打字机配置（默认 WorkBuddy 参数：40ms / 1-4 字符） */
  config?: typeof DEFAULT_TYPING_CONFIG
  /** 节点创建回调（新 thinking/text/diagram 节点时通知，如触发折叠 UI） */
  onNodeCreated?: (node: ChatFlowNode) => void
}

/** 创建一个流实例（绑定单个 assistant 消息；幽灵模式可同时开多个） */
export function createChatStream(target: ChatMessage | null, options: ChatStreamOptions = {}): ChatStream {
  const config = options.config || DEFAULT_TYPING_CONFIG
  // 思考通道独立更快配置（2026-08-25 研究结论：WB 正文/思考同速 100 字符/秒；长思考逐字太慢，
  // 思考是过程信息可快播 ≈250 字符/秒（正文 2.5 倍）；正文保持 WB 同款观感）
  const reasoningConfig = {
    ...DEFAULT_TYPING_CONFIG,
    targetIntervalMs: 32,
    speedDivisor: 14,
    minCharsPerTick: 2,
    maxCharsPerTick: 8,
    accelFactor: 0.25,
    decelFactor: 0.1,
  }
  let pendingText = ''
  let pendingReasoning = ''
  let twText: TypewriterState = createTypewriterState()
  let twReasoning: TypewriterState = createTypewriterState()
  let timer: ReturnType<typeof setTimeout> | null = null
  // 流内节点 id 生成（P2-1：打字机创建的 text/thinking/diagram 节点也统一带 id，对齐 ChatView nextNodeId）
  let streamNodeSeq = 0
  function genStreamNodeId(): string {
    streamNodeSeq += 1
    return `s_${Date.now().toString(36)}_${streamNodeSeq}`
  }

  function ensureFlow(): ChatFlowNode[] {
    if (!target) return []
    if (!target.flow) target.flow = []
    return target.flow
  }

  function lastNodeOf<T extends ChatFlowNode['kind']>(kind: T): Extract<ChatFlowNode, { kind: T }> | undefined {
    const flow = target?.flow
    if (!flow) return undefined
    for (let i = flow.length - 1; i >= 0; i--) {
      if (flow[i].kind === kind) return flow[i] as Extract<ChatFlowNode, { kind: T }>
    }
    return undefined
  }

  function appendText(text: string) {
    if (!target) return
    const flow = ensureFlow()
    const last = flow[flow.length - 1]
    if (last && last.kind === 'text') last.text += text
    else {
      const node: ChatFlowNode = { id: genStreamNodeId(), kind: 'text', text }
      flow.push(node)
      options.onNodeCreated?.(node)
    }
  }

  function appendReasoning(text: string) {
    if (!target) return
    let node = lastNodeOf('thinking')
    if (!node) {
      node = { id: genStreamNodeId(), kind: 'thinking', turn: 1, message: options.thinkingMessage || '正在思考...', reasoning: '', completed: false }
      ensureFlow().push(node)
      options.onNodeCreated?.(node)
    }
    node.reasoning += text
  }

  function appendDiagramChunk(chunk: string) {
    if (!target) return
    const flow = ensureFlow()
    let node: any = null
    for (let i = flow.length - 1; i >= 0; i--) {
      const n = flow[i]
      if (n.kind === 'diagram' && (n as any).pending) { node = n; break }
    }
    if (!node) {
      node = { id: genStreamNodeId(), kind: 'diagram', svg: '', title: '', pending: true }
      flow.push(node)
      options.onNodeCreated?.(node)
    }
    node.svg += chunk
  }

  function completeDiagram(svg: string, title: string) {
    if (!target) return
    const flow = ensureFlow()
    let updated = false
    for (let i = flow.length - 1; i >= 0; i--) {
      const n = flow[i]
      if (n.kind === 'diagram' && (n as any).pending) {
        n.svg = svg
        n.title = title.slice(0, 60)
        ;(n as any).pending = false
        updated = true
        break
      }
    }
    if (!updated) {
      const node: ChatFlowNode = { id: genStreamNodeId(), kind: 'diagram', svg, title: title.slice(0, 60) }
      flow.push(node)
      options.onNodeCreated?.(node)
    }
  }

  function markThinkingDone() {
    const flow = target?.flow
    if (flow) for (const n of flow) if (n.kind === 'thinking') n.completed = true
    // 思考内容完整性：打字机未播完的残留直接刷入节点
    // （思考区此时已收起/将收起，用户不可见跳变；展开时推理内容完整不缺失）
    if (target && pendingReasoning) {
      appendReasoning(pendingReasoning)
      pendingReasoning = ''
    }
  }

  /** 打字机 tick：正文/思考两通道各按 advanceReveal 吐字符（WorkBuddy streaming-text 同款 EMA 平滑） */
  function tick() {
    timer = null
    if (!target) { pendingText = ''; pendingReasoning = ''; return }
    if (pendingText) {
      const next = advanceReveal(twText, pendingText.length, pendingText, config)
      const take = Math.max(0, next.displayLength - twText.displayLength)
      // displayLength 相对"当前 pending 快照"：消费后归零、保留 emaLag（防 lag 恒≤0 卡死）
      twText = { displayLength: 0, emaLag: next.emaLag }
      if (take > 0) {
        appendText(pendingText.slice(0, take))
        pendingText = pendingText.slice(take)
      }
    } else {
      twText = createTypewriterState()
    }
    if (pendingReasoning) {
      const next = advanceReveal(twReasoning, pendingReasoning.length, pendingReasoning, reasoningConfig)
      const take = Math.max(0, next.displayLength - twReasoning.displayLength)
      twReasoning = { displayLength: 0, emaLag: next.emaLag }
      if (take > 0) {
        appendReasoning(pendingReasoning.slice(0, take))
        pendingReasoning = pendingReasoning.slice(take)
      }
    } else {
      twReasoning = createTypewriterState()
    }
    if (pendingText || pendingReasoning) timer = setTimeout(tick, config.targetIntervalMs)
  }

  function schedule() {
    if (timer) return
    if ((pendingText || pendingReasoning) && target) timer = setTimeout(tick, config.targetIntervalMs)
  }

  function pushText(text: string) {
    if (!target) return
    if (!target.firstTokenMs && target.startedAt) target.firstTokenMs = Date.now() - target.startedAt  // TTFT
    target.streamChars = (target.streamChars || 0) + text.length
    pendingText += text
    schedule()
  }

  function pushReasoning(text: string) {
    if (!target) return
    if (!target.firstTokenMs && target.startedAt) target.firstTokenMs = Date.now() - target.startedAt  // TTFT
    pendingReasoning += text
    schedule()
  }

  function flushTextNow() {
    if (timer) { clearTimeout(timer); timer = null }
    if (pendingText && target) appendText(pendingText)
    pendingText = ''
  }

  /**
   * 流结束：**加速收尾**而不是瞬间刷完（修复"done 后正文一下子全出"）。
   * 原因：done 事件到达时正文 chunk 已全部缓冲（本地回环毫秒级），若一次性 append，
   * 打字机体验被绕过 → 用户看到"思考慢慢播、结果瞬间出来"。
   * 方案：剩余内容按 24ms/16 字符（≈667 字符/秒，约自然打字机 10 倍）快速播完，
   * 保留"打完收尾"的动感，1000 字正文约 1.5s、2000 字约 3s 播完，不拖沓也不瞬间。
   * 持久化完整性：flow 播完即完整；万一播完前刷新，加载端有 content 兜底补全（stores/chat.ts）。
   */
  function finish() {
    if (timer) { clearTimeout(timer); timer = null }
    if (!target) { reset(); return }
    if (!pendingText && !pendingReasoning) { reset(); return }
    const FAST_MS = 24
    const FAST_CHARS = 16
    const fastTick = () => {
      timer = null
      if (pendingText) {
        const take = Math.min(pendingText.length, FAST_CHARS)
        appendText(pendingText.slice(0, take))
        pendingText = pendingText.slice(take)
      }
      if (pendingReasoning) {
        const take = Math.min(pendingReasoning.length, FAST_CHARS)
        appendReasoning(pendingReasoning.slice(0, take))
        pendingReasoning = pendingReasoning.slice(take)
      }
      if (pendingText || pendingReasoning) timer = setTimeout(fastTick, FAST_MS)
      else reset()
    }
    timer = setTimeout(fastTick, FAST_MS)
  }

  function reset() {
    pendingText = ''
    pendingReasoning = ''
    twText = createTypewriterState()
    twReasoning = createTypewriterState()
    target = null
  }

  return {
    target,
    pushText,
    pushReasoning,
    appendDiagramChunk,
    completeDiagram,
    flushTextNow,
    markThinkingDone,
    finish,
    dispose: finish,
  }
}

export type { TypewriterState }
