/**
 * Personality files — SOUL.md / USER.md / IDENTITY.md.
 *
 * Without these, every conversation starts with a stranger: the user re-explains
 * that they run the project, that they want conclusions rather than narration,
 * that "国内" is banned. Those facts are stable across sessions and belong in a
 * file the user can open and edit, not in a prompt they cannot see.
 *
 * Deliberately plain markdown in ~/.supercrzy/ rather than database rows: the
 * point is that the user (or an agent acting for them) can read and revise them
 * with any editor. Missing files are normal, not an error — a fresh install has
 * none, and the prompt simply omits the section.
 *
 * Length is capped: these are injected on every turn, and a 50KB soul file would
 * cost more than it is worth. Trimmed in the middle with a marker so the model
 * knows content was dropped rather than believing it read the whole thing.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), '.supercrzy')

/** Per-file cap. The three together stay under ~6k characters (~2k tokens). */
const MAX_CHARS_PER_FILE = 2000

export type PersonalityKind = 'soul' | 'user' | 'identity'

export const PERSONALITY_FILES: Record<PersonalityKind, { file: string; title: string; hint: string }> = {
  soul: {
    file: 'SOUL.md',
    title: 'Style (SOUL.md)',
    hint: 'How the assistant should talk: tone, length, what to avoid.',
  },
  user: {
    file: 'USER.md',
    title: 'About the user (USER.md)',
    hint: 'Stable facts about the person: role, language, conventions, preferences.',
  },
  identity: {
    file: 'IDENTITY.md',
    title: 'Identity (IDENTITY.md)',
    hint: 'What the assistant is and what it is not.',
  },
}

export function personalityPath(kind: PersonalityKind): string {
  return join(ROOT, PERSONALITY_FILES[kind].file)
}

export function readPersonality(kind: PersonalityKind): string {
  const p = personalityPath(kind)
  try {
    if (!existsSync(p)) return ''
    const raw = readFileSync(p, 'utf8').trim()
    if (raw.length <= MAX_CHARS_PER_FILE) return raw
    // Keep both ends: the opening states the intent, the tail often holds rules
    // added later. Dropping the middle is better than truncating the file.
    const half = Math.floor((MAX_CHARS_PER_FILE - 120) / 2)
    return raw.slice(0, half) + '\n\n…(middle omitted, file is too long)…\n\n' + raw.slice(-half)
  } catch {
    return ''
  }
}

/** Write a file, creating ~/.supercrzy if needed. Used by seeding and by the UI. */
export function writePersonality(kind: PersonalityKind, content: string): void {
  try { mkdirSync(ROOT, { recursive: true }) } catch { /* already there */ }
  writeFileSync(personalityPath(kind), content, 'utf8')
}

/**
 * The prompt section. Empty when no file exists, so a fresh install carries no
 * empty scaffolding. Each file gets its own heading so the model can tell style
 * apart from user facts.
 */
export function buildPersonalitySection(): string {
  const parts: string[] = []
  for (const kind of ['identity', 'user', 'soul'] as PersonalityKind[]) {
    const body = readPersonality(kind)
    if (!body) continue
    const { title } = PERSONALITY_FILES[kind]
    parts.push(`### ${title}\n${body}`)
  }
  if (parts.length === 0) return ''
  return '\n\n## 人格与用户背景（来自本地文件，用户可直接编辑）\n' +
    '以下内容由用户维护，优先级高于默认风格；与用户当前消息冲突时以当前消息为准。\n\n' +
    parts.join('\n\n')
}

/**
 * Create starter files if none exist. Called once at boot.
 *
 * Only writes when the file is absent — never overwrites, because the user may
 * have edited it and a boot-time rewrite would silently discard their changes.
 */
export function seedPersonalityIfMissing(): void {
  const soul = personalityPath('soul')
  if (!existsSync(soul)) {
    writePersonality('soul', [
      '# Style',
      '',
      '- Lead with the conclusion, then the evidence. No preamble.',
      '- Tables and numbers over prose when comparing things.',
      '- State failures plainly. No apology paragraphs.',
      '- Say what was verified and what was assumed, separately.',
      '',
    ].join('\n'))
  }
  const user = personalityPath('user')
  if (!existsSync(user)) {
    writePersonality('user', [
      '# User',
      '',
      'Fill this in with facts that stay true across conversations,',
      'so you do not have to repeat them:',
      '',
      '- Role and what you are responsible for',
      '- Language you write in, and any wording you dislike',
      '- Conventions of your project (stack, commands, repo layout)',
      '',
    ].join('\n'))
  }
  const identity = personalityPath('identity')
  if (!existsSync(identity)) {
    writePersonality('identity', [
      '# Identity',
      '',
      'You are SUPERCRZY, an agent that runs on this machine.',
      'You execute tasks and produce real files rather than describing them.',
      'You do not claim capabilities you have not verified.',
      '',
    ].join('\n'))
  }
}
