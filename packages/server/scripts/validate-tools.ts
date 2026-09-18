/**
 * 工具注册一致性守卫（P1-03 低风险第一步）
 * 双写风险：toolExecutors(执行器) 与 toolDefinitions(schema) 分别维护，易漂移。
 * 本脚本在运行时真实 import 两者并比对名字集合，输出差异。
 * 用法: node node_modules/tsx/dist/cli.mjs scripts/validate-tools.ts
 */
import { toolExecutors, toolDefinitions, DEFERRED_TOOLS, alwaysOnToolDefs, validateAlwaysOnContract, MAX_ALWAYS_ON_TOOLS } from '../src/services/tools'

const execNames = Object.keys(toolExecutors).sort()
const defNames = toolDefinitions.map((d) => d.name).sort()

const onlyExec = execNames.filter((n) => !defNames.includes(n))
const onlyDef = defNames.filter((n) => !execNames.includes(n))

console.log('=== 工具注册一致性校验 ===')
console.log(`执行器 toolExecutors : ${execNames.length} 个`)
console.log(`定义   toolDefinitions: ${defNames.length} 个`)
console.log(`按需   DEFERRED_TOOLS : ${DEFERRED_TOOLS.size} 个`)
console.log('')

let failed = false

if (onlyExec.length === 0 && onlyDef.length === 0) {
  console.log('✅ 一致：执行器与定义名字集合完全相同')
} else {
  if (onlyExec.length) console.log(`❌ 只有执行器、缺定义 (${onlyExec.length}): ${onlyExec.join(', ')}`)
  if (onlyDef.length) console.log(`❌ 只有定义、缺执行器 (${onlyDef.length}): ${onlyDef.join(', ')}`)
  failed = true
}

// ---- 动态工具集契约（2026-09-18）：常驻 ≤ MAX_ALWAYS_ON_TOOLS，且 tool_search 必须常驻 ----
const on = alwaysOnToolDefs()
console.log('')
console.log('=== 动态工具集契约 ===')
console.log(`常驻注入 ${on.length} 个（上限 ${MAX_ALWAYS_ON_TOOLS}）: ${on.map((t) => t.name).join(', ')}`)
const contract = validateAlwaysOnContract()
if (contract.ok) {
  console.log(`✅ 契约满足：常驻 ${on.length}/${MAX_ALWAYS_ON_TOOLS}，tool_search 常驻`)
} else {
  for (const e of contract.errors) console.log(`❌ ${e}`)
  failed = true
}

process.exit(failed ? 1 : 0)
