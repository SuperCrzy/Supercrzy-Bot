import { defineConfig } from 'vitest/config'

/**
 * 只在「从仓库根目录 ad-hoc 跑 vitest」时生效（`pnpm -r test` 走各包自己的 config）。
 *
 * 为什么必须有它：根目录没有 config 时，vitest 用默认 include 全盘 glob 所有 *.test.ts，
 * 会钻进打包产物里的**陈旧测试副本**——例如
 *   packages/desktop/dist/mac-arm64/SUPERCRZY BOT.app/Contents/Resources/backend/…/*.test.ts
 * 那里是上一次打包时的旧代码 + 旧断言，跑出来的是"旧代码判旧断言"的结果：
 * 既可能假绿（旧代码过了旧断言），也会把测试数量翻倍，掩盖真实回归。
 * 2026-10-22 就因此把 classify-sensitive-tool 的一个真失败混在一堆 dist 副本里看漏。
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.mts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.app/**',
      '**/.trash-*/**',
      '**/.deploy-*/**',
    ],
  },
})
