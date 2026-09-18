/**
 * memory_consolidate — 记忆整理（#147，2026-09-18）
 *
 * 由来：`app.ts` 的工具中文名映射里**早就有** `memory_consolidate: '合并记忆'` 这一条，
 * 但注册表里从来没有这个工具 —— 一个只存在于展示层的"空承诺"。
 * 本文件把它变成真的。
 *
 * 与 memory_store 的关系：store 是**写入侧**精确去重（同 key 覆盖），
 * consolidate 是**整理侧**近似收敛（同主题不同措辞合并 + 低价值行按分类上限淘汰）。
 * 前者保证重复任务不增行，后者负责把历史膨胀和历史脏分类收干净。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { consolidateMemories, CATEGORY_CAP } from '../services/memory-consolidate'

const tool: ToolDef = {
  name: 'memory_consolidate',
  description: '整理长期记忆：合并同主题的近似重复记忆，并按分类上限淘汰低价值旧记忆。用户要求"整理记忆/清理记忆/合并记忆"时使用。',
  category: 'memory',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      dryRun: {
        type: 'boolean',
        description: 'true = 只试算并汇报会合并/淘汰哪些，不落库（推荐先试算再执行）',
      },
      evict: {
        type: 'boolean',
        description: '是否同时淘汰低价值记忆（默认 true；false = 只做合并）',
      },
    },
  },
  async execute(args) {
    const db = getDB()
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') {
      return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。如需使用请先开启。'
    }

    const dryRun = args?.dryRun === true
    const noEvict = args?.evict === false
    const report = consolidateMemories(db, { dryRun, noEvict })

    const lines: string[] = []
    lines.push(`${dryRun ? '【试算】' : '【已执行】'}记忆整理：${report.summary}`)

    if (report.mergedGroups.length > 0) {
      lines.push('')
      lines.push('合并明细（保留 ← 被并入）：')
      for (const g of report.mergedGroups.slice(0, 12)) {
        lines.push(`- [${g.category}] ${g.winnerKey}`)
        for (const m of g.merged) lines.push(`    ← (相似度 ${m.similarity.toFixed(2)}) ${m.key}`)
      }
      if (report.mergedGroups.length > 12) lines.push(`… 另有 ${report.mergedGroups.length - 12} 组`)
    }

    if (report.evicted.length > 0) {
      lines.push('')
      lines.push(`淘汰明细（按分类上限，仅淘汰 importance ≤ 4 的低价值行）：`)
      for (const e of report.evicted.slice(0, 12)) {
        lines.push(`- [${e.category}] importance=${e.importance} 使用${e.usage_count}次 ${e.key}`)
      }
      if (report.evicted.length > 12) lines.push(`… 另有 ${report.evicted.length - 12} 条`)
    }

    if (dryRun && report.removed > 0) {
      lines.push('')
      lines.push('如需真正执行，请再调用一次并传 dryRun=false。')
    }
    if (report.removed === 0 && report.mergedGroups.length === 0) {
      lines.push('')
      lines.push('记忆已经足够干净，没有需要整理的内容。')
      const caps = Object.entries(CATEGORY_CAP).map(([c, n]) => `${c}≤${n}`).join('、')
      lines.push(`（当前分类上限：${caps}）`)
    }
    return lines.join('\n')
  },
}

export default tool
