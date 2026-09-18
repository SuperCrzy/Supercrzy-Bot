/**
 * Skill Loader — 技能文件化系统
 *
 * 技能存储从纯 SQLite → SKILL.md 文件 + SQLite 索引
 * 技能目录：{workspace}/data/skills/{skill-name}/SKILL.md
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync, type Dirent } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDB } from './database'

/* ==================== 技能安全扫描（安装前审计，对齐 WorkBuddy skill-scan） ==================== */

export interface SkillScanIssue {
  file: string
  severity: 'high' | 'medium' | 'low'
  rule: string
  line?: number
  snippet?: string
}

export interface SkillScanReport {
  level: 'safe' | 'warn' | 'danger'
  safe: boolean
  issues: SkillScanIssue[]
  skillNames: string[]
  files: number
  repoUrl: string
}

/** 高危规则：直接拒绝安装 */
const HIGH_RULES: Array<[RegExp, string]> = [
  [/rm\s+-(r|rf|fr)[^|\n]*\s+(\/|\$HOME|~)\b/, '删除根目录或家目录'],
  [/curl[^|\n]*\|\s*(ba|da)?sh\b/, 'curl 管道执行远程脚本'],
  [/wget[^|\n]*\|\s*(ba|da)?sh\b/, 'wget 管道执行远程脚本'],
  [/base64\s*-d[^|\n]*\|\s*(ba|da)?sh\b/, 'base64 解码后管道执行'],
  [/nc\s+-[^|\n]*\s*-e\b/, 'netcat 反弹 shell'],
  [/(curl|wget|nc)[^|\n]*(\.env|id_rsa|\.npmrc)\b/, '网络外发凭据文件'],
  [/chmod\s+777\s+(\/|\$HOME|~)/, '对根目录/家目录放权'],
  [/mkfs|dd\s+if=.*of=\/dev\//, '格式化/覆写磁盘'],
]

/** 中危规则：警告但可安装 */
const MED_RULES: Array<[RegExp, string]> = [
  [/rm\s+-rf\b/, '递归删除（工作区内）'],
  [/sudo\b/, 'sudo 提权'],
  [/base64\b/, 'base64 编码数据'],
  [/\/(etc|var|usr)\//, '系统目录操作'],
  [/os\.system|subprocess|child_process|execSync/, '程序化执行系统命令'],
  [/\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASS)\}?/i, '引用环境变量凭据'],
  [/\bcurl\b|\bwget\b/, '网络请求'],
  [/\.env\b|id_rsa|\.npmrc/, '读取凭据文件'],
  [/(eval|exec)\s*\(/, '动态执行（eval/exec）'],
  [/chmod\s+777/, '权限放宽（chmod 777）'],
]

/** 扫描单个文件内容 */
function scanFileContent(path: string, rel: string, report: SkillScanReport) {
  let content: string
  try {
    const st = statSync(path)
    if (st.size > 2 * 1024 * 1024) return // 跳过 >2MB 大文件
    content = readFileSync(path, 'utf-8')
  } catch {
    return
  }
  const lines = content.split('\n')
  for (const [re, rule] of HIGH_RULES) {
    const hit = content.match(re)
    if (hit) {
      const lineNo = lines.findIndex((l) => re.test(l)) + 1
      report.issues.push({
        file: rel,
        severity: 'high',
        rule,
        snippet: (hit[0] || '').slice(0, 120),
        ...(lineNo ? { line: lineNo } : {}),
      })
    }
  }
  for (const [re, rule] of MED_RULES) {
    if (re.test(content)) {
      const hit = content.match(re)
      const lineNo = lines.findIndex((l) => re.test(l)) + 1
      report.issues.push({
        file: rel,
        severity: 'medium',
        rule,
        snippet: (hit?.[0] || '').slice(0, 120),
        ...(lineNo ? { line: lineNo } : {}),
      })
    }
  }
}

/** 递归收集待扫描文件（SKILL.md + scripts/references/任何脚本文件） */
function collectScanFiles(dir: string, base: string, out: Array<{ abs: string; rel: string }>) {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.git') || e.name === 'node_modules') continue
    const abs = join(dir, e.name)
    const rel = join(base, e.name)
    if (e.isDirectory()) {
      collectScanFiles(abs, rel, out)
    } else if (e.name.toLowerCase() === 'skill.md' || /\.(sh|py|js|ts|rb|pl|bash|ps1|bat|cmd)$/i.test(e.name)) {
      out.push({ abs, rel })
    }
  }
}

