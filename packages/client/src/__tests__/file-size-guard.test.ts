/**
 * 巨石文件体量闸门（P1-04 配套，2026-09-17）
 *
 * 报告 P1-04 指出 ChatView / DetailPanel 体量过大属**维护性风险**。风险要可度量才不会
 * 悄悄恶化，所以这里设一个"棘轮"：超过上限即失败，并提示应该抽离而不是继续长。
 *
 * 上限取值 = 2026-09-17 实测值 + 少量余量（容忍正常小改动）。
 * 目标方向是**逐步下调**，不是上调；需要上调时请先在 PR 里说明为什么。
 *
 * 用 Vite 的 `?raw` 读源码（client tsconfig 的 types 只有 vite/client，没有 node 类型，
 * 直接 import 'node:fs' 会 TS2307）。
 */
import { describe, it, expect } from 'vitest'
import chatViewSrc from '../views/ChatView.vue?raw'
import detailPanelSrc from '../components/layout/DetailPanel.vue?raw'

/** 上限（实测 2026-09-17：ChatView 6455 / DetailPanel 1103） */
const LIMITS: Array<{ name: string; src: string; max: number; hint: string }> = [
  {
    name: 'views/ChatView.vue',
    src: chatViewSrc,
    max: 6550,
    hint: 'ChatView 已超体量上限。请把纯逻辑下沉到 utils/ 或抽成 components/chat/ 子组件（参考已下沉的 utils/stage.ts、utils/trigger.ts、utils/message-text.ts、utils/delivery.ts），而不是继续加行。',
  },
  {
    name: 'components/layout/DetailPanel.vue',
    src: detailPanelSrc,
    max: 1180,
    hint: 'DetailPanel 已超体量上限。请把各 tab 的内容抽成独立子组件后再加功能。',
  },
]

describe('巨石文件体量闸门', () => {
  for (const { name, src, max, hint } of LIMITS) {
    it(`${name} 不超过 ${max} 行`, () => {
      const n = src.split('\n').length
      expect(n, `${name} 当前 ${n} 行（上限 ${max}）。${hint}`).toBeLessThanOrEqual(max)
    })
  }
})
