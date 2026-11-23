/** Match declared triggers without treating an empty request as a substring of every skill. */
export function matchesSkillKeywords(query: string, declared: string): boolean {
  const q = query.toLowerCase()
  if (!q.trim()) return false
  return declared.split(',').map(keyword => keyword.trim().toLowerCase()).filter(Boolean)
    .some(keyword => q.includes(keyword) || keyword.includes(q))
}
