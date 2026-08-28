import { defineStore } from 'pinia'
import i18n from '@/i18n'
import { ref, computed } from 'vue'
import type { ChatSession, ChatMessage, ContentBlock, TextBlock, ChatFlowNode } from '@/types'

/** 将旧格式字符串 content 转为 ContentBlock[] */
function normalizeContent(content: any): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[]
  if (typeof content === 'string') {
    // 尝试解析 JSON 数组（Agent 存储的消息格式）
    if (content.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed)) return parsed as ContentBlock[]
      } catch { /* fall through */ }
    }
    // 兼容 JSON.stringify 后的纯字符串（"你好" 带引号落库，旧数据）→ 解包，避免渲染时出现多余的引号
    if (content.trimStart().startsWith('"')) {
      try {
        const parsed = JSON.parse(content)
        if (typeof parsed === 'string') return parsed ? [{ type: 'text', text: parsed }] : []
      } catch { /* fall through */ }
    }
    return content ? [{ type: 'text', text: content }] : []
  }
  return []
}

/** 人性化时间显示 — 兼容多种日期格式 */
export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return ''
  // 兼容 SQLite 格式 "2026-05-07 06:44:42"
  const normalized = dateStr.includes(' ') && !dateStr.includes('T')
    ? dateStr.replace(' ', 'T') + 'Z'
    : dateStr
  const date = new Date(normalized).getTime()
  if (isNaN(date)) return dateStr.slice(0, 10)
  const now = Date.now()
  const diff = now - date
  const seconds = Math.floor(diff / 1000)
  const tt = i18n().global.t
  if (seconds < 60) return tt('common.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}${tt('common.minAgo')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}${tt('common.hourAgo')}`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}${tt('common.dayAgo')}`
  if (days < 30) return `${Math.floor(days / 7)}${tt('common.weekAgo')}`
  if (days < 365) return `${Math.floor(days / 30)}${tt('common.monthAgo')}`
  return `${Math.floor(days / 365)}${tt('common.yearAgo')}`
}

/** 会话默认标题（按当前语言）：新建会话未命名时的占位标题 */
export function defaultSessionTitle(): string {
  return i18n().global.t('nav.newTask')
}

