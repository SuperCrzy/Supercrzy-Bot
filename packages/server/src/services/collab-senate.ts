/**
 * 超级协作平台 — 议院模式（P4）
 * 任务 done 后，多位"议员"（不同角色视角）各自独立审查交付物并投票（通过/打回/弃权）。
 * 过半数通过 pass；有 high 问题或多数打回 → review（需修订）。
 * 第一版用同一模型 DeepSeek 以不同角色 prompt 分饰议员（多模型 key 齐全后可换不同模型族）。
 */
import { getLLMConfig, normalizeBaseUrl } from './ghost-engine'

export interface SenateVote {
  senator: string        // 议员名/视角
  verdict: 'pass' | 'reject' | 'abstain'
  score: number
  issues: Array<{ severity: string; dimension: string; title: string; evidence: string }>
  summary: string
}
export interface SenateReport {
  taskId: string
  status: 'pass' | 'review'
  votes: SenateVote[]
  totalSenators: number
  passCount: number
  rejectCount: number
  generatedAt: number
}

/** 议员阵容（角色视角；真多模型 key 到后可换不同 provider） */
const SENATORS = [
  { name: '功能议长', focus: '功能完整性：任务每个要求是否都实现，有无遗漏功能/边界/空态' },
  { name: '逻辑辩手', focus: '逻辑一致性：论证是否严密，有无自相矛盾、推断过强、无依据结论' },
  { name: '事实核查员', focus: '事实准确性：断言是否有来源支撑，有无虚假/夸张/无法核验的信息' },
]

async function llm(prompt: string, maxTokens = 4000): Promise<string> {
  const { model, apiKey, baseUrl } = getLLMConfig()
  const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.2 }),
  })
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`)
  const data = await resp.json() as any
  return String(data?.choices?.[0]?.message?.content || '').trim()
}

async function runSenator(name: string, focus: string, goal: string, report: string): Promise<SenateVote> {
  const safeReport = String(report || '').slice(0, 4000)
  const prompt = `你是超级协作平台的议员「${name}」，负责：${focus}。\n
用户任务：${goal}\n\n交付报告：\n${safeReport}\n\n
请从你的视角独立审查，直接输出 JSON（只输出 JSON，不做任何其他文字、不加代码块）：
{"verdict":"pass|reject","score":0,"issues":[{"severity":"high|medium|low","dimension":"","title":"","evidence":""}],"summary":"40字内意见"}`
  try {
    const text = await llm(prompt)
    const start = text.indexOf('{'), end = text.lastIndexOf('}')
    const p = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {}
    return {
      senator: name,
      verdict: (p.verdict === 'reject' ? 'reject' : 'pass'),
      score: Number(p.score || 0),
      issues: Array.isArray(p.issues) ? p.issues : [],
      summary: String(p.summary || ''),
    }
  } catch (e: any) {
    return { senator: name, verdict: 'abstain', score: 0, issues: [{ severity: 'high', dimension: '议院', title: '议员调用失败', evidence: String(e?.message) }], summary: '此议员暂不可用' }
  }
}

/** 议院审查：并行跑所有议员，汇总投票；任一议员失败 → abstain（容错，不阻塞整体） */
export async function runSenateReview(goal: string, report: string, taskId: string): Promise<SenateReport> {
  const results = await Promise.all(SENATORS.map(s => runSenator(s.name, s.focus, goal, report)))
  const passCount = results.filter(v => v.verdict === 'pass').length
  const rejectCount = results.filter(v => v.verdict === 'reject').length
  const hasHigh = results.some(v => v.issues.some(i => i.severity === 'high'))
  const status: 'pass' | 'review' = (passCount > rejectCount && !hasHigh) ? 'pass' : 'review'
  return { taskId, status, votes: results, totalSenators: SENATORS.length, passCount, rejectCount, generatedAt: Date.now() }
}
