/**
 * 会话能力清单 manifest（G2，2026-10-23）。
 *
 * 修的是什么：工具能力此前散在五处，没有一处是单一来源 ——
 *   ① 系统提示词里手写的按需名录（纯文案，与 DEFERRED_TOOLS 各写一遍）
 *   ② agent.ts 里硬编码的 baseTools 白名单（曾漏掉 4 个工具）
 *   ③ skill→tools 白名单
 *   ④ MCP 动态注入
 *   ⑤ playbook 经验注入
 * 本文件只负责「清单 + 来源（provenance）+ 稳定哈希」这三件数据事实；
 * 激活本身由 baseTools=注册表派生 + resolveToolSearchHits 数据化激活保证。
 *
 * 稳定哈希的验收断言（backlog G2）：同一输入两次生成 hash 相同；
 * 关掉任一 skill，provenance 里能看出是谁消失（sources 少一条 `skill:*`）。
 */

import { createHash } from 'node:crypto'

/** 单个能力的来源链：builtin / skill:<名> / mcp:<serverId或名>，可多个（同一工具既内置又被技能引用） */
export interface CapabilityEntry {
  name: string
  sources: string[]
}

export interface CapabilityManifest {
  entries: CapabilityEntry[]
  /** 稳定哈希（sha256 前 16 位十六进制）；同一输入恒等 */
  hash: string
}

export function createCapabilityManifest(): CapabilityManifest {
  return { entries: [], hash: hashEntries([]) }
}

/** 排序 + 稳定序列化后哈希 —— 字段顺序、插入顺序都不影响结果 */
function hashEntries(entries: CapabilityEntry[]): string {
  const stable = [...entries]
    .map((e) => ({ name: e.name, sources: [...e.sources].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
}

/**
 * 把一批能力名登记到清单上，来源记为 `source`。
 * 返回新 manifest（不可变风格：调用方持有旧引用也不受影响）。
 */
export function addCapability(manifest: CapabilityManifest, names: readonly string[], source: string): CapabilityManifest {
  const map = new Map<string, string[]>()
  for (const e of manifest.entries) map.set(e.name, [...e.sources])
  for (const n of names) {
    if (!n) continue
    const cur = map.get(n) ?? []
    if (!cur.includes(source)) cur.push(source)
    map.set(n, cur)
  }
  const entries: CapabilityEntry[] = [...map.entries()]
    .map(([name, sources]) => ({ name, sources: sources.sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { entries, hash: hashEntries(entries) }
}

/** 按来源前缀统计（用于 SSE 摘要与验收：关掉 skill 后 skill:* 计数应减少） */
export function countBySourceKind(manifest: CapabilityManifest): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of manifest.entries) {
    for (const s of e.sources) {
      const kind = s.split(':')[0] || s
      out[kind] = (out[kind] || 0) + 1
    }
  }
  return out
}
