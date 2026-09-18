/**
 * 全自动众议院 · 工具型会诊（2026-09-01）
 * 纯 LLM 灌代码找 bug 实测 0 问题（低效）——改用 runAgentLoop 工具型引擎：
 * 每个成员带工具(read/grep/cat/ls)像人一样真实检索项目，逐步调查后下结论。
 *
 * 关键技术：runAgentLoop 强绑 SSE(ctx.res.write)，把结论发在事件流里。
 * 这里用"捕获式哑 ctx"——res.write 解析 SSE 帧，累积 content 事件得最终结论，done 结束。
 */
import { Context } from 'koa'
import { getDB } from './database'
import { runAgentLoop } from './agent'

interface CaptureCtx {
  content: string
  done: boolean
  toolCalls: string[]
}

/** 跑一次工具型审计成员（runAgentLoop + 捕获式哑 ctx），返回 AI 最终审计文本 */
export async function runToolAuditMember(opts: {
  provider: 'deepseek' | 'kimi'
  model: string
  target: string          // 审计的项目目录（作为 workspaceDir，AI 在此检索）
  instruction: string
  maxTurns?: number
}): Promise<{ text: string; toolCalls: string[]; error?: string }> {
  const db = getDB()
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='apiKey'").get() as any
  const apiKey = keyRow?.value || ''

  const c: CaptureCtx = { content: '', done: false, toolCalls: [] }
  // 捕获式哑 ctx：res.write 解析 SSE 帧，累积 content，done 结束
  const ctx = {
    res: {
      write(buf: unknown) {
        try {
          const text = String(buf)
          // emitSSE 帧格式：id:x\nevent:y\ndata:{json}\n\n（可能一次多帧叠在一个 chunk）
          let pos = 0
          while (pos < text.length) {
            const frameEnd = text.indexOf('\n\n', pos)
            if (frameEnd < 0) break
            const frame = text.slice(pos, frameEnd)
            pos = frameEnd + 2
            const event = /event:\s*(\w+)/.exec(frame)?.[1] || ''
            const dataMatch = /data:\s*(\{.*\})\s*$/s.exec(frame)
            if (!dataMatch) continue
            const d = JSON.parse(dataMatch[1])
            if (event === 'content') c.content += (d as any).content || ''
            else if (event === 'thinking_chunk') { /* 不捕获思考 */}
            else if (event === 'tool_call') c.toolCalls.push((d as any)?.name || '')
            else if (event === 'done') c.done = true
            else if (event === 'delivery_summary' && (d as any)?.summary) c.content += '\n' + (d as any).summary
          }
        } catch { /* 帧解析失败忽略 */ }
        return true
      },
      end: () => {},
    },
    req: {},
  } as unknown as Context

  try {
    await runAgentLoop(
      ctx,
      [{ role: 'user', content: `请完整审计目录 ${opts.target} 下的代码，找出确定存在的 BUG / 安全问题 / 逻辑错误。用工具(grep/cat/ls/find)逐步检索，最后列出带 文件:行号 的问题清单。${opts.instruction}` }],
      {
        model: opts.model,
        apiKey,
        temperature: 0.3,
        maxTokens: 8000,   // 关键：足够 maxTokens，否则推理模型截断导致 400
        systemPrompt: `你是众议院审计成员（模型 ${opts.provider === 'kimi' ? 'Kimi' : 'DeepSeek'}）。用工具真实检索项目找 bug，只报告能确定的，给出文件:行号。最后输出结构化问题清单。`,
        maxTurns: opts.maxTurns || 14,
        actor: opts.provider === 'kimi' ? 'Kimi' : 'DeepSeek',
      },
      undefined,
      `audit-${opts.provider}`,
      { workspaceDir: opts.target, permissionLevel: 'workspace-only' as const },
      'zh-CN',
    )
  } catch (e: any) {
    return { text: c.content, toolCalls: c.toolCalls, error: e?.message || String(e) }
  }
  return { text: c.content, toolCalls: c.toolCalls }
}
