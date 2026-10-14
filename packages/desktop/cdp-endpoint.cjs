/**
 * CDP 端点发现（2026-09-23）
 *
 * 背景：AI 浏览器要从「截图监控器」升级为「人和 AI 共用的操作面」，
 * 前提是后端能 `connectOverCDP` 接管 Electron 窗口里那个**真网页**。
 * 于是 desktop 必须让 Electron 开一个 CDP 端口，并把端点告诉内嵌后端。
 *
 * 为什么不让 desktop 自己挑一个端口（比如写死 9333）：
 *   · 固定端口会撞：撞了就 attach 到**别人的浏览器**上（最坏的一类故障：看着能用，操作的是别人的页面）
 *   · 自己 bind(0) 拿端口再让出去，中间有 TOCTOU 竞态窗口
 * 所以用 `--remote-debugging-port=0`，Chromium 自己挑空闲端口，并把结果写进
 * `<userData>/DevToolsActivePort`（第一行端口、第二行 browser 级 WS 路径）。
 *
 * ⚠️ 这个文件有两个**很容易踩、且踩了看不出原因**的性质：
 *   1) **异步写**：端口文件不是在进程一开始就有的，读早了读不到 →
 *      表现为"attach 随机不可用"。必须轮询。
 *   2) **跨运行残留**：上一个进程退出了，文件还在（内容指向上次的端口）。
 *      读到过期端口 → 连到一个已经死掉的端口，或更糟：连到**另一个还活着的实例**。
 *
 * 处置残留有几种写法，这里选的是**不靠时序**的一种（试过"在 whenReady 时删掉文件"，
 * 那是错的：Chromium 可能早在我们的脚本跑之前就写好了新端口，删掉等于把好数据扔了，
 * 然后永远等不到新的）。现在的判据是：
 *   · 文件的 mtime 必须落在「本次启动之后（留 FRESH_MARGIN_MS 余量）」→ 才认它是新的
 *   · 再对端口做一次**探活**（GET /json/version）→ 挡住"mtime 恰好卡在边界上的残留"
 * 两者都不需要知道 Chromium 到底什么时候写的。
 *
 * 抽成独立模块是为了可验证：整条链路要靠 Electron 才跑得起来，
 * 而"解析 / 新鲜度判定 / 等待 / 回落决策"这几段纯逻辑不需要。
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 100
/** 认"新文件"时向前放宽的余量：Chromium 可能在主脚本执行**之前**就写好了端口 */
const FRESH_MARGIN_MS = 5000
/** DevToolsActivePort 文件名（Chromium 约定，别改） */
const PORT_FILE = 'DevToolsActivePort'

/**
 * 解析 `DevToolsActivePort` 的内容。
 * 真实内容形如 `54694\n/devtools/browser/<uuid>\n`
 * @returns {{ port: number, wsPath: string } | null}
 */