/**
 * 从 GitHub 仓库 URL 下载并安全扫描（不安装）。
 * 返回扫描报告：level=safe 可直接安装；warn 提示风险；danger 拒绝。
 */
export async function scanSkillRepo(githubUrl: string): Promise<SkillScanReport> {
  const report: SkillScanReport = {
    level: 'safe',
    safe: true,
    issues: [],
    skillNames: [],
    files: 0,
    repoUrl: githubUrl,
  }
  let cloneDir = ''
  try {
    const url = githubUrl.trim().replace(/\.git$/, '').replace(/\/+$/, '')
    const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/)
    if (!m) return { ...report, level: 'warn', safe: false, issues: [{ file: '', severity: 'medium', rule: '无效的 GitHub URL（应为 https://github.com/user/repo）' }] }
    const [, owner, repo, , , subPath] = m

    const { tmpdir } = await import('os')
    cloneDir = join(tmpdir(), `supercrzy-scan-${owner}-${repo}`)
    rmSync(cloneDir, { recursive: true, force: true })
    // 必须异步：execSync 会在克隆的整个过程中冻住事件循环（秒~分钟级），
    // 同一后端的并发 SSE 流会被一起冻住。带 timeout 会抛错，由外层 catch 兜住。
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    await promisify(exec)(`git clone --depth 1 https://github.com/${owner}/${repo}.git "${cloneDir}"`, {
      timeout: 60000,
    })

    // 目标目录
    let target = cloneDir
    if (subPath) {
      const t = join(cloneDir, subPath)
      if (!existsSync(t)) return { ...report, level: 'warn', safe: false, issues: [{ file: '', severity: 'medium', rule: '仓库子路径不存在' }] }
      target = t
    }

    // 收集 SKILL.md 名称 + 扫描文件
    const scanFiles: Array<{ abs: string; rel: string }> = []
    collectScanFiles(target, '', scanFiles)
    report.files = scanFiles.length
    for (const f of scanFiles) {
      if (f.abs.toLowerCase().endsWith('skill.md')) {
        try {
          const content = readFileSync(f.abs, 'utf-8')
          const nameM = content.match(/^name:\s*(.+)$/m)
          if (nameM) report.skillNames.push(nameM[1].trim())
        } catch { /* ignore */ }
      }
      scanFileContent(f.abs, f.rel, report)
    }

    // 去重（同文件同规则多次命中只记一条）
    const seen = new Set<string>()
    report.issues = report.issues.filter((i) => {
      const k = `${i.file}|${i.rule}|${i.line || ''}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    const highCount = report.issues.filter((i) => i.severity === 'high').length
    const medCount = report.issues.filter((i) => i.severity === 'medium').length
    report.level = highCount > 0 ? 'danger' : medCount > 0 ? 'warn' : 'safe'
    report.safe = report.level !== 'danger'
    return report
  } catch (err: any) {
    report.issues.push({ file: '', severity: 'medium', rule: `克隆仓库失败: ${err.message}` })
    report.level = 'warn'
    report.safe = false
    return report
  } finally {
    if (cloneDir) {
      try { rmSync(cloneDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

interface SkillFrontmatter {
  name: string
  description: string
  category?: string
  enabled?: boolean
  version?: string
  tools?: string[]
  trigger_keywords?: string[]
}

export interface SkillData {
  name: string
  description: string
  category: string
  icon: string
  enabled: number
  trigger_keywords: string
  prompt_template: string
  tools: string
  globs?: string[]
  environments?: string
  /** 排序权重（SKILL.md frontmatter 可自定义；默认 99 排在内置技能后） */
  sort_order?: number
  is_builtin: number
  source_file?: string
}

/**
 * Simple YAML frontmatter parser
 * Handles the basic key: value format used in SKILL.md
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content }
  }

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (endIdx === -1) {
    return { frontmatter: {}, body: content }
  }

  const fmLines = lines.slice(1, endIdx)
  const body = lines.slice(endIdx + 1).join('\n')
  const frontmatter: Record<string, any> = {}

  let currentKey = ''
  for (const line of fmLines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Array items (- item)
    if (trimmed.startsWith('- ') && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = []
      }
      frontmatter[currentKey].push(trimmed.slice(2).trim())
      continue
    }

    // Key: value or key:
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx > 0) {
      currentKey = trimmed.slice(0, colonIdx).trim()
      const value = trimmed.slice(colonIdx + 1).trim()
      frontmatter[currentKey] = value || ''
    }
  }

  return { frontmatter, body }
}

/**
 * Category → icon mapping (SVG icon names, no emoji)
 */
const categoryIcons: Record<string, string> = {
  coding: 'code',
  research: 'search',
  system: 'settings',
  automation: 'zap',
  analysis: 'activity',
  writing: 'pen',
  general: 'star',
}

/**
 * Load a single SKILL.md file and parse it
 */
export function loadSkillFile(filePath: string): SkillData | null {
  try {
    if (!existsSync(filePath)) return null

    const content = readFileSync(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)

    if (!frontmatter.name || !frontmatter.description) {
      console.warn(`[SkillLoader] Invalid SKILL.md: missing name or description in ${filePath}`)
      return null
    }

    const category = frontmatter.category || 'general'
    if (category === 'document-generation') {
      // Map workbuddy-style categories
      frontmatter.category = 'writing'
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      category: category === 'document-generation' ? 'writing' : category,
      icon: categoryIcons[category] || 'star',
      enabled: frontmatter.enabled !== false ? 1 : 0,
      trigger_keywords: Array.isArray(frontmatter.trigger_keywords)
        ? frontmatter.trigger_keywords.join(', ')
        : (frontmatter.trigger_keywords || '').toString(),
      prompt_template: body.trim(),
      tools: JSON.stringify(Array.isArray(frontmatter.tools) ? frontmatter.tools : []),
      sort_order: frontmatter.sort_order !== undefined ? Number(frontmatter.sort_order) : 99,
      is_builtin: 0,
      source_file: filePath,
    }
  } catch (err: any) {
    console.warn(`[SkillLoader] Failed to load skill file ${filePath}:`, err.message)
    return null
  }
}

/**
 * Scan a directory for SKILL.md files and load all skills
 */
export function scanSkillDirectory(dirPath: string): SkillData[] {
  if (!existsSync(dirPath)) return []

  const skills: SkillData[] = []

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = join(dirPath, entry.name, 'SKILL.md')
      const skill = loadSkillFile(skillMdPath)
      if (skill) {
        skills.push(skill)
      }
    }
  } catch (err: any) {
    console.warn(`[SkillLoader] Error scanning directory ${dirPath}:`, err.message)
  }

  return skills
}

/**
 * Install a skill from file-based directory
 * Creates SQLite record if not exists, updates if source_file matches
 */
/**
 * 从 description 自动提取触发关键词（开源技能通常没有 trigger_keywords）：
 * 文件扩展名（.docx→docx）+ 高频英文术语（≥4 字母），取出现次数 Top12。
 * 无扩展名/术语时回退为技能名。
 */
export function autoGenerateKeywords(skill: SkillData): string {
  if (skill.trigger_keywords && skill.trigger_keywords.trim()) return skill.trigger_keywords
  const desc = skill.description || ''
  const freq: Record<string, number> = {}
  // 文件扩展名（.docx / .pdf / .pptx ...）
  const exts = (desc.match(/\.([a-z0-9]{2,5})\b/gi) || []).map((e) => e.slice(1).toLowerCase())
  // 高频英文术语（大写开头或 ≥4 字母，去掉常见弱词）
  const words = (desc.match(/\b([A-Z][a-z]{2,}|[a-z]{4,})\b/g) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => !['with', 'from', 'that', 'this', 'they', 'when', 'what', 'your', 'have', 'will', 'more', 'them', 'into', 'about', 'using', 'user', 'file', 'files', 'work', 'need', 'also', 'than', 'then', 'other', 'such', 'only', 'which', 'these', 'those'].includes(w))
  for (const w of [...exts, ...words]) freq[w] = (freq[w] || 0) + 1
  const top = Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, 12)
    .map(([w]) => w)
  if (top.length === 0) return skill.name.toLowerCase()
  return top.join(', ')
}

export function installSkill(skill: SkillData): string {
  const db = getDB()
  // 开源技能无 trigger_keywords 时自动生成，确保能按关键词触发
  const keywords = autoGenerateKeywords(skill)

  // Check if skill already exists (by source_file)
  if (skill.source_file) {
    const existing = db.prepare(
      'SELECT id FROM skills WHERE name = ? AND is_builtin = 0'
    ).get(skill.name) as any

    if (existing) {
      // Update existing
      db.prepare(`
        UPDATE skills
        SET description = ?, category = ?, icon = ?, trigger_keywords = ?,
            prompt_template = ?, tools = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        skill.description,
        skill.category,
        skill.icon,
        keywords,
        skill.prompt_template,
        skill.tools,
        skill.enabled,
        skill.sort_order ?? 99,
        existing.id,
      )
      return existing.id
    }
  }

  // Create new
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skills (id, name, description, icon, category, enabled,
      trigger_keywords, globs, environments, prompt_template, tools, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    skill.name,
    skill.description,
    skill.icon,
    skill.category,
    skill.enabled,
    keywords,
    JSON.stringify(skill.globs || []),
    skill.environments || 'all',
    skill.prompt_template,
    skill.tools,
    skill.sort_order ?? 99,  // 文件技能默认排内置后；SKILL.md frontmatter 可自定义置顶
    skill.is_builtin,
  )

  return id
}

