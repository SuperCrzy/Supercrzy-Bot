#!/usr/bin/env node
/**
 * CDP 桥：把 Android Chrome 的 abstract unix socket 桥成 TCP。
 *
 * 为什么需要：
 *   Playwright 的 connectOverCDP 只认 http(s) 端点，而真机 Chrome 的 DevTools
 *   只暴露 abstract unix socket（`\0chrome_devtools_remote`）。
 *   socat 在 Alpine 上不顶用 —— 它的 abstract socket 支持没编译进去，
 *   `UNIX-CONNECT:@chrome_devtools_remote` 会把 `@` 当文件路径，
 *   报 `connect(, AF=1 ...): No such file or directory`（2026-10-20 实测）。
 *   Node 原生支持 `\0` 前缀的 Linux abstract namespace ⇒ 裸 net.pipe 双向转发即可，
 *   零依赖、零二进制。
 *
 * 为什么裸 pipe 就够：
 *   CDP 的 HTTP 握手与 WebSocket 升级是同一条 TCP 流上的字节，透明转发不需要懂协议。
 *
 * 用法：node cdp-bridge.mjs
 * env：CDP_BRIDGE_PORT（默认 9333）、CDP_BRIDGE_HOST（默认 127.0.0.1）、
 *      CDP_SOCKET_NAME（默认 chrome_devtools_remote）
 *
 * 生命周期：常驻。Chrome 被 LMK 杀掉后 abstract socket 消失，本进程不退出，
 * 新连接自然失败；Chrome 重启后 socket 重建，下一个连接自动恢复。
 */
import net from 'node:net'

const PORT = Number(process.env.CDP_BRIDGE_PORT || 9333)
const HOST = process.env.CDP_BRIDGE_HOST || '127.0.0.1'
const NAME = process.env.CDP_SOCKET_NAME || 'chrome_devtools_remote'
const SOCK = '\0' + NAME

const log = (m) => console.log(`[cdp-bridge] ${new Date().toISOString()} ${m}`)

const server = net.createServer((down) => {
  const up = net.connect({ path: SOCK })
  up.on('connect', () => log('upstream connected'))
  up.on('error', (e) => { log('upstream error: ' + e.code); down.destroy() })
  down.on('error', () => up.destroy())
  down.pipe(up)
  up.pipe(down)
})

server.on('error', (e) => { log('listen failed: ' + e.code + ' ' + e.message); process.exit(1) })
server.listen(PORT, HOST, () => log(`listening ${HOST}:${PORT} -> @${NAME}`))

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(sig + ' -> exit'); try { server.close() } catch {} ; process.exit(0) })
}
