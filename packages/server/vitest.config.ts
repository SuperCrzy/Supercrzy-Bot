import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
    // terminal-manager 会真实 spawn bash，多测试连跑在 threads pool 下 worker 会被残留子进程信号终止(143) → 单文件串行执行
  },
})
