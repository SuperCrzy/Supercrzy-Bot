/**
 * tool_search / browser / computer_use 结果解析（G4，2026-10-23）。
 *
 * 与 `search-result.ts` 同一纪律：解析是**纯函数 + 有测试**；解析失败返回 null，
 * 卡片老实显示原文，绝不假装解析成功。此处只做"机器输出 → 结构化"，展示文案归 i18n。
 */

export interface ToolSearchHit {
  name: string
  description: string
}

export interface ToolSearchPayload {
  /** 'hits' = 关键词命中（激活态）；'list' = 空 query 列全量 */
  kind: 'hits' | 'list'
  query: string
  hits: ToolSearchHit[]
}

/** tool_search 结果解析。命中形如 `- name: desc` 行；列全量形如 `name, name, ...` */
export function parseToolSearchPayload(result?: string, query?: string): ToolSearchPayload | null {
  const text = String(result || '').trim()
  if (!text) return null
  const q = String(query || '').trim()

  if (text.startsWith('未找到')) return { kind: 'hits', query: q, hits: [] }

  // 命中态：`- name: desc` 行
  const hitLines = [...text.matchAll(/^- ([a-z][a-z0-9_]*):\s?(.*)$/gm)]
  if (hitLines.length > 0) {
    return {
      kind: 'hits',
      query: q,
      hits: hitLines.map((m) => ({ name: m[1], description: m[2] || '' })),
    }
  }

  // 列全量态：`按需工具（N 个，可直接调用）：\nname, name, ...`
  const listMatch = text.match(/^[^\n：:]*：\s*\n(.+)$/s)
  if (listMatch) {
    const names = listMatch[1].split(/[,，]\s*/).map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9_]*$/.test(s))
    if (names.length > 0) return { kind: 'list', query: q, hits: names.map((n) => ({ name: n, description: '' })) }
  }
  return null
}

/** 动作类调用（browser / computer_use）的参数摘要 */
export interface ActionCallSummary {
  action: string
  /** 主要目标：url / 要点的文本 / 要按的键 / 坐标 / 要打开的应用名 */
  target: string
  /** 次要参数（into 等） */
  extra: string
}

function fmtXY(x: unknown, y: unknown): string {
  if (x == null && y == null) return ''
  return `(${x ?? '?'}, ${y ?? '?'})`
}

/** browser 参数摘要：action + 主目标 */
export function parseBrowserCall(argsJson?: string): ActionCallSummary | null {
  try {
    const o = JSON.parse(String(argsJson || '{}'))
    if (!o || typeof o !== 'object') return null
    const action = String(o.action || '')
    if (!action) return null
    let target = ''
    let extra = ''
    if (action === 'navigate') target = String(o.url || '')
    else if (action === 'click') target = o.text ? String(o.text) : fmtXY(o.x, o.y)
    else if (action === 'type') { target = String(o.text || ''); extra = o.into ? String(o.into) : '' }
    else if (action === 'press') target = String(o.key || '')
    else if (action === 'scroll') target = `${Number(o.deltaY) || 300}px`
    // look/back/url/snapshot 无目标
    return { action, target, extra }
  } catch {
    return null
  }
}

/** computer_use 参数摘要：action + 主目标（参数在 args 子对象里） */
export function parseComputerUseCall(argsJson?: string): ActionCallSummary | null {
  try {
    const o = JSON.parse(String(argsJson || '{}'))
    if (!o || typeof o !== 'object') return null
    const action = String(o.action || '')
    if (!action) return null
    const p = (o.args && typeof o.args === 'object') ? o.args : {}
    let target = ''
    if (action === 'click' || action === 'move') target = fmtXY(p.x, p.y)
    else if (action === 'type') target = String(p.text || '')
    else if (action === 'key') target = String(p.combo || '')
    else if (action === 'scroll') target = `${Number(p.clicks) || 0} clicks`
    else if (action === 'open') target = String(p.name || '')
    return { action, target, extra: '' }
  } catch {
    return null
  }
}

/** 动作结果首行（作卡片的结论行；错误行原样保留给 body） */
export function firstLine(text?: string): string {
  return String(text || '').split('\n')[0].trim()
}
