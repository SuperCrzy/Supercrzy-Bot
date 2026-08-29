/**
 * 超级协作平台 — 分层质检（P2）
 * L2 质检 Agent：任务 done 后，对照用户 goal 审查最终报告/产出，产出带证据的结构化质检报告。
 * L1 机器检查：可选，检测产出中是否有代码文件则跑未接（P3 浏览器/代码检查接入）。
 * 质检结果附加到 collab 任务（内存态，与 collab 同生命周期），前端展示。
 */
import { getLLMConfig, normalizeBaseUrl } from './ghost-engine'

export interface QualityIssue {
  severity: 'high' | 'medium' | 'low'
  dimension: string   // 功能完整 / 逻辑 / 事实 / 格式 / 边界
  title: string
  evidence: string    // 证据：引用报告片段/缺失项
}
export interface QualityReport {
  taskId: string
  status: 'pass' | 'review'
  score: number                  // 0-100
  dimensions: Record<string, number>  // 各维度评分
  issues: QualityIssue[]
  summary: string                // 质检总评
  generatedAt: number
}

/** 对单一 LLM 调用（复用 config） */
async function llm(prompt: string, maxTokens = 3000): Promise<string> {
  const { model, apiKey, baseUrl } = getLLMConfig()
  const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
  })
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`)
  const data = await resp.json() as any
  return String(data?.choices?.[0]?.message?.content || '').trim()
}

/**
 * L2 质检 Agent：对照 goal 审查最终报告。
 * @param goal 用户原始任务
 * @param report 最终交付报告（summary 或各 ghost 产出拼接）
 */
export async function runQualityReview(goal: string, report: string, taskId: string): Promise<QualityReport> {
  const safeReport = String(report || '').slice(0, 5000)
  const prompt = `你是超级协作平台的质检 AI。任务：${goal}\n\n以下是交付报告：\n\n${safeReport}\n\n请对报告做全面质检，从以下维度打分（0-100 每维度），并列出需要改进的问题。\n
维度：功能完整性(是否覆盖任务要求)、逻辑一致性、事实准确性(有无可疑/无来源断言)、格式规范性、边界处理(空态/异常/遗漏)。\n
【严格要求】只输出合法的 JSON 对象，不要输出任何其他文字、不要 Markdown 代码块、不要思考过程。格式：\n
{"dimensions":{"功能完整":80,"逻辑":85,"事实":70,"格式":90,"边界":60},"score":77,"issues":[{"severity":"high|medium|low","dimension":"逻辑","title":"问题标题","evidence":"具体证据/引用报告哪部分/缺失什么"}],"summary":"50字以内总评"}\n
如果某个维度没有发现问题，issues 可以为空数组。务必保证 JSON 合法、唯一、可被 JSON.parse 直接解析。`
  let text = ''
  try { text = await llm(prompt, 4000) } catch (e: any) {
    // 降级：LLM 失败时给个基础报告，不阻塞
    return { taskId, status: 'review', score: 0, dimensions: {}, issues: [{ severity: 'medium', dimension: '质检', title: '质检模型调用失败', evidence: String(e?.message) }], summary: '质检暂不可用', generatedAt: Date.now() }
  }
  // 解析 JSON
  let parsed: Partial<QualityReport> = {}
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1))
  } catch { /* ignore */ }
  const dimensions = (parsed.dimensions as Record<string, number>) || {}
  const score = Math.round(parsed.score ?? defaultScore(dimensions))
  const issues = Array.isArray(parsed.issues) ? parsed.issues as QualityIssue[] : []
  return {
    taskId,
    status: issues.some(i => i.severity === 'high') ? 'review' : 'pass',
    score,
    dimensions,
    issues,
    summary: String(parsed.summary || ''),
    generatedAt: Date.now(),
  }
}

function defaultScore(dims: Record<string, number>): number {
  const vals = Object.values(dims).filter(n => typeof n === 'number')
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0
}
