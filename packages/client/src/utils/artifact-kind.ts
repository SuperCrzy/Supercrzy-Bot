/**
 * 交付页 / 产物卡片判定（P1-04 ChatView 拆分第一步，2026-09-18）
 *
 * 这些判定原本内联在 ChatView.vue，与组件状态无关（只吃 msg 字段），
 * 抽出来后可直测，也让 ChatView 只留"事件与渲染"。
 */

/** 图片类产物（走 <img> 预览） */
export function isArtifactImage(a: { path?: string; name?: string }): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(a.path || a.name || '')
}

/** 表格类产物（走 xlsx 预览） */
export function isArtifactSheet(a: { path?: string; name?: string }): boolean {
  return /\.(xlsx?|csv|tsv)$/i.test(a.path || a.name || '')
}

/** 文档类产物（走 md/pdf/html 预览） */
export function isArtifactDoc(a: { path?: string; name?: string }): boolean {
  return /\.(docx?|pdf|md|txt|html?)$/i.test(a.path || a.name || '')
}

/** 交付页默认折叠阈值：产物多于 3 个时只显示前 3 个 + "展开全部" */
export const DELIVERY_SUMMARY_MAX = 3

/**
 * 当前应显示的产物列表（未展开则截断到 DELIVERY_SUMMARY_MAX）。
 * 入参刻意用 any：`_dsExpanded` 是挂在 ChatMessage 上的 UI 瞬态字段，
 * 不在 ChatMessage 类型里，写成结构化类型会与调用方不兼容（TS2559）。
 */
export function deliverySummaryArtifacts(msg: any, max = DELIVERY_SUMMARY_MAX): any[] {
  const arts = msg?.deliverySummary?.artifacts || []
  return msg?._dsExpanded ? arts : arts.slice(0, max)
}

export function deliverySummaryExpanded(msg: any): boolean {
  return !!msg?._dsExpanded
}

/** 切换交付页展开态（就地改 msg 上的 UI 瞬态字段） */
export function toggleDeliverySummary(msg: any): void {
  if (!msg) return
  msg._dsExpanded = !msg._dsExpanded
}

/**
 * 交付状态 i18n key。
 * 非三种已知状态一律落 failed（后端新增状态时前端不会显示空白）。
 */
export function deliveryStatusKey(status?: string): string {
  const st = status || 'completed'
  return st === 'completed' ? 'chat.deliveryDone' : st === 'cancelled' ? 'chat.deliveryCancelled' : 'chat.deliveryFailed'
}

/**
 * 产物时间格式化：SQLite 存的是 UTC 的 "YYYY-MM-DD HH:mm:ss"（无时区标记），
 * 直接 new Date() 会被当本地时间，故先补 T/Z 归一化再转本地 HH:mm。
 * @param locale 界面语言（zh-CN 走 24 小时制；其余走 en-US 12 小时制）
 */
export function formatArtifactTime(s: string, locale = 'zh-CN'): string {
  if (!s) return ''
  const normalized = s.includes(' ') && !s.includes('T') && !s.endsWith('Z') ? s.replace(' ', 'T') + 'Z' : s
  const d = new Date(normalized)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
}
