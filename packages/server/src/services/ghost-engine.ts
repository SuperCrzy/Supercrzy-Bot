/**
 * 幽灵工作台 — 多 Agent 并行执行引擎（差异化核心）
 *
 * 架构：
 *   任务分解器（LLM 拆解 + 文件依赖分析）
 *     → 多幽灵并行执行器（复用 runAgentLoop，每个幽灵独立 fake ctx + 独立会话沙箱，
 *        并发上限 GHOST_MAX_CONCURRENCY，每幽灵 maxTurns 步骤预算防失控）
 *     → 结果汇总器（LLM 合并各幽灵产出 → 最终报告）
 *
 * 事件：ghostBus（EventEmitter）广播所有幽灵事件，由 ws 端点（/ws/ghost）推送给前端看板。
 * 关键技巧：runAgentLoop 内部只用到 ctx.res.write 一处（SSE 写流）——
 *   给每个幽灵传一个 fake ctx，把 res.write 转发到事件总线，即可零改动复用主 Agent 循环。
 */
import { EventEmitter } from 'events'
import { basename, join, normalize } from 'path'
import { getDB } from './database'
import { config } from '../config'
import { runAgentLoop } from './agent'
import { getLLMConfig, normalizeBaseUrl } from './llm-config'

// ---- 常量 ----
export const GHOST_MAX_CONCURRENCY = 3          // 默认并行幽灵数（设置页可调 1-5）
export const GHOST_SUBTASK_LIMIT = 5            // 最多拆几个子任务
export const GHOST_STEP_BUDGET = 15             // 每幽灵步骤预算（maxTurns，防失控）
export const GHOST_EVAL_MODEL = 'deepseek-v4-flash' // 分解/汇总用的低成本模型

// ---- 事件总线（ws 端点订阅后广播到前端看板）----
export const ghostBus = new EventEmitter()
ghostBus.setMaxListeners(0)

// ---- 类型 ----
export interface GhostSubtask {
  id: string
  title: string
  goal: string
  files: string[]            // 将触碰的文件/目录（用于冲突检测）
  output: string             // 期望产出
  mode?: 'agent' | 'research'  // P3: research = 深度研究内核(多轮搜索+提炼+报告)，agent = 通用 Agent Loop（默认）
}

export interface GhostTaskInput {
  taskId: string
  goal: string               // 用户一句话任务
  workspace: string          // 工作区根目录
  concurrency?: number
  permissionLevel?: 'workspace-only' | 'sandbox' | 'full'
  mode?: 'auto' | 'research' // P3: auto=分解器判定(默认) / research=全部子任务强制深度研究
  sessionId?: string         // 结果回收：绑定会话，任务完成后注入一条汇总消息到主对话
}

export interface GhostGhostResult {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  progress: number           // 0-100 估算
  log: string[]              // 最近动作日志
  output: string             // 幽灵产出（markdown）
  error?: string
  startedAt: number
  finishedAt?: number
  turnsUsed: number
}

export interface GhostTaskState {
  taskId: string
  goal: string
  workspace: string
  status: 'decomposing' | 'running' | 'summarizing' | 'done' | 'failed' | 'stopped'
  createdAt: number
  finishedAt?: number
  subtasks: Array<{ id: string; title: string; goal: string; files: string[]; shared: string[] }>
  ghosts: GhostGhostResult[]
  summary: string
  error?: string
}

// ---- 内存任务状态（阶段 B 落 DB 持久化历史）----
const tasks = new Map<string, GhostTaskState>()
export function getGhostTask(taskId: string) { return tasks.get(taskId) }
export function listGhostTasks() { return Array.from(tasks.values()) }

// ---- 工具：读 LLM 配置（settings → custom_providers(deepseek) → .env 回退链，与主聊天同源）----
// 2026-09-01 抽到 llm-config.ts，供 collab/质检/议院/新引擎复用

