/**
 * 技能进化引擎（进化闭环 B/C）：
 * - maybeCreateSkill：复杂任务完成后自动提炼为 agentskills.io 标准 SKILL.md（自动技能创建）
 * - maybeRepairSkill：技能被使用但任务失败时，自动打补丁改进技能（技能自修补）
 *
 * 与 Playbook 复盘互补：Playbook 存"一句话经验"（注入提示词），技能存"可复用步骤工作流"
 * （按需加载 + 自修补）——后者是 Hermes "越用越强"的核心机制。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDB } from './database'
import { syncFileSkills, skillToDirName } from './skill-loader'

interface EvolveBaseOpts {
  userTask: string
  tools: string[]
  turns: number
  files: number
  lastContent: string
  apiKey: string
  baseUrl: string
  workspaceDir: string
  roleName?: string
}

function normalizeBaseUrl(url: string): string {
  return (url || 'https://api.deepseek.com').replace(/\/+$/, '')
}

/** 调便宜模型并解析 JSON（容错 code fence；deepseek-v4-flash 是推理模型，content 偶发为空 → 自动重试） */
async function llmJson(prompt: string, apiKey: string, baseUrl: string, maxTokens = 1000): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey.startsWith('tp-') ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: attempt === 0 ? 0.3 : 0.5,
        }),
      })
      if (!resp.ok) return null
      const data = await resp.json() as any
      const text = data.choices?.[0]?.message?.content || ''
      if (!text) continue  // 推理未完成（content 空）→ 重试一次
      try {
        return JSON.parse(text.replace(/```json|```/g, '').trim())
      } catch {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) { try { return JSON.parse(m[0]) } catch {} }
      }
      return null
    } catch { return null }
  }
  return null
}

/** 技能是否已存在（DB 或文件目录） */
function skillExists(workspaceDir: string, name: string): boolean {
  try {
    const db = getDB()
    const row = db.prepare('SELECT name FROM skills WHERE name = ? LIMIT 1').get(name) as any
    if (row) return true
  } catch { /* 表不存在忽略 */ }
  const dir = join(workspaceDir, 'data', 'skills', skillToDirName(name))
  return existsSync(join(dir, 'SKILL.md'))
}

// ================= 自动技能创建（闭环 B） =================

/**
 * 任务完成后调用：评估是否值得提炼成技能。
 * 触发条件（对齐 Hermes）：复杂任务 = 去重工具数 >= 5 且轮次 >= 5
 */
export async function maybeCreateSkill(opts: EvolveBaseOpts): Promise<boolean> {
  try {
    const uniqueTools = [...new Set(opts.tools)].filter(Boolean)
    // 复杂任务门槛：总工具调用 >= 5 且轮次 >= 5 且至少 3 种工具（Hermes 口径是"5+ 次工具调用"）
    if (opts.turns < 5 || opts.tools.length < 5 || uniqueTools.length < 3) return false

    const prompt = `你是技能提炼专家。根据以下 Agent 任务执行记录，判断是否值得沉淀为可复用技能，并提炼成步骤式工作流。

任务: ${opts.userTask.slice(0, 200)}
执行轮数: ${opts.turns}
工具调用序列: ${uniqueTools.join(' → ')}
产出文件: ${opts.files} 个
最终结果: ${opts.lastContent.slice(0, 300)}

判断标准：该任务是否为"可重复发生的固定流程"（如：体检项目、抓取数据、代码审计、生成报告——而非一次性聊天）。若是则提炼，否则输出 {"skip": true}。

严格输出 JSON（不要其他文字）:
{"skip": false, "name": "英文小写连字符技能名(4-30字符)", "description": "一句话中文描述(≤40字)", "steps": ["步骤1", "步骤2", "步骤3", ...]}`

    const parsed = await llmJson(prompt, opts.apiKey, opts.baseUrl)
    if (!parsed || parsed.skip) return false
    const name = String(parsed.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30)
    if (!name || name.length < 4) return false
    const steps = Array.isArray(parsed.steps) ? parsed.steps.map((s: any) => String(s).trim()).filter(Boolean) : []
    if (steps.length < 3) return false

    // 防重复：同名技能已存在则跳过（避免刷屏）
    if (skillExists(opts.workspaceDir, name)) return false

    // 生成 agentskills.io 标准 SKILL.md
    const description = String(parsed.description || name).slice(0, 60)
    const body = [
      `# ${name}`,
      '',
      `任务：${opts.userTask.slice(0, 120)}`,
      '',
      '## 执行步骤',
      ...steps.map((s: string, i: number) => `${i + 1}. ${s}`),
      '',
      '## 常见坑',
      `- 本技能由任务自动提炼生成（${opts.turns} 轮 / ${uniqueTools.length} 种工具），首次使用时如发现不足，任务失败会自动修补。`,
    ].join('\n')
    const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

    const dir = join(opts.workspaceDir, 'data', 'skills', skillToDirName(name))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf-8')

    // 同步到 DB（skill-loader 已有 syncFileSkills）
    try { syncFileSkills(opts.workspaceDir) } catch { /* 同步失败不阻塞 */ }
    console.log(`[SkillEvolve] 自动创建技能: ${name}（${steps.length} 步）`)
    return true
  } catch (err: any) {
    console.warn(`[SkillEvolve] 技能创建失败: ${err.message}`)
    return false
  }
}