function parseDevToolsActivePort(text) {
  if (!text) return null
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return null
  const port = Number(lines[0])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  // 第二行是 browser 级 WS 路径；缺失不影响 connectOverCDP（它只要 host:port），所以不 fail
  return { port, wsPath: lines[1] || '' }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/**
 * 读一次端口文件，并判定它是不是**本次启动**写的。
 *
 * @param {string} userDataDir
 * @param {{ sinceMs?: number, marginMs?: number }} [opts] sinceMs = 本进程启动时刻（越早取越好）
 * @returns {{ state: 'missing'|'unusable'|'stale'|'fresh', file: string,
 *             port?: number, wsPath?: string, mtimeMs?: number }}
 */
function readPortFile(userDataDir, opts = {}) {
  const file = path.join(userDataDir || '', PORT_FILE)
  const sinceMs = Number(opts.sinceMs) || 0
  const marginMs = Number.isFinite(opts.marginMs) ? Number(opts.marginMs) : FRESH_MARGIN_MS

  let st
  try { st = fs.statSync(file) } catch { return { state: 'missing', file } }
  const parsed = parseDevToolsActivePort(safeRead(file))
  if (!parsed) return { state: 'unusable', file, mtimeMs: st.mtimeMs }
  // 没有 sinceMs（调用方没给启动时刻）时不做新鲜度判断，只保证内容可解析
  if (sinceMs && st.mtimeMs < sinceMs - marginMs) {
    return { state: 'stale', file, mtimeMs: st.mtimeMs, ...parsed }
  }
  return { state: 'fresh', file, mtimeMs: st.mtimeMs, ...parsed }
}

/** 探活：端口上真的有 CDP 在听吗（挡住"残留端口恰好活着/恰好边界"这类误判） */
async function probeCdpPort(port, timeoutMs = 800) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * 轮询等一个「本次启动写的、且活着的」端口。
 * @returns {Promise<{ found: object|null, reason: string }>}
 */
async function waitForCdpPort(userDataDir, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS
  const intervalMs = Number(opts.intervalMs) || POLL_INTERVAL_MS
  const sinceMs = Number(opts.sinceMs) || 0
  const probe = opts.probe === undefined ? probeCdpPort : opts.probe
  const deadline = Date.now() + timeoutMs
  let last = 'missing'
  let lastPort = null
  for (;;) {
    const r = readPortFile(userDataDir, { sinceMs, marginMs: opts.marginMs })
    if (r.state === 'fresh') {
      lastPort = r.port
      if (!probe || await probe(r.port)) {
        return { found: { port: r.port, wsPath: r.wsPath, file: r.file, mtimeMs: r.mtimeMs }, reason: 'ok' }
      }
      last = 'probe-failed'
    } else {
      last = r.state
      if (r.port) lastPort = r.port
    }
    if (Date.now() >= deadline) {
      const tail = last === 'probe-failed' ? `（端口 ${lastPort} 无响应）` : ''
      return { found: null, reason: `state=${last}${tail}` }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 拼 CDP 端点。始终 127.0.0.1 —— CDP 绝不能对外暴露（拿到它等于拿到整个 App 的 JS 执行权） */
function cdpEndpoint(port) {
  return `http://127.0.0.1:${port}`
}

/** 本机是否已显式关闭 CDP（排障/安全兜底开关） */
function cdpDisabled(env = process.env) {
  return String(env.SUPERCRZY_CDP_OFF || '') === '1'
}

/**
 * 决定给内嵌后端 spawn 的 attach env。
 *
 * @returns {Promise<{ env: Record<string,string>, ok: boolean, reason: string,
 *                     endpoint?: string, port?: number, wsPath?: string }>}
 *
 * 关键行为：**失败一律回落 launch**。
 * 读不到端口却把 `BROWSER_MODE=attach` 传下去，后果是浏览器每次操作都抛
 * "找不到可接管的真网页" —— 比直接用 launch 差得多。所以这里宁可显式写 `launch`。
 */
async function resolveAttachEnv(opts = {}) {
  const userDataDir = opts.userDataDir
  const enabled = opts.enabled !== false
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS
  const sinceMs = Number(opts.sinceMs) || 0
  const probe = opts.probe

  if (cdpDisabled()) {
    return { env: { BROWSER_MODE: 'launch' }, ok: false, reason: 'SUPERCRZY_CDP_OFF=1：显式关闭 CDP' }
  }
  if (!enabled) {
    return { env: { BROWSER_MODE: 'launch' }, ok: false, reason: '调用方关闭（enabled=false）' }
  }
  if (!userDataDir) {
    return { env: { BROWSER_MODE: 'launch' }, ok: false, reason: '缺少 userDataDir，无法定位 DevToolsActivePort' }
  }

  const { found, reason } = await waitForCdpPort(userDataDir, { timeoutMs, sinceMs, probe })
  if (!found) {
    // 操作者自己显式设了端点 → 说明他在做排障（连别的 Electron/Chrome），不要覆盖他的选择
    const operatorEndpoint = String(process.env.SUPERCRZY_CDP_ENDPOINT || '').trim()
    return {
      env: operatorEndpoint ? {} : { BROWSER_MODE: 'launch' },
      ok: false,
      reason: `${timeoutMs}ms 内没拿到本次启动的 CDP 端口（${reason}；文件 ${path.join(userDataDir, PORT_FILE)}）`,
    }
  }

  return {
    env: { BROWSER_MODE: 'attach', SUPERCRZY_CDP_ENDPOINT: cdpEndpoint(found.port) },
    ok: true,
    endpoint: cdpEndpoint(found.port),
    port: found.port,
    wsPath: found.wsPath,
    reason: 'ok',
  }
}

module.exports = {
  PORT_FILE,
  DEFAULT_TIMEOUT_MS,
  FRESH_MARGIN_MS,
  parseDevToolsActivePort,
  readPortFile,
  probeCdpPort,
  waitForCdpPort,
  cdpEndpoint,
  cdpDisabled,
  resolveAttachEnv,
}