async function llmJson(prompt: string, maxTokens = 8000, retries = 2): Promise<any> {
  const { model, apiKey, baseUrl } = getLLMConfig()
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // deepseek-v4-flash 的 max_tokens 同时涵盖 reasoning+content（实测推理常达 1.5 万 tokens），
      // 预算不足会 finish=length 且 content 为空 → 必须给足并重试递增
      const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens * (attempt + 1), temperature: 0.3 }),
      })
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`)
      const data = await resp.json() as any
      const msg = data?.choices?.[0]?.message || {}
      // 优先 content（最终 JSON），content 为空才兜底 reasoning_content
      const text = String(msg.content || '').trim() || String(msg.reasoning_content || '').trim()
      if (!text) throw new Error('LLM 返回空')
      try { return JSON.parse(text.replace(/```json|```/g, '').trim()) }
      catch {
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try { return JSON.parse(text.slice(start, end + 1)) } catch { /* 截断等场景 */ }
        }
        throw new Error(`LLM 未返回 JSON (text: ${text.slice(0, 80)})`)
      }
    } catch (e: any) {
      lastErr = e
      console.warn(`[Ghost] llmJson 尝试 ${attempt + 1} 失败: ${e?.message}`)
    }
  }
  throw lastErr || new Error('LLM 调用失败')
}

// ---- 任务分解器：LLM 拆解 + 文件依赖分析 ----
// 注意：deepseek-v4-flash 对超长 prompt 会深度推理耗尽预算导致 content 为空 → prompt 必须精简
export async function decomposeTask(goal: string, workspace: string, forceResearch = false): Promise<{ subtasks: GhostSubtask[]; raw: string }> {
  const prompt = `你是任务分解器。把用户任务拆成 2-${GHOST_SUBTASK_LIMIT} 个互不依赖、可并行的子任务，每个子任务返回 JSON。

任务：${goal}
工作区：${workspace}

要求：
- 子任务之间不能有先后依赖；不适合并行（强依赖/太简单）就只返回 1 个。
- files 列出该子任务会读取/修改的文件或目录（相对工作区路径或 glob），要精确；不要包含 package.json、pnpm-lock.yaml、tsconfig.json 等公共配置类文件。
- mode 字段：子任务本质是网络调研/信息搜集（多角度搜索资料、对比信息、查证事实，不依赖工作区文件）→ "research"；需要操作文件/执行代码/写产出文件 → "agent"。
${forceResearch ? '- 本次任务已指定深度研究模式：所有子任务 mode 一律填 "research"，files 填 []。' : ''}
- 不要输出任何解释，直接输出 JSON。