// ================= 技能自修补（闭环 C） =================

/**
 * 任务失败且使用了技能时调用：让模型给技能 SKILL.md 打补丁。
 * 检测锚点：agent 主循环把本次命中的技能名传给本函数；失败任务才会触发。
 */
export async function maybeRepairSkill(opts: EvolveBaseOpts & { usedSkills: string[]; failureReason?: string }): Promise<boolean> {
  try {
    const skills = (opts.usedSkills || []).filter(Boolean)
    if (skills.length === 0) return false
    // 只修 data/skills 下的自动生成技能（不碰用户手工/市场安装的技能，避免越权改用户资产）
    const candidates = skills.filter((name) => skillExists(opts.workspaceDir, name))
    if (candidates.length === 0) return false

    const name = candidates[0]
    const skillFile = join(opts.workspaceDir, 'data', 'skills', skillToDirName(name), 'SKILL.md')
    if (!existsSync(skillFile)) return false
    // 精简技能原文（推理模型对长 prompt 思考过长会吃满 max_tokens → content 为空；只给核心步骤）
    const originalMd = readFileSync(skillFile, 'utf-8')
    const stepsPart = originalMd.split('## 执行步骤')[1]?.split('##')[0]?.trim() || originalMd.slice(0, 400)

    const prompt = `你是技能维护专家。技能执行失败，请修补。直接给出 JSON，不要任何分析过程。

技能名: ${name}
技能当前步骤:
${stepsPart.slice(0, 600)}

失败任务: ${opts.userTask.slice(0, 150)}
执行轮数: ${opts.turns}
失败原因: ${(opts.failureReason || '未说明').slice(0, 120)}

修补：保留原步骤，修正错误步骤，末尾补充"## 常见坑"小节。

严格输出 JSON（不要其他文字）:
{"patchedBody": "修补后的完整技能 body（不含 frontmatter，纯 Markdown）"}`

    // 修补 prompt 含技能全文，推理模型思考长 → 需要大 max_tokens（2000）
    const parsed = await llmJson(prompt, opts.apiKey, opts.baseUrl, 2000)
    if (!parsed || !parsed.patchedBody) return false
    const patched = String(parsed.patchedBody).trim()
    if (patched.length < 100) return false

    // 保留 frontmatter，替换 body
    const fmMatch = originalMd.match(/^---[\s\S]*?---\n/)
    const fm = fmMatch ? fmMatch[0] : `---\nname: ${name}\ndescription: ${name}\n---\n`
    writeFileSync(skillFile, fm + patched + '\n', 'utf-8')
    try { syncFileSkills(opts.workspaceDir) } catch { /* 忽略 */ }
    console.log(`[SkillEvolve] 已修补技能: ${name}`)
    return true
  } catch (err: any) {
    console.warn(`[SkillEvolve] 技能修补失败: ${err.message}`)
    return false
  }
}
