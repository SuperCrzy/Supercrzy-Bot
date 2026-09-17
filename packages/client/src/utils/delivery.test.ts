/**
 * 任务交付页纯逻辑单测（P1-05 / P1-04 下沉）
 */
import { describe, it, expect } from 'vitest'
import { hasDelivery, deliveryHeadClass, fmtDeliveryDuration, fmtDeliveryCost } from './delivery'
import type { ChatMessage } from '@/types'

const msg = (ds: unknown): ChatMessage => ({ deliverySummary: ds } as unknown as ChatMessage)

describe('hasDelivery', () => {
  it('无 deliverySummary → false', () => {
    expect(hasDelivery(msg(undefined))).toBe(false)
  })

  it('有产物 / 有改动 / 有结论，任一即为 true', () => {
    expect(hasDelivery(msg({ artifacts: [{ name: 'a', path: '/a', mime: 'text/plain' }], artifactCount: 1, toolCallCount: 0, turns: 1 }))).toBe(true)
    expect(hasDelivery(msg({ artifacts: [], artifactCount: 0, toolCallCount: 3, turns: 2, changedFiles: [{ name: 'x.ts', path: '/x.ts' }] }))).toBe(true)
    expect(hasDelivery(msg({ artifacts: [], artifactCount: 0, toolCallCount: 3, turns: 2, summary: '任务完成' }))).toBe(true)
  })

  it('三者皆空 → false（不渲染空交付页）', () => {
    expect(hasDelivery(msg({ artifacts: [], artifactCount: 0, toolCallCount: 0, turns: 0 }))).toBe(false)
  })
})

describe('deliveryHeadClass', () => {
  it('按状态给出样式类，缺省 completed', () => {
    expect(deliveryHeadClass(msg({ status: 'failed' }))).toBe('ds-head--failed')
    expect(deliveryHeadClass(msg({ status: 'cancelled' }))).toBe('ds-head--cancelled')
    expect(deliveryHeadClass(msg({ status: 'completed' }))).toBe('ds-head--completed')
    expect(deliveryHeadClass(msg({}))).toBe('ds-head--completed')
  })
})

describe('fmtDeliveryDuration', () => {
  it('秒级', () => {
    expect(fmtDeliveryDuration(1000)).toBe('1s')
    expect(fmtDeliveryDuration(45000)).toBe('45s')
  })

  it('超过 60s 显示 m / ms', () => {
    expect(fmtDeliveryDuration(60000)).toBe('1m')
    expect(fmtDeliveryDuration(90000)).toBe('1m30s')
  })

  it('0 / 负数 / 空值返回空串，不显示 "0s"', () => {
    expect(fmtDeliveryDuration(0)).toBe('')
    expect(fmtDeliveryDuration(-1)).toBe('')
    expect(fmtDeliveryDuration(undefined as unknown as number)).toBe('')
  })
})

describe('fmtDeliveryCost', () => {
  it('保留 4 位小数', () => {
    expect(fmtDeliveryCost(0.0123)).toBe('$0.0123')
    expect(fmtDeliveryCost(1)).toBe('$1.0000')
  })

  it('0 / 未定义返回空串，避免显示 $0.0000', () => {
    expect(fmtDeliveryCost(0)).toBe('')
    expect(fmtDeliveryCost(undefined)).toBe('')
  })
})