{"subtasks":[{"id":"t1","title":"简短标题","goal":"可执行目标","files":["相对路径或glob"],"output":"期望产出","mode":"agent|research"}]}`

  const json = await llmJson(prompt, 12000)
  const raw = JSON.stringify(json)
  const subs: GhostSubtask[] = (json?.subtasks || []).slice(0, GHOST_SUBTASK_LIMIT).map((s: any, i: number) => ({
    id: s.id || `t${i + 1}`,
    title: String(s.title || `子任务 ${i + 1}`).slice(0, 40),
    goal: String(s.goal || '').slice(0, 600),
    files: Array.isArray(s.files) ? s.files.map(String) : [],
    output: String(s.output || '').slice(0, 200),
    mode: s.mode === 'research' ? 'research' : 'agent',
  }))
  if (subs.length === 0) throw new Error('分解器未产出子任务')
  return { subtasks: subs, raw }
}

// 路径冲突检测：a/b 是否与 c/d 重叠（归一化 + 前缀匹配）
function pathsOverlap(a: string, b: string): boolean {
  const na = normalize(a).replace(/^\.\//, '').split('/').filter(Boolean)
  const nb = normalize(b).replace(/^\.\//, '').split('/').filter(Boolean)
  if (na.length === 0 || nb.length === 0) return true  // 空 = 全量 = 视为冲突
  const n = Math.min(na.length, nb.length)
  for (let i = 0; i < n; i++) if (na[i] !== nb[i]) return false
  return true
}

// 公共配置类文件（协调者独占，不参与并行）
const SHARED_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'vite.config.ts', 'electron-builder.yml', '.gitignore', 'README.md'])

/**
 * 文件依赖分析：把重叠文件从子任务范围剔除并标记为 shared（协调者处理）。
 * 返回清理后的子任务（每个子任务带 shared 列表）。若两个子任务在非共享文件上仍重叠 → 保留但打 warning（由调用方决定降级）。
 */
export function analyzeFileConflicts(subtasks: GhostSubtask[]): { subtasks: Array<GhostSubtask & { shared: string[] }>; warnings: string[] } {
  const warnings: string[] = []
  const cleaned = subtasks.map((st) => {
    const kept: string[] = []
    const shared: string[] = []
    for (const f of st.files || []) {
      if (SHARED_FILES.has(basename(f))) { shared.push(f); continue }
      kept.push(f)
    }
    return { ...st, files: kept, shared }
  })
  // 两两检查非共享范围是否重叠
  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      for (const fi of cleaned[i].files) {
        for (const fj of cleaned[j].files) {
          if (pathsOverlap(fi, fj)) {
            warnings.push(`"${cleaned[i].title}" 与 "${cleaned[j].title}" 文件范围重叠（${fi} ↔ ${fj}），并行可能冲突`)
          }
        }
      }
    }
  }
  return { subtasks: cleaned, warnings }
}

// ---- fake ctx：把 SSE 写流转发到事件总线（runAgentLoop 唯一的外部副作用）----
function createGhostCtx(taskId: string, ghostId: string) {
  const forward = (raw: string) => {
    // 解析 "event: xxx\ndata: {...}\n\n" → 事件名 + 数据
    const evt = raw.match(/^event: (\S+)/m)?.[1] || 'message'
    const data = raw.match(/^data: (.*)$/m)?.[1] || ''
    let parsed: any = null
    try { parsed = JSON.parse(data) } catch { parsed = data }
    ghostBus.emit('event', { taskId, ghostId, event: evt, data: parsed })
  }
  return {
    res: {
      write: (chunk: string) => forward(String(chunk)),
      end: () => {},
      on: () => {},
      once: () => {},
      removeListener: () => {},
      flushHeaders: () => {},
      setNoDelay: () => {},
      setTimeout: () => {},
      socket: null,
    },
    request: { body: {} },
    state: {},
    status: 200,
    set: () => {},
  }
}

// ---- 单幽灵执行（信号量内）----
async function runOneGhost(task: GhostTaskInput, st: GhostSubtask, idx: number, signal: AbortSignal, ghostList: GhostGhostResult[]): Promise<GhostGhostResult> {
  const ghostId = `ghost_${task.taskId}_${idx + 1}`
  const ghost: GhostGhostResult = {
    id: ghostId,
    title: st.title,
    status: 'running',
    progress: 0,
    log: [`开始执行：${st.goal.slice(0, 80)}`],
    output: '',
    startedAt: Date.now(),
    turnsUsed: 0,
  }
  // 立即挂进任务数组（看板实时可见），再广播
  ghostList.push(ghost)
  const broadcast = (patch: Partial<GhostGhostResult>, evt = 'update') => {
    Object.assign(ghost, patch)
    ghostBus.emit(evt, { taskId: task.taskId, ghostId, ghost: { ...ghost }, event: evt })
  }

  const ctx = createGhostCtx(task.taskId, ghostId)
  // 幽灵的 SSE 事件 → 产出收集 + 日志 + 进度
  let finalText = ''
  let toolCalls = 0
  const listener = (e: { taskId: string; ghostId: string; event: string; data: any }) => {
    if (e.taskId !== task.taskId || e.ghostId !== ghostId) return
    if (e.event === 'content') {
      // 每轮最终回复（多轮取拼接，最终回复在最后）
      const txt = typeof e.data?.content === 'string' ? e.data.content : typeof e.data === 'string' ? e.data : ''
      if (txt) {
        finalText += (finalText ? '\n\n' : '') + txt
        broadcast({ output: finalText })
      }
    } else if (e.event === 'tool_call') {
      toolCalls++
      const name = e.data?.toolName || e.data?.name || '工具'
      const arg = e.data?.args?.file || e.data?.file || ''
      broadcast({ progress: Math.min(90, toolCalls * 8), log: [...ghost.log.slice(-4), `→ ${name} ${arg}`.trim()] })
    } else if (e.event === 'tool_result') {
      broadcast({ log: [...ghost.log.slice(-4), '✓ 工具返回'] })
    }
  }
  ghostBus.on('event', listener)

  try {
    // P3: 深度研究模式幽灵 —— 直接跑 deep_research 内核（多轮递归搜索+提炼+3页报告），不跑通用 Agent Loop
    if (st.mode === 'research') {
      broadcast({ log: [...ghost.log, '深度研究模式：多轮递归搜索 + AI 提炼'] })
      const { runDeepResearch } = await import('./deep-research.js')
      const result = await runDeepResearch({
        query: st.goal,
        breadth: 3,
        depth: 2,
        onProgress: (p: any) => broadcast({
          progress: Math.min(90, 10 + ((p.completedQueries || 0) / Math.max(p.totalQueries || 1, 1)) * 70),
          log: [...ghost.log.slice(-4), `深度 ${p.currentDepth}/${p.totalDepth} · 查询 ${p.completedQueries}/${p.totalQueries || '?'}`],
        }),
      })
      finalText = result.report
      if (signal.aborted) {
        ghost.status = 'stopped'
        ghost.log.push('已停止')
      } else {
        ghost.status = 'done'
        ghost.output = finalText
        ghost.progress = 100
        ghost.log.push(`完成（${result.learnings.length} 学习点 / ${result.visitedUrls.length} 来源）`)
      }
      return ghost  // finally 统一收尾（removeListener + done 广播）
    }

    const sessionId = ghostId                       // 幽灵独立会话 → 工具授权隔离
    const sessionCfg = {
      workspaceDir: task.workspace,                 // 幽灵只在自己的工作区范围活动
      permissionLevel: task.permissionLevel || 'sandbox' as const,
    }
    const { model, apiKey, baseUrl } = getLLMConfig()
    const systemPrompt = `你是 SUPERCRZY 幽灵工作台中的一只幽灵，负责一个独立子任务。你的范围：${st.files.join(', ') || '（未指定，谨慎操作）'}。公共文件（package.json 等）不要修改。子任务目标：${st.goal}。完成后用简短总结说明你做了什么。`
    broadcast({ log: [...ghost.log, `配置完成，模型 ${model}`] })

    await runAgentLoop(
      ctx as any,
      [{ role: 'user', content: st.goal }],
      {
        model,
        apiKey,
        baseUrl,
        temperature: 0.6,
        maxTokens: 8192,
        systemPrompt,
        maxTurns: GHOST_STEP_BUDGET,                // 步骤预算：防失控
      },
      undefined,
      sessionId,
      sessionCfg,
      'zh-CN',
    )

    if (signal.aborted) {
      ghost.status = 'stopped'
      ghost.log.push('已停止')
    } else {
      ghost.status = 'done'
      ghost.output = finalText || ghost.output
      ghost.progress = 100
      ghost.log.push('完成')
    }
  } catch (e: any) {
    ghost.status = 'failed'
    ghost.error = e?.message || '执行失败'
    ghost.log.push(`失败：${ghost.error}`)
  } finally {
    ghost.finishedAt = Date.now()
    ghostBus.removeListener('event', listener)
    ghostBus.emit('done', { taskId: task.taskId, ghostId, ghost: { ...ghost } })
  }
  return ghost
}

// ---- 信号量：限制并发 ----
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, idx: number, signal: AbortSignal) => Promise<any>) {
  const results: any[] = new Array(items.length)
  let cursor = 0
  const signal = new AbortController().signal
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await worker(items[i], i, signal)
    }
  })
  await Promise.all(runners)
  return results
}

// ---- 汇总器 ----
async function summarizeTask(goal: string, ghosts: GhostGhostResult[], workspace: string): Promise<string> {
  const done = ghosts.filter((g) => g.status === 'done' && g.output)
  if (done.length === 0) return ghosts.map((g) => `- ${g.title}：${g.error || '无产出'}`).join('\n')
  if (done.length === 1) return done[0].output
  const blocks = done.map((g) => `【${g.title}】\n${g.output.slice(0, 3000)}`).join('\n\n---\n\n')
  const prompt = `你是结果汇总器。用户任务：${goal}\n\n以下是 ${done.length} 个并行幽灵的产出，请合并成一份完整、通顺、有结构的最终报告（保留各部分的实质内容，去掉重复）：\n\n${blocks}\n\n直接输出最终报告正文，不要输出任何思考过程、不要解释你在做什么、不要"我们"/"我"字眼。`
  try {
    const { model, apiKey, baseUrl } = getLLMConfig()
    const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 8000, temperature: 0.4 }),
    })
    if (resp.ok) {
      const data = await resp.json() as any
      const msg = data?.choices?.[0]?.message || {}
      const content = String(msg.content || '').trim()
      // 修复：content 为空时不要直接吞 reasoning_content（会把思考过程当正文）——
      // 只在其包含最终报告痕迹（标题/来源/总结）时兜底，否则重试一次
      if (content) return content
      const reasoning = String(msg.reasoning_content || '').trim()
      if (reasoning && /#{1,3} |来源|Sources|结论|摘要/.test(reasoning)) return reasoning
      // 重试一次：更严格要求只输出正文
      const resp2 = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: `${prompt}\n\n警告：上一次输出不合要求。只输出最终报告正文（Markdown），禁止输出任何思考、解释、过程。` }], max_tokens: 8000, temperature: 0.2 }),
      })
      if (resp2.ok) {
        const d2 = await resp2.json() as any
        const c2 = String(d2?.choices?.[0]?.message?.content || '').trim()
        if (c2) return c2
      }
    }
  } catch { /* 汇总失败用拼接兜底 */ }
  return done.map((g) => `## ${g.title}\n\n${g.output}`).join('\n\n')
}

