/**
 * AI 浏览器端到端验收（2026-09-23）
 *
 * 目的：证明「右栏看不到 AI 操作画面」与「任务跑完 Chrome 不退」这两个真 bug 修住了 ——
 * 不是单测绿就算数，而是真起一个 Chrome，让 **AI 工具侧** 和 **右栏 HTTP 侧** 走同一个实例。
 *
 * 关键设计：把 `collabRouter` 挂进**本进程**。
 * 只有同进程才能真正验证"工具写的 key == 路由读的 key"这条不变量 ——
 * 若分成两个进程，各自一张实例表，测试会假通过（第一版就踩了这个坑）。
 *
 * 覆盖四条不变量：
 *   A 工具侧写进会话 key（不再是 default 桶）
 *   B 右栏长轮询能读到 AI 那次导航的帧（= DetailPanel.pollLiveFrame 的消费路径）
 *   C 显式释放（POST /browser/close）真的让实例消失
 *   D 闲置回收覆盖 default 桶（老代码直接 skip → 实测残留无头 Chrome 34 分钟不退）
 *
 * 运行（在 packages/server 下；用独立 DB 免碰真实库）：
 *   DB_PATH=/tmp/supercrzy-diag.db WORKSPACE_DIR=/tmp/supercrzy-diag-ws \
 *     node node_modules/tsx/dist/cli.mjs ../../scripts/diag/verify-ai-browser.ts
 */
import { createServer } from 'http'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import tool from '../../packages/server/src/tools/browser'
import { collabRouter } from '../../packages/server/src/routes/collab'
import {
  activeBrowserKeys, browserKey, closeAllBrowsers,
  browserNavigate, __auditIdleAt,
} from '../../packages/server/src/services/ai-browser'

const SID_TOOL = 'diag-tool-1'
const SID_HTTP = 'diag-http-1'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** 本地页面：不依赖外网，标题/按钮/链接都可断言 */
function startLocalPage(): Promise<{ url: string; urlOf: (p: string) => string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const path = (req.url || '/').split('?')[0]
      res.end(`<!doctype html><html><head><title>DIAG-LOCAL-PAGE${path === '/' ? '' : '-2'}</title></head>
        <body><h1>Diag Local Page</h1><a href="/next">去下一页</a><button>点我</button>
        <p>这是诊断脚本的本地页面，用于断言 AI 浏览器真的读到了正确内容。</p></body></html>`)
    })
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const origin = `http://127.0.0.1:${port}`
      resolve({
        url: origin + '/',
        urlOf: (p: string) => origin + p,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      })
    })
  })
}

/** 同进程 Koa：把协作平台路由（含 AI 浏览器 7 条接口）挂起来 */
function startRouter(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = new Koa()
    app.use(bodyParser())
    app.use(collabRouter.routes()).use(collabRouter.allowedMethods())
    const srv = createServer(app.callback())
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) })
    })
  })
}

async function main() {
  const page = await startLocalPage()
  const api = await startRouter()
  console.log(`本地测试页: ${page.url}\n内嵌路由:   ${api.base}\n`)

  const j = async (path: string, init?: RequestInit) => {
    const r = await fetch(api.base + path, init)
    const t = await r.text()
    try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
  }
  const hdr = (sid: string) => ({ 'Content-Type': 'application/json', 'X-Browser-Key': sid })

  try {
    // ---------- A. 工具侧写进会话 key ----------
    console.log('[A] AI 工具侧走会话实例（不再是 default 桶）')
    const out = await tool.execute({ action: 'navigate', url: page.url }, { sessionId: SID_TOOL })
    check('browser 工具 navigate 成功', String(out).includes('DIAG-LOCAL-PAGE'), String(out).split('\n')[0].slice(0, 100))

    const s1 = await j('/api/collab/browser/sessions')
    const keys1 = ((s1.body as any)?.keys || []) as string[]
    check('路由侧看到工具创建的会话实例（两侧同一张实例表）',
      keys1.includes(browserKey(SID_TOOL)), `路由侧 keys=${JSON.stringify(keys1)}`)
    check('default 桶未被 AI 工具写入（老 bug 的直接特征）',
      !keys1.includes('default'), JSON.stringify(keys1))

    // ---------- B. 右栏能看到 AI 的帧 ----------
    console.log('\n[B] 右栏长轮询读到 AI 的帧（DetailPanel 的消费路径）')
    const latest = await j('/api/collab/browser/latest?after=0', { headers: hdr(SID_TOOL) })
    const f = latest.body as any
    check('latest 返回了帧', !!f?.ts && !!f?.screenshot, `ts=${f?.ts} shot=${f?.screenshot?.length ?? 0}B url=${f?.url ?? '-'}`)
    check('帧就是 AI 刚打开的那个页面', String(f?.url || '').startsWith(page.url), String(f?.url || '-'))

    // ---------- C. 显式释放 ----------
    console.log('\n[C] 显式释放实例')
    await j('/api/collab/browser/navigate', { method: 'POST', headers: hdr(SID_HTTP), body: JSON.stringify({ url: page.urlOf('/next') }) })
    const s2 = await j('/api/collab/browser/sessions')
    const keys2 = ((s2.body as any)?.keys || []) as string[]
    check('两个会话各自一个实例（互不串台）',
      keys2.includes(browserKey(SID_TOOL)) && keys2.includes(browserKey(SID_HTTP)), JSON.stringify(keys2))

    await j('/api/collab/browser/close', { method: 'POST', headers: hdr(SID_TOOL), body: '{}' })
    const s3 = await j('/api/collab/browser/sessions')
    check('POST /browser/close 后该实例消失',
      !((s3.body as any)?.keys || []).includes(browserKey(SID_TOOL)), JSON.stringify((s3.body as any)?.keys))

    // ---------- D. 闲置回收覆盖 default 桶 ----------
    console.log('\n[D] 闲置回收（含 default 桶）')
    await browserNavigate(page.url) // 便捷导出 → 'default' 桶（模拟 video-transcript/content-factory）
    check('default 桶实例已建立', activeBrowserKeys().includes('default'), JSON.stringify(activeBrowserKeys()))

    const mid = __auditIdleAt(Date.now() + 11 * 60 * 1000)
    check('11 分钟后 default 桶仍保留（后台服务不被误杀）', !mid.includes('default'), `本轮回收=${JSON.stringify(mid)}`)
    const late = __auditIdleAt(Date.now() + 31 * 60 * 1000)
    check('31 分钟后 default 桶被回收（老代码此处永远为 false）', late.includes('default'), `本轮回收=${JSON.stringify(late)}`)
    check('回收后实例表不再持有 default', !activeBrowserKeys().includes('default'), JSON.stringify(activeBrowserKeys()))

    // 收尾：确认没有实例泄漏（HTTP 侧 + 本进程侧）
    await j('/api/collab/browser/close', { method: 'POST', headers: hdr(SID_HTTP), body: '{}' })
    await closeAllBrowsers()
    const s4 = await j('/api/collab/browser/sessions')
    const keys4 = ((s4.body as any)?.keys || []) as string[]
    check('收尾后无残留实例', keys4.length === 0 && activeBrowserKeys().length === 0,
      `路由侧=${JSON.stringify(keys4)} 本进程=${JSON.stringify(activeBrowserKeys())}`)
  } finally {
    await closeAllBrowsers().catch(() => {})
    await api.close()
    await page.close()
  }

  console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ 有 ${failed} 项未通过`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1) })
