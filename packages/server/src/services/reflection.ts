// P1.5 Experience Reflection —— 任务完成后自动 5 问反思 → experience 记忆(confidence 0.7)
// 5 问：什么问题 / 什么策略有效 / 用了哪些工具 / 会重复吗 / 该沉淀技能吗
// 对齐手册路线图：Experience→Skill 复利（"AI 内容研究员 Agent" 定位的核心成长机制）
// P1.5 内嵌 deep-research 循环完成钩子（agent.ts 任务完成时调用）

import { config } from '../config/index.js'
import { getDB } from './database.js'
import { randomUUID } from 'crypto'
import { installSkill } from './skill-loader'

export interface ReflectionResult {
  problem: string
  strategy: string
  tools: string[]
  repeat: boolean
  skillWorthy: boolean
  skillName: string
  importance: number
}

function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

async function llmJson(system: string, user: string, fallback: unknown): Promise<any> {
  const apiKey = readSetting('apiKey') || config.deepseek.apiKey
  if (!apiKey) return fallback
  const model = readSetting('model') || config.deepseek.defaultModel
  const baseUrl = normalizeBaseUrl(readSetting('baseUrl') || config.deepseek.baseUrl)
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: `${system}\n\n你只能输出一个合法的 JSON 对象，不要输出任何其他文字，不要用代码块围栏。` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 150)}`)
  }
  const data = await resp.json() as any
  const text = data?.choices?.[0]?.message?.content || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object') return parsed
    throw new Error('non-object')
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fallthrough */ }
    }
    return fallback
  }
}

const REFLECTION_SYSTEM = `You are an experience reflection engine for an AI agent. After a task completes, you reflect on what happened and decide whether the experience is worth remembering. Be honest and concise. Prefer concrete, reusable insights over generic statements.`

/**
 * 任务完成后 5 问反思 → 写入 category='experience' 记忆
 * 返回 null 表示不反思（无工具调用 = 简单问答，无沉淀价值）
 */
export async function runReflection(opts: {
  userContent: string
  toolCalls: string[]
  summary: string
}): Promise<ReflectionResult | null> {
  const { userContent, toolCalls, summary } = opts
  // 简单问答（无工具调用）不反思
  if (!toolCalls || toolCalls.length === 0) return null

  const toolsStr = [...new Set(toolCalls)].join(', ')
  const user = `Reflect on the completed task below and answer 5 questions.
<user_prompt>${userContent.slice(0, 2000)}</user_prompt>
<tools_used>${toolsStr}</tools_used>
<task_summary>${summary.slice(0, 3000)}</task_summary>

Questions:
1. problem: what problem was this task solving? (1 short sentence)
2. strategy: what strategy or approach worked well? (1-2 sentences, concrete and reusable)
3. repeat: is this kind of task likely to recur?
4. skillWorthy: should this approach be distilled into a reusable SKILL (aligning with Agent Skills open standard)?
5. skillName: if skillWorthy, propose a short skill name (lowercase, hyphenated, English)
6. importance: importance of this experience, 1-10 (5 = normal, 8+ = high-value reusable strategy)