/** 结果回收：幽灵任务完成后，把汇总注入绑定会话（作为一条 assistant 消息，主对话可见可继续追问） */
function injectGhostResultToSession(sessionId: string, task: GhostTaskState) {
  try {
    const done = task.ghosts.filter((g) => g.status === 'done')
    const failed = task.ghosts.filter((g) => g.status === 'failed' || g.status === 'stopped')
    const lines: string[] = []
    lines.push(`> 幽灵并行结果 · ${done.length} 个子任务完成${failed.length ? ` · ${failed.length} 个未完成` : ''}`)
    lines.push(`**目标**：${task.goal}`)
    if (task.summary) lines.push('', task.summary)
    lines.push('', '---', `**各子任务产出**`, '')
    for (const g of done) {
      lines.push(`### ${g.title}`, '', (g.output || '（无产出）').slice(0, 4000))
    }
    if (failed.length) {
      lines.push('', `**未完成**：${failed.map((g) => `${g.title}（${g.error || g.status}）`).join('；')}`)
    }
    lines.push('', `> 查看完整看板：幽灵工作台 · 任务 ${task.taskId}`)
    const content = lines.join('\n').trim()
    getDB()
      .prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(`msg_ghost_${task.taskId}_${Date.now()}`, sessionId, 'assistant', content)
  } catch (e: any) {
    console.error('[Ghost] inject result to session failed:', e?.message)
  }
}