/**
 * Sync all file-based skills with the database
 * Call on startup to keep skills in sync with SKILL.md files
 * 扫描两个目录：data/skills（内部） + .agents/skills（Agent Skills 开放标准，与 Claude Code/Cursor 共享）
 */
export function syncFileSkills(workspaceDir: string): { added: number; updated: number } {
  const skillsDir = join(workspaceDir, 'data', 'skills')
  const standardDir = join(workspaceDir, '.agents', 'skills')
  // 去重：两个目录可能包含同名技能（优先标准目录）
  const seen = new Set<string>()
  const fileSkills: SkillData[] = []
  for (const dir of [skillsDir, standardDir]) {
    if (!existsSync(dir)) continue
    for (const s of scanSkillDirectory(dir)) {
      const key = s.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      fileSkills.push(s)
    }
  }

  if (fileSkills.length === 0) {
    return { added: 0, updated: 0 }
  }

  let added = 0
  let updated = 0

  const db = getDB()
  for (const skill of fileSkills) {
    const existing = db.prepare(
      'SELECT id FROM skills WHERE name = ? AND is_builtin = 0'
    ).get(skill.name)

    if (existing) {
      updated++
    } else {
      added++
    }
    installSkill(skill)
  }

  console.log(`[SkillLoader] Synced ${fileSkills.length} file skills (${added} new, ${updated} updated)`)
  return { added, updated }
}

