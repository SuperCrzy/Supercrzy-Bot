#!/usr/bin/env node
/**
 * SUPERCRZY BOT — 终端命令入口
 *
 * 为什么需要它（2026-10-16）：
 *   此前"一键启动"只有图形方式（双击 .app / start.bat）+ 直跑 start.sh，
 *   终端用户没有统一命令，也只能记 `pnpm dev` / `./start.sh` 这种项目内相对路径。
 *   本文件把常用动作收敛成 `supercrzy <命令>`，并兼顾"从任意目录调用"。
 *
 * 用法（`pnpm link --global` 之后在任意目录可用）：
 *   supercrzy            在当前目录（或向上找到的仓库根）启动，并打开浏览器
 *   supercrzy web        同上（显式写法）
 *   supercrzy dev        开发模式（server + client，含 5173 热更新）
 *   supercrzy cli        终端对话
 *   supercrzy stop       停止后台服务
 *   supercrzy install    在桌面创建启动图标（macOS）
 *   supercrzy status     查看服务状态
 *   supercrzy --help     帮助
 *
 * 设计约束：**不重造启动逻辑** —— web/stop/install 一律转发到仓库内既有脚本
 * （start.sh / install.command），保证与图形入口行为完全一致，避免两套实现漂移。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：本文件在 <root>/bin/ 下 */
const REPO_ROOT = resolve(HERE, '..')

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
}
const log = {
  info: (m) => console.log(`${C.cyan}[SUPERCRZY]${C.reset} ${m}`),
  ok: (m) => console.log(`${C.green}✔${C.reset} ${m}`),
  warn: (m) => console.log(`${C.yellow}⚠${C.reset} ${m}`),
  err: (m) => console.error(`${C.red}✘${C.reset} ${m}`),
}

const isWin = process.platform === 'win32'

/** 找到仓库根：优先 bin/ 的上级；否则从 cwd 逐级向上找 start.sh + pnpm-workspace.yaml */
function findRepoRoot() {
  if (existsSync(join(REPO_ROOT, 'start.sh')) || existsSync(join(REPO_ROOT, 'start.bat'))) return REPO_ROOT
  let d = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'pnpm-workspace.yaml')) && existsSync(join(d, 'start.sh'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

/** 转发到仓库内脚本（继承 stdio，Ctrl+C 可透传） */
function runScript(relPath, args = []) {
  const root = findRepoRoot()
  if (!root) {
    log.err('未找到 SUPERCRZY 仓库根目录（需要含 start.sh 与 pnpm-workspace.yaml）')
    log.info('请在仓库目录内运行，或先 git clone 并 cd 进去')
    process.exit(1)
  }
  const target = join(root, relPath)
  if (!existsSync(target)) {
    log.err(`找不到 ${relPath}（在 ${root}）`)
    process.exit(1)
  }
  log.info(`在 ${root} 执行 ${relPath}${args.length ? ' ' + args.join(' ') : ''}`)
  const child = spawn(target, args, { cwd: root, stdio: 'inherit', shell: isWin })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
  child.on('error', (e) => {
    log.err(`启动失败: ${e.message}`)
    process.exit(1)
  })
}

/** 读 settings 里记录的服务端口/状态（尽力而为，失败不阻断） */
function status() {
  const root = findRepoRoot()
  if (!root) { log.err('未找到仓库根目录'); process.exit(1) }
  const pidFile = join(homedir(), '.supercrzy', 'server.pid')
  console.log(`${C.bold}SUPERCRZY BOT${C.reset}`)
  console.log(`  仓库根      ${root}`)
  const v = (p) => {
    try { return JSON.parse(readFileSync(join(root, p), 'utf8')).version } catch { return '?' }
  }
  console.log(`  App 版本    ${v('packages/desktop/package.json')}`)
  console.log(`  引擎版本    ${v('package.json')}`)
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf8').trim()
    const alive = (() => {
      try { process.kill(Number(pid), 0); return true } catch { return false }
    })()
    console.log(`  后台服务    ${alive ? `${C.green}运行中${C.reset} (pid ${pid})` : `${C.dim}已停止（残留 pid 文件）${C.reset}`}`)
  } else {
    console.log(`  后台服务    ${C.dim}未启动${C.reset}`)
  }
  console.log(`  访问地址    http://localhost:3000`)
}

const HELP = `${C.bold}SUPERCRZY BOT${C.reset} — 终端入口

${C.bold}用法${C.reset}
  supercrzy [命令]

${C.bold}命令${C.reset}
  ${C.cyan}(无)${C.reset} / ${C.cyan}web${C.reset}   生产模式启动（装依赖 → 构建 → 起服务 → 开浏览器）
  ${C.cyan}dev${C.reset}         开发模式（server + client，5173 热更新）
  ${C.cyan}cli${C.reset}         终端对话（与 Web UI 共享配置）
  ${C.cyan}stop${C.reset}        停止后台服务
  ${C.cyan}install${C.reset}     在桌面创建启动图标（macOS）
  ${C.cyan}status${C.reset}      查看版本与服务状态
  ${C.cyan}help${C.reset}        显示本帮助

${C.bold}示例${C.reset}
  supercrzy                 直接启动
  supercrzy dev             开发者模式
  supercrzy stop            停掉后台服务

${C.dim}提示：web / stop / install 会转发到仓库内既有脚本（start.sh / install.command），
      与双击图标的行为完全一致。${C.reset}
`

const cmd = (process.argv[2] || 'web').toLowerCase()
switch (cmd) {
  case 'web':
  case 'start':
  case 'serve':
    runScript(isWin ? 'start.bat' : 'start.sh')
    break
  case 'dev':
    runScript('start.sh', ['dev'])
    break
  case 'cli':
  case 'chat':
    runScript('start.sh', ['cli'])
    break
  case 'stop':
    runScript('start.sh', ['stop'])
    break
  case 'install':
    if (!isWin) runScript('scripts/install.command')
    else log.warn('Windows 无需安装图标，直接双击 start.bat 即可')
    break
  case 'status':
  case 'info':
    status()
    break
  case 'help':
  case '-h':
  case '--help':
    console.log(HELP)
    break
  default:
    log.err(`未知命令: ${cmd}`)
    console.log(HELP)
    process.exit(1)
}
