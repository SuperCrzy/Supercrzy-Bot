#!/usr/bin/env node
/**
 * 干净包门禁 / 导出器（2026-10-14）
 *
 * 规则（老板 2026-10-14 定）：**个人测试产物、运行时数据、凭据一律不进代码仓库；
 * 对外上传的那份必须是一个纯干净的包。**
 *
 * 设计要点 —— 「干净包」的唯一合法来源是 **git 索引**，不是工作区目录。
 *   工作区里躺着大量本机产物（试验页、截图、上传目录、Playwright 缓存、
 *   `data/checkpoints`、`SUPERCRZY BOT.app`…）。它们大多已被 `.gitignore` 挡住，
 *   所以「打包 = 拷目录」是错的：拷目录会把它们全带上。
 *   ⇒ 导出必须走 `git checkout-index`（只出索引），绝不 `cp -R` / `zip -r`。
 *
 * 两种模式：
 *   node scripts/check-clean-tree.mjs                  检查**索引**里有没有违规路径（挂进 pnpm verify）
 *   node scripts/check-clean-tree.mjs --export <dir>   从索引导出干净树到 <dir>，并对导出结果复检
 *
 * 判定规则只写一份（BLOCKLIST / REQUIRED），两个模式共用 —— 避免「检查的规则」和
 * 「导出的规则」漂移成两套。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/**
 * 拦截规则。每条含 id / why / 判据，命中时把 id 与 why 一起打出来，
 * 让看到红的人知道"为什么它不能进仓库"，而不是只看到一个路径。
 */
const BLOCKLIST = [
  {
    id: 'runtime-workspace',
    why: '运行时工作区：任务检查点、数据库、微信登录凭据、自动演化出来的技能副本，全是本机使用数据',
    // ⚠️ 不能用「任意层级的 data/」判据：packages/client/src/data/ 是**产品源码**，会被误伤。
    exactPrefix: ['data/', 'packages/server/data/'],
  },
  {
    id: 'internal-docs',
    why: '内部资料：审计报告 / 竞品逆向 / 演示稿 / 原型页，不随仓库分发',
    exactPrefix: ['docs/internal/'],
  },
  {
    id: 'internal-manual',
    // 与 .gitignore 的规则**故意重复**：.gitignore 只挡「随手 add」，挡不住 `git add -f`，
    // 也挡不住有人为了图方便把规则删掉。这道闸门跑在 pnpm verify 第一步，是最后一层。
    // 2026-10-26 曾误提交一次运维手册（第 33 行是明文 root 密码），在 push 前拦下。
    why: '运维手册含 VPS 地址与明文 root 密码；界面设计稿属内部资产 —— 均不得入库、不得开源',
    exactPrefix: ['docs/PROJECT_BOT_MANUAL.md', 'packages/server/bot-mockup.html'],
  },
  {
    id: 'local-tool-state',
    why: '本机工具状态目录，与项目源码无关',
    anySegment: ['.playwright-cli', '.git-rewrite'],
  },
  {
    id: 'build-output',
    why: '构建产物 / 依赖树，应由使用方本地生成，不进仓库也不进包',
    anySegment: ['node_modules', 'dist', 'releases', '.deploy-server', '.build-tools'],
    exactPrefix: ['dist-bak-', 'dist-old-'],
  },
  {
    id: 'user-content',
    why: '本机运行产生的内容目录',
    exactPrefix: ['uploads/', 'articles/', 'logs/'],
  },
  {
    id: 'credentials',
    why: '凭据类文件 —— 任何路径下都不许进仓库（示例文件除外）',
    basename: [/^\.env$/, /^\.env\.local$/, /^\.env\.production$/],
    basenameAnyPath: [/^ilink-credentials\.json$/, /^SUPERCRZY_AGENT_参考手册\.md$/, /^id_rsa/, /\.pem$/, /\.p12$/],
    pattern: [/\.db$/, /\.db-wal$/, /\.db-shm$/, /\.db-journal$/, /\.db\.(bak|broken)/],
  },
  {
    id: 'root-scratch',
    why: '根目录一次性试验页 / 截图 / 探针脚本，非产品代码（文件保留在工作区，只是不入库）',
    rootOnly: [
      /^pet\.html$/, /^snake\.html$/, /^snake-game\.html$/, /^snake-game\//,
      /^login\.html$/, /^login-modern\.html$/, /^login-page\.html$/,
      /^phone-page\.html$/, /^recess-prototype\.html$/, /^shooting-game\.html$/, /^todo\.html$/,
      /^psl-.*\.png$/, /^shot-.*\.png$/, /^streaming\.png$/, /^chat-full\.png$/, /^game-live-.*\.png$/,
      /^notes\.md$/, /^shot\.js$/, /^verify-full\.js$/,
      /^nova-watch\//, /^aurora-product\//,
      /\.app$/, /\.mp4$/, /\.mov$/,
    ],
  },
  {
    id: 'package-scratch',
    why: '包内一次性探针 / 试验残留',
    exactPrefix: [
      'packages/server/_detach_probe.txt', 'packages/server/_do_restart.sh',
      'packages/server/fib.py', 'packages/server/snake_game/',
      'packages/server/union-demo.html',
    ],
    pattern: [/^packages\/server\/test_stream_.*\.py$/, /^packages\/server\/ui.*\.mts$/, /^packages\/server\/.*-probe\.(ts|mts)$/],
  },
]