/**
 * Initialize the file skills directory with default structure
 */
export function initSkillsDirectory(workspaceDir: string): string {
  const skillsDir = join(workspaceDir, 'data', 'skills')
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }
  return skillsDir
}

/**
 * 递归扫描目录下的所有 SKILL.md（限制深度，跳过隐藏目录与常见依赖目录）
 */
function scanSkillFiles(dirPath: string, maxDepth: number, depth = 0): string[] {  if (depth > maxDepth || !existsSync(dirPath)) return []
  const results: string[] = []
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'vendor', 'venv', '.venv'])
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue
        const sub = join(dirPath, entry.name)
        const skillMd = join(sub, 'SKILL.md')
        if (existsSync(skillMd)) {
          results.push(skillMd)
        }
        results.push(...scanSkillFiles(sub, maxDepth, depth + 1))
      }
    }
  } catch {}
  return results
}

/**
 * Clone and install skills from a GitHub repository URL.
 * 支持两种形态：
 * 1. 仓库根 URL（如 https://github.com/anthropics/skills）→ 扫描仓库内全部 SKILL.md 安装
 * 2. 子路径 URL（如 https://github.com/anthropics/skills/tree/main/skills/skill-creator）
 *    → 只安装指定路径下的技能
 */
export async function installSkillFromGitHub(
  githubUrl: string,
  workspaceDir: string,
): Promise<{ success: boolean; name?: string; skills?: string[]; error?: string }> {
  let cloneDir = ''
  try {
    // 解析 GitHub URL：owner/repo 及可选的 tree|blob/<branch>/<path>
    const url = githubUrl.trim().replace(/\.git$/, '').replace(/\/+$/, '')
    const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/)
    if (!m) return { success: false, error: '无效的 GitHub URL（应为 https://github.com/user/repo 或 .../tree/分支/路径）' }
    const [, owner, repo, , , subPath] = m
    const repoName = `${owner}-${repo}`

    const skillsDir = join(workspaceDir, 'data', 'skills')
    initSkillsDirectory(workspaceDir)
    // 临时 clone 目录放系统 /tmp（工作区内递归删除会触发批量删除安全拦截）
    const { tmpdir } = await import('os')
    cloneDir = join(tmpdir(), `supercrzy-skill-${repoName}`)
    rmSync(cloneDir, { recursive: true, force: true })

    // Clone 仓库（浅克隆）—— 必须异步：execSync 会在克隆全程冻住事件循环，
    // 拖住同后端上所有并发 SSE 流（实测单条 git 命令同步执行即冻结几十~上千毫秒，克隆是秒~分钟级）。
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    await promisify(exec)(`git clone --depth 1 https://github.com/${owner}/${repo}.git "${cloneDir}"`, {
      timeout: 60000,
    })

    // 确定目标 SKILL.md 集合
    let candidates: string[] = []
    if (subPath) {
      const target = join(cloneDir, subPath)
      if (existsSync(target) && statSync(target).isFile()) {
        // blob 指向 SKILL.md 本身
        candidates = [target]
      } else if (existsSync(target)) {
        // tree 指向技能目录
        const direct = join(target, 'SKILL.md')
        candidates = existsSync(direct) ? [direct] : scanSkillFiles(target, 2)
      }
    } else {
      // 仓库根：扫描所有子目录的 SKILL.md（多技能仓库一次装完）
      candidates = scanSkillFiles(cloneDir, 3)
    }

    if (candidates.length === 0) {
      return { success: false, error: '未找到 SKILL.md（支持标准 Agent Skills 格式的仓库）' }
    }

    // 安装所有找到的技能
    const installed: string[] = []
    for (const skillMdPath of candidates) {
      const skill = loadSkillFile(skillMdPath)
      if (skill) {
        installSkill(skill)
        installed.push(skill.name)
      }
    }

    if (installed.length === 0) {
      return { success: false, error: 'SKILL.md 无效（缺少 name/description frontmatter）' }
    }
    return { success: true, name: installed[0], skills: installed }
  } catch (err: any) {
    return { success: false, error: `安装失败: ${err.message}` }
  } finally {
    if (cloneDir) {
      try { rmSync(cloneDir, { recursive: true, force: true }) } catch {}
    }
  }
}

