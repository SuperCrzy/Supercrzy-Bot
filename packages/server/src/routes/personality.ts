/**
 * Personality files over HTTP, so the UI can show and edit SOUL/USER/IDENTITY.
 *
 * Read-write on a fixed set of three filenames — the path is never taken from the
 * request, only the kind, so there is no traversal surface here at all.
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import {
  PERSONALITY_FILES, readPersonality, writePersonality, personalityPath, seedPersonalityIfMissing,
  type PersonalityKind,
} from '../services/personality'

export const personalityRouter = new Router({ prefix: '/api/personality' })

const KINDS = Object.keys(PERSONALITY_FILES) as PersonalityKind[]

function parseKind(raw: unknown): PersonalityKind | null {
  const k = String(raw || '').toLowerCase()
  return (KINDS as string[]).includes(k) ? (k as PersonalityKind) : null
}

personalityRouter.get('/', async (ctx: Context) => {
  ctx.body = KINDS.map((kind) => ({
    kind,
    file: PERSONALITY_FILES[kind].file,
    title: PERSONALITY_FILES[kind].title,
    hint: PERSONALITY_FILES[kind].hint,
    path: personalityPath(kind),
    content: readPersonality(kind),
  }))
})

personalityRouter.put('/:kind', async (ctx: Context) => {
  const kind = parseKind(ctx.params.kind)
  if (!kind) { ctx.status = 400; ctx.body = { error: 'unknown kind' }; return }
  const content = String((ctx.request.body as any)?.content ?? '')
  // Cap at the same limit the loader enforces, so the file on disk matches what
  // the prompt will actually carry; otherwise the user writes text the model never sees.
  if (content.length > 20000) {
    ctx.status = 413
    ctx.body = { error: 'content too long (max 20000 characters)' }
    return
  }
  try {
    writePersonality(kind, content)
    ctx.body = { ok: true, kind, path: personalityPath(kind) }
  } catch (e: any) {
    ctx.status = 500
    ctx.body = { error: `write failed: ${e?.message || e}` }
  }
})

/** Create any missing starter file. Idempotent, never overwrites existing files. */
personalityRouter.post('/seed', async (ctx: Context) => {
  try {
    seedPersonalityIfMissing()
    ctx.body = { ok: true }
  } catch (e: any) {
    ctx.status = 500
    ctx.body = { error: `seed failed: ${e?.message || e}` }
  }
})
