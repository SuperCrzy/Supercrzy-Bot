/**
 * Playbook 经验匹配 — 纯逻辑模块
 * 供 agent.ts 经验注入使用，独立导出以便单测
 */

/** 任务类型拆词：分词 + 滑动 2-gram，提高匹配召回 */
export function splitWords(t: string): string[] {
  const words = t.split(/[,，、\s]+/).filter((w) => w.length >= 2)
  for (let i = 0; i < t.length - 1; i++) words.push(t.slice(i, i + 2))
  return words
}

/** 从经验库中匹配与用户查询相关的条目（双向 2-gram 匹配，最多 2 条） */
export function matchPlaybooks(
  playbooks: Array<{ task_type: string; lesson: string }>,
  query: string
): Array<{ task_type: string; lesson: string }> {
  const q = (query || '').toLowerCase()
  return playbooks
    .filter((p) => {
      const type = (p.task_type || '').toLowerCase()
      if (!type || !q) return false
      const words = splitWords(type)
      return words.some((w) => q.includes(w))
    })
    .slice(0, 2)
}
