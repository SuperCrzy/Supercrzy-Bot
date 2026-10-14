/**
 * 诊断用后端启动器 (2026-09-23)
 *
 * 为什么需要它 —— 两条**互相独立**的限制叠在一起：
 *
 * 1. **dev 形态下 App 起不了自己的后端**。`main.cjs` 用 `process.execPath`（= Electron 二进制）
 *    跑 tsx，而仓库里 `better-sqlite3` 是按 Node ABI 编译的（127），Electron 33 是 130
 *    → `new Database()` 必抛 `ERR_DLOPEN_FAILED` → 后端崩、自动重启、无限循环、白屏。
 *    （装机包没这问题：electron-builder 会在打包时按 Electron ABI 重建，实测 bundled = abi 130。）
 *    所以真实 dev 流程依赖"3000 端口上已经有一个 plain-node 后端"。本脚本自己起那个后端，
 *    让 App 走 `startBackend()` 里的"端口已被占用 → 复用"分支（App 日志会打印这一行，脚本会断言它）。
 *
 * 2. **CDP 端口只有 Electron 起来之后才知道**（`--remote-debugging-port=0` 由 Chromium 自己挑，
 *    写在 `<userData>/DevToolsActivePort`）。而后端要在**启动时**就拿到端点吗？不必 ——
 *    `ai-browser.ts` 的 `attachEndpoint()` 每次调用都现读 `process.env.SUPERCRZY_CDP_ENDPOINT`，
 *    所以在**第一次真正用到之前**把 env 补上就行。本启动器轮询一个端口文件，拿到就写进 env。
 *    （产品里这件事由 main.cjs 读端口后经 spawn 的 env 一次性传下去，不需要这一层；
 *      这里只是因为"后端不由 App 起"才补上。）
 *
 * 用法（由 scripts/diag/verify-desktop-ui.mjs 调用，不单独用）：
 *   DIAG_CDP_PORT_FILE=<path> ... node <tsx cli> scripts/diag/diag-backend-launcher.mjs
 */
import fs from 'node:fs'

const portFile = process.env.DIAG_CDP_PORT_FILE
if (portFile) {
  const timer = setInterval(() => {
    try {
      const p = fs.readFileSync(portFile, 'utf8').trim()
      if (p && /^\d+$/.test(p)) {
        process.env.SUPERCRZY_CDP_ENDPOINT = `http://127.0.0.1:${p}`
        console.log(`[diag-backend] CDP 端点已绑定 → ${process.env.SUPERCRZY_CDP_ENDPOINT}`)
        clearInterval(timer)
      }
    } catch { /* 文件还没写出来 */ }
  }, 200)
  timer.unref?.()
}

// 由 tsx 运行 → 这个 .ts 动态 import 会被正常转译。
// 路径是相对**本文件**（scripts/diag/）算的，不是相对 cwd。
await import('../../packages/server/src/app.ts')
