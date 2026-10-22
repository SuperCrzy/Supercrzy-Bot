#!/usr/bin/env node
/**
 * 命名对标表自检（2026-10-22）。
 *
 * 为什么要有这个脚本：`docs/internal/analysis/NAMING_MAP_WORKBUDDY_vs_SUPERCRZY.md`
 * 里的每一行都是"我们有哪些能力"的断言，而表会腐坏 —— 文件改名、能力下线、
 * 我对着一张旧表继续下判断，就会重演"把有判成没有"。
 *
 * 所以让表**自己验证自己**：每行给出我方命中的检索模式，跑不出来就报 MISS。
 *
 * 用法：
 *   node scripts/diag/naming-map-check.mjs
 *   WB_CLI=/path/to/cli.mjs WB_I18N=/path/to/i18n.js node scripts/diag/naming-map-check.mjs
 *
 * 退出码：我方任一行 MISS ⇒ 1（可挂进 CI）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SCAN_DIRS = ['packages/server/src', 'packages/client/src']
const EXTS = new Set(['.ts', '.vue', '.mjs', '.cjs'])
const WB_UNPACKED = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked'
/** 对方侧扫描源：CLI + 主进程 + 守护进程 + 渲染层关键 bundle（缺文件自动跳过） */
const WB_CLI = process.env.WB_CLI || '/tmp/wb-deep/cli.mjs'
const THEIR_SOURCES = (process.env.WB_SOURCES || [
  WB_CLI,
  '/tmp/wb-deep/main-server.js',
  '/tmp/wb-deep/daemon.js',
  `${WB_UNPACKED}/renderer/assets/src-DbE1_mgM.js`,
  `${WB_UNPACKED}/renderer/assets/src-0FGg1seX.js`,
  `${WB_UNPACKED}/renderer/assets/artifact-DiRw8UKk.js`,
  `${WB_UNPACKED}/renderer/assets/i18n-Cxy1Uuvv.js`,
  `${WB_UNPACKED}/renderer/assets/contexts-BNN7VV-R.js`,
].join(',')).split(',').filter(Boolean)

/** 每行：ours 为必检；theirs 为可选（缺文件则标 SKIP，不算失败） */
const ROWS = [
  { id: 1, ability: '主动提问', ours: ['ask_user'], theirs: ['AskUserQuestion'] },
  { id: 2, ability: '并行/串行屏障', ours: ['buildBarrierGroups'], theirs: ['executionSlot', 'reserveExecutionSlot'] },
  { id: 3, ability: '上下文压缩', ours: ['shouldCompress', 'context-compressor'], theirs: ['compactAndSummarize'] },
  { id: 4, ability: '轮次耗时', ours: ['ElapsedBadge', 'ProcessStatusLine'], theirs: ['TurnStatusLine', 'useProcessingDurationMs'] },
  { id: 5, ability: '过程折叠', ours: ['composeFoldSummary'], theirs: ['computeSegments', 'attachSummaries', 'fold.completed'] },
  { id: 6, ability: '行数统计', ours: ['FileDiffViewer'], theirs: ['getResultStats'] },
  // 交付：我们叫 deliverySummary/sessionArtifacts，**没有** present_files（2026-10-22 自检抓出的假阳性）
  { id: 7, ability: '交付识别', ours: ['deliverySummary', 'sessionArtifacts'], theirs: ['present_files', 'workbuddy_present_files'] },
  { id: 8, ability: '任务/计划', ours: ['create_plan', 'task_create'], theirs: ['taskList', 'planEditor'] },
  { id: 9, ability: '技能', ours: ['skill_install', 'skill_search'], theirs: ['skill.list', 'Skill', 'skills'] },
  { id: 10, ability: '权限审批', ours: ['decideToolApproval'], theirs: ['permissionMode', 'acceptEdits', 'bypassPermissions'] },
  { id: 11, ability: 'MCP', ours: ['mcp-manager'], theirs: ['mcpServers', 'mcp:'] },
  { id: 12, ability: '沙箱', ours: ['assertSafeFilePath'], theirs: ['SandboxService'] },
  // 收紧：对方真正的证据是分类明细，不是 contextWindow 这种通用词
  { id: 13, ability: '上下文用量', ours: ['ContextUsageRing'], theirs: ['contextUsage.byCategory'] },
  { id: 14, ability: '子代理', ours: [], theirs: ['subAgentSession'] },
  { id: 15, ability: '后台守护', ours: [], theirs: ['daemon-bootstrap', 'ResourceGuardian'] },
  { id: 16, ability: '计划编辑器', ours: [], theirs: ['planEditor'] },
]

function walk(dir, out = []) {
  let items = []
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name.startsWith('.')) continue
    const p = path.join(dir, it.name)
    if (it.isDirectory()) walk(p, out)
    else if (EXTS.has(path.extname(it.name))) out.push(p)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
const cache = new Map()
function content(f) {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(f, 'utf8'))
  return cache.get(f)
}
/** 返回首个命中的 相对路径:行号，未命中返回 null */
function findInOur(patterns) {
  for (const f of files) {
    const s = content(f)
    for (const pat of patterns) {
      const i = s.indexOf(pat)
      if (i >= 0) {
        const line = s.slice(0, i).split('\n').length
        return `${path.relative(ROOT, f)}:${line}`
      }
    }
  }
  return null
}

const theirsSources = THEIR_SOURCES.filter((f) => {
  try { return fs.statSync(f).isFile() } catch { return false }
})
const theirCache = new Map()
function findInTheirs(patterns) {
  if (!theirsSources.length) return 'SKIP'
  for (const f of theirsSources) {
    if (!theirCache.has(f)) theirCache.set(f, fs.readFileSync(f, 'utf8'))
    if (patterns.some((p) => theirCache.get(f).includes(p))) return path.basename(f)
  }
  return null
}

let miss = 0
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
console.log(pad('能力', 16), pad('我方', 12), pad('对方', 10), '命中位置')
console.log('-'.repeat(78))
for (const r of ROWS) {
  const ours = r.ours.length ? findInOur(r.ours) : null
  const theirs = r.theirs.length ? findInTheirs(r.theirs) : '—'
  const oursMark = r.ours.length ? (ours ? '有' : 'MISS') : '（无）'
  if (r.ours.length && !ours) miss++
  // 注意：没有对方模式时必须显示“未检”，不能因为 '—' 是 truthy 就显示“有”
  let theirsMark
  if (!r.theirs.length) theirsMark = '未检'
  else if (theirs === 'SKIP') theirsMark = 'SKIP'
  else if (theirs) theirsMark = '有'
  else theirsMark = '未找到'
  console.log(
    pad(r.ability, 16),
    pad(oursMark, 10),
    pad(theirsMark, 8),
    ours || (r.ours.length ? '' : '—') + (theirs && theirs !== 'SKIP' ? '  ← ' + theirs : ''),
  )
}
console.log('-'.repeat(78))
console.log(miss ? `❌ 我方 ${miss} 行 MISS（表已腐坏，先更新表再下判断）` : '✅ 我方全部命中')
process.exit(miss ? 1 : 0)