/** 判断是否仍是默认标题（新建后未发送首条消息、未自动命名） */
export function isDefaultTitle(title: string | null | undefined): boolean {
  if (!title) return true
  // 兼容：当前语言默认值 + 历史遗留的硬编码默认标题（含切换语言前的旧值）
  return title === defaultSessionTitle()
    || title === '新对话'
    || title === 'New Chat'
    || title === '新建对话'
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  /** 当前会话：持久化到 localStorage，刷新后恢复上次查看的会话（与消息/产物保持一致） */
  const SESSION_KEY = 'supercrzy:current-session'
  const currentSessionId = ref<string | null>(localStorage.getItem(SESSION_KEY) || null)
  const messages = ref<Map<string, ChatMessage[]>>(new Map())
  const isLoading = ref(false)
  const loaded = ref(false)
  /** 分支续跑信号：TimelinePanel 设置后，ChatView 监听并发起续跑 */
  const pendingResume = ref<string | null>(null)
  /** 幽灵建议信号：GhostPanel 设置后，ChatView 作为用户消息自动发送 */
  const pendingMessage = ref<string | null>(null)

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value)
  )

  const currentMessages = computed(() =>
    currentSessionId.value ? (messages.value.get(currentSessionId.value) ?? []) : []
  )

  /**
   * 会话按工作区目录分组（对齐 WorkBuddy 空间结构）：
   * - 有 workspace_dir 的会话按目录归组（组标题 = 目录名）
   * - 无目录的会话归入「临时任务」组（isPlayground）
   * 返回 [{ key, title, sessions }]，目录组按最新会话排序，临时组放最后
   */
  const workspaceVersion = ref(0)
  const groupedSessions = computed(() => {
    void workspaceVersion.value // 依赖信号，工作区变化后重算
    const groups = new Map<string, { key: string; title: string; sessions: ChatSession[] }>()
    const temp: ChatSession[] = []
    for (const s of sessions.value) {
      if (s.archived) continue // 归档会话不显示在主列表（进归档区 archivedSessions）
      if (s.workspaceDir) {
        let g = groups.get(s.workspaceDir)
        if (!g) {
          g = { key: s.workspaceDir, title: s.workspaceDir, sessions: [] }
          groups.set(s.workspaceDir, g)
        }
        g.sessions.push(s)
      } else {
        temp.push(s)
      }
    }
    const result: Array<{ key: string; title: string; sessions: ChatSession[] }> = []
    for (const g of groups.values()) {
      g.sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      result.push(g)
    }
    result.sort((a, b) => new Date(b.sessions[0].updatedAt).getTime() - new Date(a.sessions[0].updatedAt).getTime())
    if (temp.length > 0) {
      temp.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      result.push({ key: '__temp__', title: '', sessions: temp })
    }
    return result
  })

  /** 归档会话列表（按归档时间倒序；与 groupedSessions 互斥） */
  const archivedSessions = computed(() =>
    sessions.value.filter((s) => s.archived).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  )
  /** 工作区变化时调用：让 groupedSessions 重算 */
  function notifyWorkspaceChanged() {
    workspaceVersion.value++
  }

  // ---- 从后端加载会话列表 ----
  async function loadSessions() {
    if (loaded.value) return
    // 跨端同步：优先从后端 settings 恢复上次会话（App/网页共享），settings 无值才用 localStorage
    try {
      const st = await fetch('/api/settings').then((r) => r.json())
      if (typeof st.currentSessionId === 'string' && st.currentSessionId) {
        currentSessionId.value = st.currentSessionId
        localStorage.setItem(SESSION_KEY, st.currentSessionId)
      }
    } catch { /* settings 不可用时回退 localStorage */ }
    try {
      const res = await fetch('/api/sessions')
      if (res.ok) {
        const data: any[] = await res.json()
        // 规范化字段名：后端返回 created_at → 前端用 createdAt
        sessions.value = data.map((s: any) => ({
          id: s.id,
          title: s.title || defaultSessionTitle(),
          createdAt: s.created_at || s.createdAt,
          updatedAt: s.updated_at || s.updatedAt,
          model: s.model || 'deepseek-v4-pro',
          workspaceDir: s.workspace_dir || '',
          permissionLevel: ['workspace-only', 'sandbox', 'full'].includes(s.permission_level) ? s.permission_level : 'sandbox',
        }))
        // 恢复上次会话：localStorage 里的 id 若已被删除则回退到最新会话
        if (currentSessionId.value && !data.some((s: any) => s.id === currentSessionId.value)) {
          currentSessionId.value = data[0]?.id ?? null
        }
        // 没有当前会话，选第一个
        if (!currentSessionId.value && data.length > 0) {
          currentSessionId.value = data[0].id
        }
        loaded.value = true
        // 选中会话后必须同步加载消息：否则刷新后 messages 为空 → 显示欢迎页，
        // 而产物（watch currentSessionId → loadArtifacts）却正常加载 → 状态错位
        if (currentSessionId.value && (!messages.value.has(currentSessionId.value) || messages.value.get(currentSessionId.value)!.length === 0)) {
          await loadMessages(currentSessionId.value)
        }
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    }
  }

  // ---- 加载指定会话的消息 ----
  async function loadMessages(sessionId: string) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.messages) {
          // 兼容旧数据：将字符串 content 转为 ContentBlock[]；attachments.flow 还原执行过程（历史折叠条可展开）
          const normalized = data.messages.map((m: any) => {
            let flow = parseFlowFromAttachments(m.attachments)
            // 兜底：flow 正文与 content 对账（content 是完整真相）——
            // ①flow text 与 content 严重不一致（打字机错乱/旧数据）→ 丢弃 flow text 节点，用 content 重建正文
            // ②flow text 缺失在末尾 → 用 content 补尾；③flow 完全无 text → 补建
            if (flow && flow.length > 0) {
              const flowTexts = flow.filter((n) => n.kind === 'text')
              const flowTextLen = flowTexts.reduce((s, n) => s + String(n.text).length, 0)
              const flowJoined = flowTexts.map((n) => String(n.text)).join('')
              // 注意：content 可能含 ```svg 代码块（draw_diagram 前模型兜底输出），flow text 不含——
              // 必须先剥离 SVG 代码块再比较，否则误判"缺内容"把 SVG 中段补进正文（导致乱码）
              const rawText = normalizeContent(m.content)
                .filter((b: any) => b.type === 'text')
                .map((b: any) => String(b.text))
                .join('\n')
              const contentText = rawText
                .replace(/```(?:svg|xml)\s*[\s\S]*?```/g, '')
                .replace(/<svg[\s\S]*?<\/svg>/g, '')
              // 公共前缀判定：flow 正文与 content 严重不一致（<50%）→ flow text 已错乱
              let cp = 0
              const minLen = Math.min(flowJoined.length, contentText.length)
              while (cp < minLen && flowJoined[cp] === contentText[cp]) cp++
              const flowBroken = flowJoined.length > 0 && cp < minLen * 0.5
              if (flowBroken) {
                // 保留过程节点（thinking/tool/diagram），正文用 content 重建（放末尾=最终报告位置）
                flow = flow.filter((n) => n.kind !== 'text')
                if (contentText.trim()) flow.push({ id: `restored-${Date.now()}`, kind: 'text', text: contentText })
              } else if (contentText.length > flowTextLen + 50) {
                const missing = contentText.slice(flowTextLen)
                const lastText = [...flow].reverse().find((n) => n.kind === 'text')
                if (lastText) {
                  lastText.text += missing
                } else {
                  // flow 无任何 text 节点：补建（放末尾 = 最终报告位置），恢复 markdown 排版
                  flow.push({ id: `restored-${Date.now()}`, kind: 'text', text: missing })
                }
              }
            }
            // P0-7 耗时订正（WorkBuddy correctAssistantCreateTimeFromTools 同款）：
            // 历史消息 elapsed_ms 缺失时，用 flow 内工具节点的最大 createTime 与 startedAt 之差兜底
            let elapsedMs = m.elapsed_ms
            if (!elapsedMs && Array.isArray(flow)) {
              let maxCreate = 0
              let minStart = Number.MAX_SAFE_INTEGER
              for (const n of flow) {
                if (n.kind !== 'tool') continue
                if (n.tool.createTime && n.tool.createTime > maxCreate) maxCreate = n.tool.createTime
                if (n.tool.startedAt && n.tool.startedAt < minStart) minStart = n.tool.startedAt
              }
              if (maxCreate > 0 && minStart !== Number.MAX_SAFE_INTEGER) elapsedMs = maxCreate - minStart
              else if (maxCreate > 0) elapsedMs = maxCreate - m.created_at
            }
            return {
              ...m,
              createdAt: m.created_at || m.createdAt,
              elapsedMs,
              tokenCount: m.token_count,
              content: normalizeContent(m.content),
              flow,
              // 2026-08-26：从 attachments 还原 deliverySummary，AI 回复底部"本会话产物"刷新后不丢
              deliverySummary: parseDeliveryFromAttachments(m.attachments),
            }
          })
          messages.value.set(sessionId, normalized)
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err)
    }
  }

  // ---- 创建新会话（持久化到后端） ----
  async function createSession(title?: string, workspaceDir?: string): Promise<ChatSession> {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: title || defaultSessionTitle(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'deepseek-v4-pro',
      workspaceDir: workspaceDir || '',
    }
    sessions.value.unshift(session)
    messages.value.set(session.id, [])
    currentSessionId.value = session.id
    localStorage.setItem(SESSION_KEY, session.id)
    persistCurrentSession()

    // 持久化到后端
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: session.title, model: session.model, id: session.id, workspace_dir: session.workspaceDir }),
      })
    } catch (err) {
      console.error('Failed to persist session:', err)
    }
    return session
  }

  /**
   * 回到欢迎页草稿态：不创建会话（列表不新增），
   * 用户发送第一条消息时 doSend 里才真正 createSession（避免一堆空"新对话"）
   */
  function resetToWelcome() {
    currentSessionId.value = null
    localStorage.removeItem(SESSION_KEY)
    persistCurrentSession()
  }

  /** 把当前会话同步到后端 settings（跨端共享：App 与网页打开同一个会话，刷新/重启恢复一致） */
  async function persistCurrentSession() {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentSessionId: currentSessionId.value || '' }),
      })
    } catch { /* 同步失败不影响主流程 */ }
  }

  // ---- 选择会话并加载消息 ----
  async function selectSession(id: string) {
    currentSessionId.value = id
    localStorage.setItem(SESSION_KEY, id)
    persistCurrentSession()
    // 如果消息未加载，从后端加载
    if (!messages.value.has(id) || messages.value.get(id)!.length === 0) {
      await loadMessages(id)
    }
  }

  /** 设置会话的工作目录（AI 在该文件夹里工作），持久化到后端 */
  async function setSessionWorkspace(id: string, workspaceDir: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (session) session.workspaceDir = workspaceDir
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_dir: workspaceDir }),
      })
    } catch {}
  }

  /** 设置会话的默认权限档位（workspace-only / sandbox / full），持久化到后端 */
  async function setSessionPermission(id: string, level: 'workspace-only' | 'sandbox' | 'full') {
    const session = sessions.value.find((s) => s.id === id)
    if (session) session.permissionLevel = level
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_level: level }),
      })
    } catch {}
  }

  /** 重命名会话（本地即时生效 + 后端持久化） */
  async function setSessionTitle(id: string, title: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (session) session.title = title
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
    } catch {}
  }

  // ---- 删除单条消息（消息操作栏"删除"） ----
  function removeMessage(sessionId: string, msgId: string) {
    const list = messages.value.get(sessionId)
    if (list) {
      messages.value.set(sessionId, list.filter((m) => m.id !== msgId))
    }
  }

  // ---- 删除会话 ----
  /** 重命名会话（PATCH /api/sessions/:id，更新本地列表） */
  async function renameSession(id: string, title: string) {
    const t = String(title || '').trim()
    if (!t) return
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx !== -1) sessions.value[idx] = { ...sessions.value[idx], title: t }
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      })
    } catch (err) { console.error('Failed to rename session:', err) }
  }

  /** 归档/恢复会话（PATCH archived；归档时若为当前会话则切走） */
  async function archiveSession(id: string, archived: boolean) {
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx !== -1) sessions.value[idx] = { ...sessions.value[idx], archived }
    if (archived && currentSessionId.value === id) {
      const next = sessions.value.find((s) => !s.archived && s.id !== id)
      currentSessionId.value = next?.id ?? null
      if (currentSessionId.value) localStorage.setItem(SESSION_KEY, currentSessionId.value)
    }
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
    } catch (err) { console.error('Failed to archive session:', err) }
  }

  async function deleteSession(id: string) {
    // 先删前端
    const idx = sessions.value.findIndex((s) => s.id === id)
    const removed = idx !== -1 ? sessions.value[idx] : null
    if (idx !== -1) sessions.value.splice(idx, 1)
    const oldMsgs = messages.value.get(id)
    messages.value.delete(id)
    if (currentSessionId.value === id) {
      currentSessionId.value = sessions.value[0]?.id ?? null
      if (currentSessionId.value) localStorage.setItem(SESSION_KEY, currentSessionId.value)
      else localStorage.removeItem(SESSION_KEY)
      persistCurrentSession()
    }
    // 持久化删除
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        // 后端删除失败 → 回滚本地，避免"界面删了但刷新又出现"
        if (removed) sessions.value.splice(idx < 0 ? 0 : idx, 0, removed)
        if (oldMsgs) messages.value.set(id, oldMsgs)
        throw new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
      throw err
    }
  }

  // ---- 添加消息（持久化到后端） ----
  async function addMessage(sessionId: string, message: ChatMessage) {
    const list = messages.value.get(sessionId) ?? []
    list.push(message)
    messages.value.set(sessionId, list)

    // 首次用户消息 → 自动命名会话
    if (message.role === 'user') {
      const userMsgs = list.filter((m) => m.role === 'user')
      if (userMsgs.length === 1) {
        const firstBlock = Array.isArray(message.content) ? message.content[0] : undefined
        const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : ''
        const title = text.slice(0, 40) || defaultSessionTitle()
        const session = sessions.value.find((s) => s.id === sessionId)
        if (session && isDefaultTitle(session.title)) {
          session.title = title
          // 持久化标题
          try {
            await fetch(`/api/sessions/${sessionId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title }),
            })
          } catch {}
        }
      }
    }

    // 持久化到后端（draw_diagram 的 SVG 合并进 content；flow 过程随 attachments 落库，刷新后可展开回看）
    try {
      const contentStr = serializeWithDiagrams(message)
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: message.id,
          role: message.role,
          content: contentStr,
          token_count: message.tokenCount,
          cost: message.cost,
          elapsed_ms: message.elapsedMs,
          attachments: serializeWithFlow(message),
        }),
      })
    } catch (err) {
      console.error('Failed to persist message:', err)
    }
  }

  /**
   * 序列化 attachments：原附件 + 执行过程 flow（思考/工具/文本节点）。
   * 历史会话刷新后靠它还原"当时怎么做的"（折叠条可展开看过程）。
   * tool 的 result 截断到 3000 字符、reasoning 截断到 2000，防 DB 膨胀。
   */
  function serializeWithFlow(message: ChatMessage): any {
    const base = message.attachments || undefined
    const flow = (message as any).flow || []
    if (!flow.length) return base
    const trimmed = flow.map((n: any) => {
      if (n.kind === 'tool') {
        return {
          ...n,
          tool: {
            ...n.tool,
            result: typeof n.tool?.result === 'string' ? n.tool.result.slice(0, 3000) : n.tool?.result,
            streamOutput: undefined,
          },
        }
      }
      if (n.kind === 'thinking') {
        return { ...n, reasoning: typeof n.reasoning === 'string' ? n.reasoning.slice(0, 2000) : n.reasoning }
      }
      return n
    })
    // attachments 保持原数组形态（防止 {...数组} 展开成对象导致前端 .filter() 报错），flow 并排存储
    // deliverySummary 一并序列化（2026-08-26 修复：否则 AI 回复底部的"本会话产物"刷新后丢失，
    // 而横栏产物列表（artifacts 表）还在 → 状态错位。老板反馈"产物刷新就没了"）
    const ds = (message as any).deliverySummary
    const extra = (ds && Array.isArray(ds.artifacts) && ds.artifacts.length > 0) ? { deliverySummary: ds } : undefined
    if (base) return { attachments: base, flow: trimmed, ...extra }
    if (extra) return { flow: trimmed, ...extra }
    return { flow: trimmed }
  }

  /** 从后端返回的 attachments（JSON 字符串）还原 flow 执行过程 */
  function parseFlowFromAttachments(attachments: any): ChatFlowNode[] | undefined {
    try {
      const parsed = typeof attachments === 'string' ? JSON.parse(attachments) : attachments
      if (parsed && Array.isArray(parsed.flow) && parsed.flow.length > 0) {
        return parsed.flow as ChatFlowNode[]
      }
    } catch { /* 旧数据无 flow */ }
    return undefined
  }

  /** 从后端返回的 attachments 还原 deliverySummary（2026-08-26 修复：产物卡片刷新需持久化还原） */
  function parseDeliveryFromAttachments(attachments: any): any | undefined {
    try {
      const parsed = typeof attachments === 'string' ? JSON.parse(attachments) : attachments
      if (parsed && parsed.deliverySummary && Array.isArray(parsed.deliverySummary.artifacts) && parsed.deliverySummary.artifacts.length > 0) {
        return parsed.deliverySummary
      }
    } catch { /* 旧数据无 deliverySummary */ }
    return undefined
  }

  /**
   * 序列化消息 content 时把 draw_diagram 生成的 SVG（diagrams）合并进去，
   * 这样 SVG 图随消息落库，刷新/历史会话都能从 content 重新提取恢复（autoExtractDiagrams）。
   */
  function serializeWithDiagrams(message: ChatMessage): string {
    const msgForSave = { ...message }
    const svgBlocks = ((msgForSave as any).diagrams || [])
      .map((d: { svg: string }) => { const fence = '```'; return fence + 'svg\n' + d.svg + '\n' + fence })
      .join('\n\n')
    if (svgBlocks && msgForSave.role === 'assistant') {
      if (typeof msgForSave.content === 'string') {
        msgForSave.content = msgForSave.content + (msgForSave.content ? '\n\n' : '') + svgBlocks
      } else if (Array.isArray(msgForSave.content)) {
        msgForSave.content = [...msgForSave.content, { type: 'text' as const, text: svgBlocks }]
      }
    }
    // 纯字符串 content 直接落库（不再 JSON.stringify——否则 "你好" 会带引号存库，刷新后渲染出多余引号）；
    // ContentBlock[] 才序列化
    return typeof msgForSave.content === 'string' ? msgForSave.content : JSON.stringify(msgForSave.content)
  }

  // ---- 更新最后一条消息内容（用于流式更新时本地暂存，不每次请求） ----
  function updateLastMessage(sessionId: string, content: string) {
    const list = messages.value.get(sessionId)
    if (list && list.length > 0) {
      const last = list[list.length - 1]
      last.content = normalizeContent(content)
    }
  }

  // ---- 持久化最后一条消息的最终内容（流式完成后调用） ----
  async function persistLastMessage(sessionId: string) {
    const list = messages.value.get(sessionId)
    if (!list || list.length === 0) return
    const last = list[list.length - 1]
    try {
      const contentStr = serializeWithDiagrams(last)
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: last.id,
          role: last.role,
          content: contentStr,
          token_count: last.tokenCount,
          cost: last.cost,
          elapsed_ms: last.elapsedMs,
          attachments: serializeWithFlow(last),
        }),
      })
    } catch (err) {
      console.error('Failed to persist last message:', err)
    }
  }

  function setLoading(v: boolean) {
    isLoading.value = v
  }

  return {
    sessions,
    currentSessionId,
    messages,
    isLoading,
    loaded,
    pendingResume,
    pendingMessage,
    currentSession,
    currentMessages,
    groupedSessions,
    archivedSessions,
    notifyWorkspaceChanged,
    loadSessions,
    loadMessages,
    createSession,
    resetToWelcome,
    selectSession,
    setSessionWorkspace,
    setSessionPermission,
    setSessionTitle,
    deleteSession,
    archiveSession,
    renameSession,
    removeMessage,
    addMessage,
    updateLastMessage,
    persistLastMessage,
    setLoading,
  }
})
