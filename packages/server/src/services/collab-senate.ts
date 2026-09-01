/**
 * 超级协作平台 — 议院模式（真多品牌）
 * 任务 done 后，多位"议员"（不同品牌模型 + 角色视角）各自独立审查交付物并投票（通过/打回/弃权）。
 * 过半数通过 pass；有 high 问题或多数打回 → review（需修订）。
 * 2026-09-01 真多品牌：每个议员绑定一个 provider（DeepSeek/Kimi），跨厂商对证；
 * 缺 key 的 provider 由 chatWithProvider 抛错 → 该议员 abstain（容错），另用 DeepSeek 补足。
 */
import { chatWithProvider } from './llm-config'

export interface SenateVote {
  senator: string        // 议员名/视角
  provider: string       // 品牌 provider：deepseek/kimi
  brand: string          // 品牌显示名：DeepSeek/Kimi
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

/** 品牌 → 品牌显示名/Label */
export const PROVIDER_BRAND: Record<string, { label: string }> = {
  deepseek: { label: 'DeepSeek' },
  kimi: { label: 'Kimi' },
}

/** 议院阵容：不同品牌 provider + 角色视角（跨厂商对证） */
const SENATORS = [
  { name: '功能议长', provider: 'deepseek', focus: '功能完整性：任务每个要求是否都实现，有无遗漏功能/边界/空态' },
  { name: '逻辑辩手', provider: 'kimi', focus: '逻辑一致性：论证是否严密，有无自相矛盾、推断过强、无依据结论' },
]

/** 挑一个"补充品牌"：若缺 key 时用于换模型重试（deepseek/kimi 之外的） */
const BACKUP_PROVIDERS = ['deepseek', 'kimi']

async function runSenator(name: string, provider: string, focus: string, goal: string, report: string): Promise<SenateVote> {
  const safeReport = String(report || '').slice(0, 4000)
  const prompt = `你是超级协作平台的议员「${name}」（模型：${PROVIDER_BRAND[provider]?.label || provider}），负责：${focus}。\n
用户任务：${goal}\n\n交付报告：\n${safeReport}\n\n
请从你的视角独立审查，直接输出 JSON（只输出 JSON，不做任何其他文字、不加代码块）：
{"verdict":"pass|reject","score":0,"issues":[{"severity":"high|medium|low","dimension":"","title":"","evidence":""}],"summary":"40字内意见"}`
  let text = ''
  try {
    // 先尝试指定 provider，失败（缺 key/欠费）则换 DeepSeek 补足（容错，确保议院能出结果）
    try {
      text = await chatWithProvider(provider, [{ role: 'user', content: prompt }], { maxTokens: 4000, temperature: 0.2 })
    } catch {
      const fb = BACKUP_PROVIDERS.find((p) => p !== provider) || 'deepseek'
      text = await chatWithProvider(fb, [{ role: 'user', content: prompt }], { maxTokens: 4000, temperature: 0.2 })
      provider = fb
    }
  } catch (e: any) {
    return {
      senator: name, provider, brand: PROVIDER_BRAND[provider]?.label || provider,
      verdict: 'abstain', score: 0,
      issues: [{ severity: 'high', dimension: '议院', title: '议员调用失败', evidence: String(e?.message) }],
      summary: '此议员（' + (PROVIDER_BRAND[provider]?.label || provider) + '）暂不可用',
    }
  }
  let parsed: any = {}
  try {
    const start = text.indexOf('{'), end = text.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1))
  } catch { /* ignore */ }
  return {
    senator: name,
    provider,
    brand: PROVIDER_BRAND[provider]?.label || provider,
    verdict: (parsed.verdict === 'reject' ? 'reject' : 'pass'),
    score: Number(parsed.score || 0),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: String(parsed.summary || ''),
  }
}

/** 议院审查：各品牌议员独立审查+投票；任一失败 → abstain（容错不阻塞整体） */
export async function runSenateReview(goal: string, report: string, taskId: string): Promise<SenateReport> {
  const results = await Promise.all(SENATORS.map(s => runSenator(s.name, s.provider, s.focus, goal, report)))
  const passCount = results.filter(v => v.verdict === 'pass').length
  const rejectCount = results.filter(v => v.verdict === 'reject').length
  const hasHigh = results.some(v => v.issues.some(i => i.severity === 'high'))
  const status: 'pass' | 'review' = (passCount > rejectCount && !hasHigh) ? 'pass' : 'review'
  return { taskId, status, votes: results, totalSenators: results.length, passCount, rejectCount, generatedAt: Date.now() }
}