Return JSON: {"problem": "...", "strategy": "...", "tools": ["..."], "repeat": true/false, "skillWorthy": true/false, "skillName": "...", "importance": 5}`

  let result: ReflectionResult | null = null
  try {
    const res = await llmJson(REFLECTION_SYSTEM, user, {
      problem: '',
      strategy: '',
      tools: toolCalls.slice(0, 5),
      repeat: false,
      skillWorthy: false,
      skillName: '',
      importance: 5,
    })
    result = {
      problem: String(res.problem || '').slice(0, 200),
      strategy: String(res.strategy || '').slice(0, 500),
      tools: Array.isArray(res.tools) ? res.tools.map(String).slice(0, 10) : toolCalls.slice(0, 10),
      repeat: !!res.repeat,
      skillWorthy: !!res.skillWorthy,
      skillName: String(res.skillName || '').slice(0, 80),
      importance: Math.min(Math.max(parseInt(res.importance) || 5, 1), 10),
    }
  } catch (e: any) {
    console.log(`[Reflection] LLM 反思失败: ${e?.message || e}`)
    return null
  }

  // 只沉淀有价值的经验：会重复 或 值得沉淀技能 且 有实质内容
  if (!result.repeat && !result.skillWorthy) return null
  if (!result.strategy && !result.problem) return null

  const db = getDB()
  const id = randomUUID()
  const key = `经验:${result.skillName || result.problem.slice(0, 24)}`
  const content = `[任务] ${userContent.slice(0, 300)}\n[问题] ${result.problem}\n[策略] ${result.strategy}\n[工具] ${result.tools.join(', ')}\n[会重复] ${result.repeat}\n[该沉淀技能] ${result.skillWorthy}${result.skillName ? ` → ${result.skillName}` : ''}`
  const now = new Date().toISOString()
  try {
    db.prepare(
      'INSERT INTO agent_memory (id, key, content, category, importance, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, key, content, 'experience', result.importance, 0.7, now, now)
    console.log(`[Reflection] 已沉淀经验记忆 (importance=${result.importance}, skillWorthy=${result.skillWorthy})`)
  } catch (e: any) {
    console.log(`[Reflection] 写入记忆失败: ${e?.message || e}`)
    return null
  }

  // P2 Skill Generation：LLM 自主判定值得沉淀 → 生成 Agent Skill 入库（对齐 Hermes skill_manage）
  if (result.skillWorthy && result.skillName) {
    await generateSkillFromReflection(result)
  }

  return result
}

const SKILL_GEN_SYSTEM = `You are a skill generation engine. Based on a reflected experience, produce a reusable Agent Skill definition (aligned with the Agent Skills open standard, SKILL.md). The prompt_template must be complete, self-contained instructions that let another agent execute this skill correctly. Be concrete and actionable.`

/** P2：经验 → Agent Skill（LLM 生成定义并入库） */
async function generateSkillFromReflection(result: ReflectionResult): Promise<void> {
  const user = `Generate an Agent Skill from this reflected experience:
<problem>${result.problem}</problem>
<strategy>${result.strategy}</strategy>
<tools>${result.tools.join(', ')}</tools>
<proposed_name>${result.skillName}</proposed_name>

Return JSON: {"name": "lowercase-hyphenated-english-name", "description": "one-sentence description (Chinese OK)", "category": "development|search|creative|office|automation|analysis", "prompt_template": "complete Chinese step-by-step instructions for executing this skill, including tool usage and output format", "tools": ["web_search","web_fetch"], "trigger_keywords": "中文触发词1,keyword2,关键词3"}`
  let res: any = null
  try {
    res = await llmJson(SKILL_GEN_SYSTEM, user, null)
  } catch (e: any) {
    console.log(`[Reflection] 技能生成 LLM 调用失败: ${e?.message || e}`)
    return
  }
  if (!res || !res.name) {
    console.log('[Reflection] 技能生成结果无效，跳过')
    return
  }
  try {
    installSkill({
      name: String(res.name).slice(0, 60),
      description: String(res.description || '').slice(0, 200),
      category: String(res.category || 'analysis').slice(0, 30),
      icon: 'code',
      enabled: 1,
      trigger_keywords: String(res.trigger_keywords || result.skillName).slice(0, 300),
      prompt_template: String(res.prompt_template || result.strategy).slice(0, 3000),
      tools: Array.isArray(res.tools) ? JSON.stringify(res.tools.slice(0, 10)) : '["web_search"]',
      is_builtin: 0,
    })
    console.log(`[Reflection] 已自动生成技能: ${res.name}`)
  } catch (e: any) {
    console.log(`[Reflection] 技能入库失败: ${e?.message || e}`)
  }
}
