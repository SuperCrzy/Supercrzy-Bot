import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type PreviewPath = { ok: true; path: string } | { ok: false; reason: 'forbidden' | 'not_found' }

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isSensitive(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /(^|\/)\.[^/]+|\.(env|key|pem|db|db-wal|db-shm|log|tsbuildinfo)$/i.test(normalized)
}

/** Resolve an existing preview target without following a link outside the workspace. */
export async function resolvePreviewPath(root: string, input: string): Promise<PreviewPath> {
  if (!input || input.includes('\0')) return { ok: false, reason: 'forbidden' }
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, input)
  if (!isInside(absoluteRoot, candidate) || isSensitive(candidate)) return { ok: false, reason: 'forbidden' }
  try {
    const [actualRoot, actualPath] = await Promise.all([realpath(absoluteRoot), realpath(candidate)])
    if (!isInside(actualRoot, actualPath) || isSensitive(actualPath)) return { ok: false, reason: 'forbidden' }
    return { ok: true, path: actualPath }
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}