// ---- SKILL.md 导出（表 → 文件，对齐 Agent Skills 开放标准）----

/** 技能名 → 标准目录名：小写 + 连字符（SKILL.md 规范的 name 约束） */
export function skillToDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill'
}

/**
 * 将数据库中的技能导出为标准 SKILL.md 文件（Agent Skills 开放标准）。
 * 目录：{workspace}/.agents/skills/{dir-name}/SKILL.md
 * frontmatter 用标准字段（name/description/version/tags/globs），
 * body 用 prompt_template；tools/trigger_keywords 作为扩展字段写入（其他平台忽略未知字段）。
 * 返回导出文件路径。
 */
export function exportSkillToFile(skill: Record<string, any>, workspaceDir: string): string {
  const dirName = skillToDirName(skill.name)
  const dir = join(workspaceDir, '.agents', 'skills', dirName)
  mkdirSync(dir, { recursive: true })

  const fmLines: string[] = ['---']
  fmLines.push(`name: ${skill.name}`)
  fmLines.push(`description: ${(skill.description || '').replace(/\n/g, ' ').slice(0, 1024)}`)
  if (skill.version) fmLines.push(`version: ${skill.version}`)
  if (skill.category && skill.category !== 'general') fmLines.push(`category: ${skill.category}`)
  // 扩展字段：触发关键词（tags 形式，符合标准）
  const keywords = (skill.trigger_keywords || '').split(',').map((k: string) => k.trim()).filter(Boolean)
  if (keywords.length > 0) {
    fmLines.push('tags:')
    for (const kw of keywords.slice(0, 12)) fmLines.push(`  - ${kw}`)
  }
  // 扩展字段：文件匹配（标准 agentskills 的 globs）
  let globs: string[] = []
  try { globs = JSON.parse(skill.globs || '[]') } catch { globs = [] }
  if (globs.length > 0) {
    fmLines.push('globs:')
    for (const g of globs) fmLines.push(`  - ${g}`)
  }
  // 扩展字段：工具白名单
  let tools: string[] = []
  try { tools = JSON.parse(skill.tools || '[]') } catch { tools = [] }
  if (tools.length > 0) {
    fmLines.push('tools:')
    for (const t of tools) fmLines.push(`  - ${t}`)
  }
  if (skill.environments && skill.environments !== 'all') {
    fmLines.push(`environments: ${skill.environments}`)
  }
  fmLines.push('---')
  fmLines.push('')
  fmLines.push((skill.prompt_template || '').trim())
  fmLines.push('')

  const filePath = join(dir, 'SKILL.md')
  writeFileSync(filePath, fmLines.join('\n'), 'utf-8')
  return filePath
}

/**
 * 批量导出：所有非内置技能 → SKILL.md 文件（幂等，返回导出数量与路径列表）。
 */
export function exportAllSkillsToFiles(workspaceDir: string): { count: number; paths: string[] } {
  const db = getDB()
  const rows = db.prepare(
    'SELECT id, name, description, category, enabled, trigger_keywords, globs, environments, prompt_template, tools FROM skills WHERE is_builtin = 0 AND enabled = 1'
  ).all() as any[]
  const paths: string[] = []
  for (const row of rows) {
    try { paths.push(exportSkillToFile(row, workspaceDir)) } catch (err: any) {
      console.warn(`[SkillLoader] Export failed for "${row.name}":`, err.message)
    }
  }
  return { count: paths.length, paths }
}