// ---- 对外主入口：执行一个幽灵任务 ----
export async function runGhostTask(input: GhostTaskInput): Promise<GhostTaskState> {
  const task: GhostTaskState = {
    taskId: input.taskId,
    goal: input.goal,
    workspace: input.workspace,
    status: 'decomposing',
    createdAt: Date.now(),
    subtasks: [],
    ghosts: [],
    summary: '',
  }
  tasks.set(input.taskId, task)

  try {
    // 1. 分解（P3: forceResearch 模式 → 全部分解为深度研究子任务）
    const { subtasks } = await decomposeTask(input.goal, input.workspace, input.mode === 'research')
    const { subtasks: cleaned, warnings } = analyzeFileConflicts(subtasks)
    task.subtasks = cleaned.map((c) => ({ id: c.id, title: c.title, goal: c.goal, files: c.files, shared: c.shared }))
    task.status = 'running'
    ghostBus.emit('task', { taskId: input.taskId, status: 'running', subtasks: task.subtasks, warnings })

    // 2. 并行执行（并发上限：默认 3，可配）
    const concurrency = Math.min(input.concurrency || GHOST_MAX_CONCURRENCY, GHOST_MAX_CONCURRENCY + 2)
    // 幽灵创建后立即挂入 task.ghosts（引用同一数组），看板实时可见
    const ghostList: GhostGhostResult[] = []
    task.ghosts = ghostList
    await runWithConcurrency(cleaned, concurrency, (st, i) => runOneGhost(input, st, i, new AbortController().signal, ghostList))

    // 3. 汇总
    task.status = 'summarizing'
    ghostBus.emit('task', { taskId: input.taskId, status: 'summarizing' })
    task.summary = await summarizeTask(input.goal, task.ghosts, input.workspace)

    task.status = 'done'
    task.finishedAt = Date.now()
    ghostBus.emit('task', { taskId: input.taskId, status: 'done', summary: task.summary })
    // 结果回收：绑定了会话则注入主对话
    if (input.sessionId) injectGhostResultToSession(input.sessionId, task)
  } catch (e: any) {
    task.status = 'failed'
    task.error = e?.message || '任务失败'
    task.finishedAt = Date.now()
    ghostBus.emit('task', { taskId: input.taskId, status: 'failed', error: task.error })
  }
  return task
}

// ---- 停止任务 ----
export function stopGhostTask(taskId: string): boolean {
  const t = tasks.get(taskId)
  if (!t || t.status !== 'running') return false
  t.status = 'stopped'
  t.finishedAt = Date.now()
  t.error = '用户手动停止'
  ghostBus.emit('task', { taskId, status: 'stopped' })
  return true
}
