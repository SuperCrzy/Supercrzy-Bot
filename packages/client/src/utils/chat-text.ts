/**
 * 聊天消息的文本格式化（从 `ChatView.vue` 抽出，I10 低风险批）。
 *
 * 拆成两部分：
 *   · 纯函数（`resolveRealTime` / `actorMeta` / `ACTOR_META`）—— 无依赖，直接引用
 *   · 依赖注入的 `createChatText(deps)` —— 需要「当前语言 / 可见消息窗口 / i18n」三样东西，
 *     由调用方注入 getter（惰性求值，避免和组件里 computed 的声明顺序绑死）
 *
 * 为什么不直接读 store / 全局 locale：这三样在组件里分别是 `locale`（i18n）与
 * `visibleMessages`（computed），把组件级的响应式源塞进模块级变量是最常见的"抽出来就坏"来源。
 */

export interface ActorMeta { label: string; icon: string; color: string; bg: string }

/**
 * 从 id 中提取内嵌时间戳（主流实现 resolveRealTime 同款：部分 id 内嵌 13 位毫秒时间戳，取小值防污染）。
 *
 * 两个刻意的容错：
 *   · SQLite 存的是 UTC 但格式无时区标记（`2026-05-07 06:44:42`）→ 必须补 `Z`，否则整体差 8 小时
 *   · id 里的时间戳只有在"比 dateStr 更小"时才采信 —— id 时间戳来自创建、dateStr 来自写入，
 *     取小值可以避免用未来时间污染排序
 */
export function resolveRealTime(dateStr: string, id?: string): Date | null {
  let t = 0
  if (dateStr) {
    const normalized = dateStr.includes(' ') && !dateStr.includes('T') && !dateStr.endsWith('Z')
      ? dateStr.replace(' ', 'T') + 'Z'
      : dateStr
    const d = new Date(normalized)
    if (!isNaN(d.getTime())) t = d.getTime()
  }
  if (id && /(?:^|_|-)(\d{13})(?:$|_|-)/.test(id)) {
    const m = id.match(/(\d{13})/)
    if (m) {
      const idT = Number(m[1])
      if (!isNaN(idT) && idT > 0 && (t === 0 || idT < t)) t = idT
    }
  }
  return t ? new Date(t) : null
}

/**
 * 2026-08-29 超级协作平台：发言人元数据（名字/图标/颜色）。
 * 单 AI（无 actor）= SUPERCRZY 原样；多 AI 场景按 actor 区分身份，渲染不同头像与名字。
 */
export const ACTOR_META: Record<string, ActorMeta> = {
  '执行AI':   { label: '执行 AI',   icon: '执', color: '#374151', bg: '#e5e7eb' },
  '质检AI':   { label: '质检 AI',   icon: '检', color: '#b45309', bg: '#fffbeb' },
  '议院':     { label: '议院',     icon: '院', color: '#6d28d9', bg: '#f5f3ff' },
  '你':       { label: '你',       icon: '你', color: '#1d4ed8', bg: '#eff6ff' },
}

/** 未知 actor 也要有稳定的兜底外观（取首字 + 中性灰），否则头像会渲染成空白 */
export function actorMeta(actor?: string): ActorMeta | null {
  return actor
    ? (ACTOR_META[actor] || { label: actor, icon: (actor || '').slice(0, 1), color: '#374151', bg: '#e5e7eb' })
    : null
}

export interface ChatTextDeps {
  /** 当前是否中文界面（决定 M月D日 / 时间格式 / ¥ vs $） */
  isZh: () => boolean
  /** 当前渲染窗口内的消息（按天分隔线只判定"看得见的那批"，与模板 v-for 的索引对齐） */
  visibleMessages: () => any[]
  /** i18n 取词 */
  t: (key: string) => string
}

export function createChatText(deps: ChatTextDeps) {
  function messageRoleLabel(msg: { role: string; actor?: string }): string {
    if (msg.role === 'user') return deps.t('chat.roleUser')
    const m = actorMeta(msg.actor)
    return m ? m.label : deps.t('chat.roleAssistant')
  }

  /** 消息时间显示（对齐主流实现 message-time）：今天 HH:MM / 昨天 HH:MM / 今年 M月D日 HH:MM / 往年带年 */
  function formatTime(dateStr: string, id?: string): string {
    const d = resolveRealTime(dateStr, id)
    if (!d) return ''
    const zh = deps.isZh()
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const diffDays = Math.round((today - day) / 86400000)
    const hm = d.toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
    if (diffDays === 0) return hm
    if (diffDays === 1) return zh ? `昨天 ${hm}` : `Yesterday ${hm}`
    if (d.getFullYear() === now.getFullYear()) {
      return zh
        ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + hm
    }
    return zh
      ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
      : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  /** 货币格式化：中文界面 ¥，英文界面 $（按当前语言） */
  function formatCurrency(amount: number): string {
    return (deps.isZh() ? '¥' : '$') + amount.toFixed(2)
  }

  // ===== 历史消息体系：按天分隔线（2026-08-27 加，会话长消息按日期分组） =====
  /** 取消息的日期 key（YYYY-MM-DD，用于判断是否跨天） */
  function msgDayKey(m: any): string {
    const d = resolveRealTime(m?.timestamp || m?.createdAt, m?.id)
    if (!d) return 'the-same-day'
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }

  /** 在消息列表该位置是否应显示日期分隔线（与上一条跨天则显示） */
  function showDayDivider(idx: number): boolean {
    if (idx <= 0) return false
    const msgs = deps.visibleMessages()
    if (idx >= msgs.length) return false
    return msgDayKey(msgs[idx]) !== msgDayKey(msgs[idx - 1])
  }

  /** 日期分隔线文案：今天 / 昨天 / 2026年8月27日 */
  function dayLabel(idx: number): string {
    const msgs = deps.visibleMessages()
    const m = msgs[idx]
    const d = resolveRealTime(m?.timestamp || m?.createdAt, m?.id)
    if (!d) return ''
    const zh = deps.isZh()
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const diff = Math.round((today - day) / 86400000)
    if (diff === 0) return zh ? '今天' : 'Today'
    if (diff === 1) return zh ? '昨天' : 'Yesterday'
    if (d.getFullYear() === now.getFullYear()) {
      return zh ? `${d.getMonth() + 1}月${d.getDate()}日` : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    return zh
      ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
      : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  return { messageRoleLabel, formatTime, formatCurrency, msgDayKey, showDayDivider, dayLabel }
}
