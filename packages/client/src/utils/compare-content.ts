export function isCompareContent(content: unknown): boolean {
  if (typeof content !== 'string' || !content.startsWith('{')) return false
  try { return Array.isArray(JSON.parse(content)?.results) } catch { return false }
}

export function parseCompareContent(content: unknown): any {
  try { return JSON.parse(String(content)) } catch { return { results: [] } }
}
