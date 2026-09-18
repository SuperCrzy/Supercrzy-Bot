/**
 * 全自动众议院 · 项目会诊（2026-09-01 mini 版）
 * 输入项目路径 → 扫描结构生成"项目地图" → DeepSeek/Kimi 并行审不同区域找问题
 * → 汇总去重 → 输出带 文件:行号 的问题清单。
 * 第一版只"找问题"，不改文件（先让用户确认找得准，再接执行AI修复）。
 */
import { readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join, extname, relative } from 'path'
import { chatWithProvider } from './llm-config'

export interface AuditIssue {
  file: string
  line?: number
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
}
export interface AuditReport {
  project: string
  filesScanned: number
  members: Array<{ provider: string; brand: string; fileCount: number }>
  issues: AuditIssue[]
  membersRaw: Array<{ brand: string; raw: string }>
  generatedAt: number
}

// 跳过目录（避免 node_modules/dist/.git 爆炸）
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.workbuddy', 'uploads', 'data'])
const MAX_FILES = 60         // 单项目最多扫描文件数
const MAX_BYTES = 60 * 1024  // 单文件最多读 60KB
const MAX_CHARS_PER_MEMBER = 5200  // 每个成员最多喂的代码量

/**
 * 递归扫描项目文件，生成 [{path, rel, preview}]（preview 为截断内容）
 *
 * 全异步（2026-09-18）：原实现用 readdirSync + statSync + readFileSync 递归，
 * 会在扫盘全程同步占住事件循环（实测 4k 文件约 62ms，大仓库线性放大），
 * 而"项目会诊"是后台跑、和前台对话并发的——扫盘期间用户看到的 SSE 会整体停推。
 * 改用 fs/promises 后同样的裁剪上限（MAX_FILES/MAX_BYTES/SKIP_DIRS）一并保留。
 */
export async function scanProject(root: string): Promise<Array<{ rel: string; preview: string; bytes: number }>> {
  const out: Array<{ rel: string; preview: string; bytes: number }> = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return
    let entries: Dirent[] = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (SKIP_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      // 只看代码/可读文本
      const ext = extname(e.name).toLowerCase()
      if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.sh', '.json', '.vue', '.html', '.css', '.md', '.sql'].includes(ext)) continue
      try {
        // 用 stat 而不是 dirent.isFile()：保留原语义（跟随符号链接），且反正要读 size
        const st = await stat(p)
        if (!st.isFile() || st.size > MAX_BYTES) continue
        const content = await readFile(p, 'utf8')
        out.push({ rel: relative(root, p), preview: content.slice(0, 700), bytes: content.length })
      } catch { /* ignore */ }
    }
  }
  await walk(root)
  return out
}

function memberPrompt(brand: string, project: string, files: Array<{ rel: string; preview: string }>): string {
  const scoped = files.slice(0, 8)
  const code = scoped.map((f) => `### ${f.rel}\n${f.preview}`).join('\n\n')
  return `你是众议院审计成员（模型 ${brand}）。请审查以下项目代码，找出确定存在的 BUG / 安全问题 / 逻辑错误。
项目：${project}，分配给你审查的文件共 ${scoped.length} 个：

${code}

要求：只报告你从代码能确定的问题，不要臆测。直接输出 JSON 数组，无问题输出 []：
[{"file":"相对路径","line":行号,"severity":"high|medium|low","title":"标题","detail":"说明"}]`
}

/** 并行跑多个成员审项目，返回各自 raw + 汇总问题 */
export async function runProjectAudit(
  projectPath: string,
  providers: string[] = ['deepseek', 'kimi'],
  instruction = '找出这个项目的 BUG、安全隐患、逻辑错误',
): Promise<AuditReport> {
  const files = await scanProject(projectPath)
  const issues: AuditIssue[] = []
  const membersRaw: Array<{ brand: string; raw: string }> = []
  const members: Array<{ provider: string; brand: string; fileCount: number }> = []
  const brands = ['DeepSeek', 'Kimi']

  // 并行：各成员审文件子集
  await Promise.all(providers.map(async (provider, idx) => {
    const brand = brands[idx] || provider
    const subset = files.filter((_, i) => i % providers.length === idx)  // 交错分配
    if (subset.length === 0) return
    const prompt = memberPrompt(brand, projectPath, subset)
    let raw = ''
    try {
      // 推理模型 max_tokens 涵盖推理+输出；给足 4000 + 60s 超时（防单个成员卡死拖垮全队）
      raw = await chatWithProvider(provider, [{ role: 'user', content: prompt }], { maxTokens: 4000, temperature: 0.2, timeoutMs: 60000 })
    } catch { raw = '' }
    members.push({ provider, brand, fileCount: subset.length })
    membersRaw.push({ brand, raw })
    // 解析 JSON 数组
    const start = raw.indexOf('['), end = raw.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        const arr = JSON.parse(raw.slice(start, end + 1)) as Array<{ file?: string; line?: number; severity?: string; title?: string; detail?: string }>
        for (const it of arr) {
          if (!it?.file || !it?.title) continue
          issues.push({
            file: it.file, line: it.line, severity: (it.severity === 'high' || it.severity === 'low' ? it.severity : 'medium'),
            title: it.title, detail: it.detail || '',
          })
        }
      } catch { /* JSON 解析失败，保留 raw */ }
    }
  }))

  return { project: projectPath, filesScanned: files.length, members, issues, membersRaw, generatedAt: Date.now() }
}
