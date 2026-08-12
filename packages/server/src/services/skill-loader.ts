/**
 * Skill Loader — 技能文件化系统
 *
 * 技能存储从纯 SQLite → SKILL.md 文件 + SQLite 索引
 * 技能目录：{workspace}/data/skills/{skill-name}/SKILL.md
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDB } from './database'

interface SkillFrontmatter {
  name: string
  description: string
  category?: string
  enabled?: boolean
  version?: string
  tools?: string[]
  trigger_keywords?: string[]
}

interface SkillData {
  name: string
  description: string
  category: string
  icon: string
  enabled: number
  trigger_keywords: string
  prompt_template: string
  tools: string
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
export function installSkill(skill: SkillData): string {
  const db = getDB()

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
            prompt_template = ?, tools = ?, enabled = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        skill.description,
        skill.category,
        skill.icon,
        skill.trigger_keywords,
        skill.prompt_template,
        skill.tools,
        skill.enabled,
        existing.id,
      )
      return existing.id
    }
  }

  // Create new
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skills (id, name, description, icon, category, enabled,
      trigger_keywords, prompt_template, tools, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    skill.name,
    skill.description,
    skill.icon,
    skill.category,
    skill.enabled,
    skill.trigger_keywords,
    skill.prompt_template,
    skill.tools,
    99,  // sort after builtin skills
    skill.is_builtin,
  )

  return id
}

/**
 * Sync all file-based skills with the database
 * Call on startup to keep skills in sync with SKILL.md files
 */
export function syncFileSkills(workspaceDir: string): { added: number; updated: number } {
  const skillsDir = join(workspaceDir, 'data', 'skills')
  const fileSkills = scanSkillDirectory(skillsDir)

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
 * Clone and install a skill from a GitHub repository URL
 */
export async function installSkillFromGitHub(
  githubUrl: string,
  workspaceDir: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  try {
    // Parse GitHub URL to get repo name
    const urlParts = githubUrl.replace(/\.git$/, '').split('/')
    const repoName = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2]
      ? `${urlParts[urlParts.length - 2]}-${urlParts[urlParts.length - 1]}`
      : 'unknown-skill'

    const skillsDir = join(workspaceDir, 'data', 'skills')
    initSkillsDirectory(workspaceDir)

    const skillDir = join(skillsDir, repoName)

    if (existsSync(skillDir)) {
      // Already cloned, just re-sync
      const skillMdPath = join(skillDir, 'SKILL.md')
      const skill = loadSkillFile(skillMdPath)
      if (skill) {
        installSkill(skill)
        return { success: true, name: skill.name }
      }
      return { success: false, error: 'No valid SKILL.md found in cloned repo' }
    }

    // Clone the repo
    const { execSync } = await import('child_process')
    execSync(`git clone ${githubUrl} "${skillDir}"`, {
      timeout: 30000,
      stdio: 'pipe',
    })

    // Try to find SKILL.md
    let skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      // Try one level deeper
      const entries = readdirSync(skillDir)
      for (const entry of entries) {
        const nested = join(skillDir, entry, 'SKILL.md')
        if (existsSync(nested)) {
          skillMdPath = nested
          break
        }
      }
    }

    const skill = loadSkillFile(skillMdPath)
    if (!skill) {
      return { success: false, error: 'No valid SKILL.md found in repository' }
    }

    installSkill(skill)
    return { success: true, name: skill.name }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}
