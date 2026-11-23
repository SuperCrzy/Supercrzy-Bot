/**
 * 任务交付页的纯逻辑（P1-05 新增 / P1-04 下沉，2026-09-17）
 *
 * 只保留不依赖 i18n 的部分；`deliveryStatusText` 依赖 t() 故留在组件内。
 */
import type { ChatMessage } from '@/types'

/** Preserve the server's task outcome while supplying safe defaults for older events. */
export function normalizeDeliverySummary(data: Partial<NonNullable<ChatMessage['deliverySummary']>>): NonNullable<ChatMessage['deliverySummary']> {
  return {
    ...data,
    artifactCount: data.artifactCount ?? 0,
    artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
    changedFiles: Array.isArray(data.changedFiles) ? data.changedFiles : [],
    toolCallCount: data.toolCallCount ?? 0,
    turns: data.turns ?? 0,
  }
}

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

/** 估算费用使用服务端人民币口径；保留 4 位小数，避免小额被抹成零。 */
export function fmtDeliveryCost(cost?: number): string {
  if (!cost || !Number.isFinite(cost) || cost < 0) return ''
  return `≈ ¥${cost.toFixed(4)}`
}
