/**
 * 任务交付页的纯逻辑（P1-05 新增 / P1-04 下沉，2026-09-17）
 *
 * 只保留不依赖 i18n 的部分；`deliveryStatusText` 依赖 t() 故留在组件内。
 */
import type { ChatMessage } from '@/types'

/** 是否渲染交付页：有产物 / 有改动 / 有结论，三者任一即渲染（此前只看产物） */
export function hasDelivery(msg: ChatMessage): boolean {
  const d = msg.deliverySummary
  if (!d) return false
  return !!(d.artifacts?.length || d.changedFiles?.length || d.summary)
}

/** 交付页头部状态样式类（completed 绿 / cancelled 灰 / failed 红） */
export function deliveryHeadClass(msg: ChatMessage): string {
  return `ds-head--${msg.deliverySummary?.status || 'completed'}`
}

/** 耗时格式化（秒级；超过 60s 显示 m s；非法值返回空串） */
export function fmtDeliveryDuration(ms: number): string {
  if (!ms || ms < 0) return ''
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec ? `${m}m${sec}s` : `${m}m`
}

/** 成本格式化（美元，保留 4 位小数；0/空值返回空串，避免显示 $0.0000） */
export function fmtDeliveryCost(cost?: number): string {
  if (!cost) return ''
  return `$${cost.toFixed(4)}`
}
