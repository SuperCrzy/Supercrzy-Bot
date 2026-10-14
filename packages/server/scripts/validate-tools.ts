/**
 * 工具注册一致性守卫（P1-03 低风险第一步）
 * 双写风险：toolExecutors(执行器) 与 toolDefinitions(schema) 分别维护，易漂移。
 * 本脚本在运行时真实 import 两者并比对名字集合，输出差异。
 * 用法: node node_modules/tsx/dist/cli.mjs scripts/validate-tools.ts
 */
import { readFileSync } from 'node:fs'
import { toolExecutors, toolDefinitions, DEFERRED_TOOLS, alwaysOnToolDefs, validateAlwaysOnContract, MAX_ALWAYS_ON_TOOLS, SENSITIVE_TOOLS } from '../src/services/tools'

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

// ---- 审批集合契约（I2，2026-09-24）：声明了 requiresApproval 就必须真的被拦 ----
//
// 修的是什么：此前"哪 4 个工具要审批"是 agent.ts 里手写的一个 Set，
// 和工具定义里的 requiresApproval 没有任何机械关联。后果是单向漏洞 ——
// computer_use / skill_install / multi_edit 声明了危险却根本不走审批。
//
// ⚠️ **不要在这里写"declared 集合 == SENSITIVE_TOOLS 集合"**。
// 因为 SENSITIVE_TOOLS 本身就是 `toolDefinitions.filter(d => d.requiresApproval)` 派生的，
// 两边**按构造必然相等** —— 那个断言恒为真，永远抓不到任何东西。
// （2026-09-24 探针实测过：故意删掉 multi_edit 的声明，该断言照样 ✅ —— 这是"恒真断言比没有测试更坏"
//  的教科书案例，所以下面查的是**真正会漂的两件事**：①关键工具是否还在集合里；②agent.ts 有没有
//  又长出一份平行的硬编码名单。）
console.log('')
console.log('=== 审批集合契约（I2）===')
const enforcedNames = [...SENSITIVE_TOOLS].sort()
console.log(`审批集合 SENSITIVE_TOOLS: ${SENSITIVE_TOOLS.size} 个 → ${enforcedNames.join(', ')}`)

// ① 关键高危工具必须在内：防止"整份名单被清空"这类改动悄悄通过
//    （声明与执行同时为空是自洽的，但那显然不对 —— 所以这里钉住必须在内的高危项）
const MUST_REQUIRE_APPROVAL = ['shell_exec', 'file_write', 'file_delete', 'memory_consolidate']
if (SENSITIVE_TOOLS.size === 0) {
  console.log('❌ 审批集合为空 —— 破坏性工具一个都没标，或派生逻辑失效')
  failed = true
} else {
  const missingCrit = MUST_REQUIRE_APPROVAL.filter((n) => !SENSITIVE_TOOLS.has(n))
  if (missingCrit.length) {
    console.log(`❌ 这些高危工具必须走审批却不在集合里: ${missingCrit.join(', ')}`)
    failed = true
  } else {
    console.log(`✅ 高危项全部在集合内: ${MUST_REQUIRE_APPROVAL.join(', ')}`)
  }
}

// ② agent.ts 不得再长出平行的硬编码名单 —— 这才是当初出漏洞的形态，也是唯一会复发的地方。
//    匹配的是 `SENSITIVE_TOOLS = new Set(` 这种**重新赋值**，而不是任何含工具名的字符串 ——
//    否则会命中 agent.ts 里**描述旧 bug 的注释**（那条注释正是为了提醒别再这么写，写完就红了。
//    2026-09-24 实测：基线因此误红 exit 1。教训与我们已有的"grep execSync 全命中注释"同源。）
const AGENT_SRC = readFileSync(new URL('../src/services/agent.ts', import.meta.url), 'utf8')
const inlineList = AGENT_SRC.match(/\bSENSITIVE_TOOLS\s*=\s*new\s+Set\(/)
if (inlineList) {
  console.log('❌ agent.ts 里又出现了内联的敏感工具名单（应一律从 services/tools 的 SENSITIVE_TOOLS 派生）:')
  console.log(`   ${inlineList[0]}`)
  failed = true
} else if (!/\bSENSITIVE_TOOLS\b/.test(AGENT_SRC)) {
  console.log('❌ agent.ts 没有引用 SENSITIVE_TOOLS —— 审批闸门可能已被摘掉')
  failed = true
} else {
  console.log('✅ agent.ts 只引用派生的 SENSITIVE_TOOLS，无平行名单')
}

console.log('')
console.log('=== 不存在双份声明（I2）===')
// 旧的 `dangerous` 字段已废弃；重新出现说明有人从旧代码复制粘贴了一份并行声明。
const legacy = toolDefinitions.filter((d: any) => 'dangerous' in d)
if (legacy.length) {
  console.log(`❌ 仍有工具在使用已废弃的 dangerous 字段（应改用 requiresApproval）: ${legacy.map((d) => d.name).join(', ')}`)
  failed = true
} else {
  console.log('✅ 全仓只有 requiresApproval 一个审批声明')
}

process.exit(failed ? 1 : 0)