/** 白名单：这些虽然命中规则，但**是产品的一部分**，必须允许 */
const ALLOW = new Set([
  '.env.example',              // 纯占位示例
  '.env.production.example',
  'SUPERCRZY BOT.command',     // README 承诺的启动入口（手写、随仓库分发）
  'start.sh',
  'start.bat',
])

/** 导出树必须包含的条目 —— 少了说明包是残的（README 承诺的入口必须在） */
const REQUIRED_IN_EXPORT = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'start.sh', 'start.bat', 'SUPERCRZY BOT.command',
  'packages/server/src', 'packages/client/src', 'packages/desktop/main.cjs',
]

const segmentsOf = (p) => p.split('/').filter(Boolean)

/** 对一组相对路径跑规则，返回命中列表 [{path, id, why}] */
function scan(paths) {
  const hits = []
  for (const p of paths) {
    if (ALLOW.has(p)) continue
    const segs = segmentsOf(p)
    const base = segs[segs.length - 1] || ''
    const isRoot = segs.length === 1

    for (const rule of BLOCKLIST) {
      let hit = false
      if (rule.exactPrefix?.some((pre) => p === pre.replace(/\/$/, '') || p.startsWith(pre))) hit = true
      if (!hit && rule.anySegment?.some((s) => segs.includes(s))) hit = true
      if (!hit && rule.basename?.some((re) => isRoot && re.test(p))) hit = true
      if (!hit && rule.basenameAnyPath?.some((re) => re.test(base))) hit = true
      if (!hit && rule.pattern?.some((re) => re.test(p))) hit = true
      if (!hit && rule.rootOnly?.some((re) => re.test(p))) hit = true

      if (hit) { hits.push({ path: p, id: rule.id, why: rule.why }); break }
    }
  }
  return hits
}

function report(hits, scope) {
  if (hits.length === 0) return true
  const byRule = new Map()
  for (const h of hits) {
    if (!byRule.has(h.id)) byRule.set(h.id, { why: h.why, paths: [] })
    byRule.get(h.id).paths.push(h.path)
  }
  console.error(`\n✘ ${scope} 发现 ${hits.length} 个不该出现的路径：\n`)
  for (const [id, { why, paths }] of byRule) {
    console.error(`  [${id}] ${why}`)
    const shown = paths.slice(0, 8)
    for (const p of shown) console.error(`      ${p}`)
    if (paths.length > shown.length) console.error(`      … 其余 ${paths.length - shown.length} 个同类`)
    console.error('')
  }
  console.error('  规则：个人测试产物 / 运行时数据 / 凭据不进仓库；导出只走 git 索引，不拷工作区。')
  console.error('  修法：这些路径应保留在工作区（或移入 docs/internal/），并用 `git rm -r --cached <path>` 脱离索引。\n')
  return false
}

function indexPaths() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.split('\0').filter(Boolean)
}

function walkRel(root, prefix = '') {
  const acc = []
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(join(root, rel)).isDirectory()) acc.push(...walkRel(root, rel))
    else acc.push(rel)
  }
  return acc
}

function checkIndex() {
  const paths = indexPaths()
  const hits = scan(paths)
  const ok = report(hits, 'git 索引')
  if (ok) console.log(`✔ 索引干净：${paths.length} 个被跟踪文件，0 个违规路径`)
  return ok
}

function exportClean(dir) {
  const dest = resolve(dir)
  if (dest.startsWith(REPO + sep)) {
    console.error(`✘ 导出目录不能放在仓库内（会被本机残留污染）：${dest}`)
    return false
  }
  if (existsSync(dest)) { console.log(`  清空已存在的 ${dest}`); rmSync(dest, { recursive: true, force: true }) }
  mkdirSync(dest, { recursive: true })

  // 只信索引：checkout-index 从 index 出树，工作区里那些本机残留一概不带
  execFileSync('git', ['checkout-index', '-a', '-f', `--prefix=${dest}${sep}`], { cwd: REPO, stdio: 'inherit' })

  const entries = walkRel(dest)
  console.log(`\n  已从 git 索引导出 ${entries.length} 个文件 → ${dest}`)
  const hits = scan(entries)
  let ok = report(hits, '导出树')

  const missing = REQUIRED_IN_EXPORT.filter((r) => !existsSync(join(dest, r)))
  if (missing.length) {
    console.error(`\n✘ 导出树缺少必需条目（包不完整）：\n${missing.map((m) => '      ' + m).join('\n')}\n`)
    ok = false
  }
  if (ok) {
    console.log(`✔ 导出树干净且完整：${entries.length} 个文件，无违规路径，必需条目齐全`)
    console.log(`  可直接压缩上传：cd ${dest} && zip -qr ../supercrzy-clean.zip .`)
  }
  return ok
}

const argv = process.argv.slice(2)
const exportIdx = argv.indexOf('--export')
const passed = exportIdx === -1
  ? checkIndex()
  : (argv[exportIdx + 1] ? exportClean(argv[exportIdx + 1]) : (console.error('✘ --export 需要一个目录参数'), false))

process.exit(passed ? 0 : 1)
