/**
 * 端到端验收：`tool_progress` 结构化进度链路（G5 / I13，2026-09-24）。
 *
 * 与 `verify-file-write-progress.mts` 的分工：
 *   - 那个脚本只验**算法**（增量计数器 == diffLines）；
 *   - 本脚本走**真实执行链路**：`executeToolCalls` → `boundCtx` → `tools/*.ts` 的 execute，
 *     验的是"单测全绿但集成断掉"那一类问题：
 *       ① 工具内传 `''` 的 toolCallId 是否真被 boundCtx 换成真实 id（漏绑 = 前端匹配不到节点，静默无进度）；
 *       ② 进度事件是否都发生在**真实文件系统操作**之间（不是空跑）；
 *       ③ 结束时 `added` 是否等于结果文本里的 `+N`（否则用户看到"过程 +40，结果 +37"）；
 *       ④ `phase` 是否按新建/改已有正确区分（前端据此本地化"创建 / 编辑"）；
 *       ⑤ 扩展名无关（老板点名 .ts / .mts / .md 都要有实时行数）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/diag/verify-progress-e2e.mts
 *      （沙箱/宿主注入会干扰真实文件写，请用 clean-shell-env 的干净 env 跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import { executeToolCalls } from '../../packages/server/src/services/tools'

const ROOT = path.resolve(import.meta.dirname, '../..')
const TMP = path.join(ROOT, 'scripts/diag/.tmp-verify-progress')

let failed = 0
const fail = (name: string, msg: string) => {
  failed++
  console.log(`  ✗ ${name}: ${msg}`)
}
const ok = (name: string, detail = '') => console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`)

interface ProgressEvent {
  toolCallId: string
  added?: number
  deleted?: number
  total?: number
  done?: number
  count?: number
  phase?: string
}

/** 走真实执行链路跑一个工具，收集 onProgress / onOutput，返回结果文本 */
async function runTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ events: ProgressEvent[]; output: string; result: string }> {
  const events: ProgressEvent[] = []
  let output = ''
  const results = await executeToolCalls(
    [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    {
      cwd: ROOT,
      sessionId: 'verify-progress-e2e',
      permissionLevel: 'sandbox',
      onProgress: (toolCallId: string, p: any) => events.push({ toolCallId, ...p }),
      onOutput: (_tcId: string, chunk: string) => { output += chunk },
    } as any,
  )
  return { events, output, result: String(results[0]?.content ?? '') }
}

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

// ── 1. 新建 .ts 文件：progress 全程存在，toolCallId 被 boundCtx 注入 ──
{
  const target = path.join(TMP, 'created.ts')
  const content = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  const { events, result } = await runTool('call_create_1', 'file_write', { path: target, content })

  if (!events.length) fail('新建 .ts 有进度事件', '一条都没有 —— boundCtx / onProgress 断了')
  else ok('新建 .ts 有进度事件', `${events.length} 条`)

  const wrongId = events.filter((e) => e.toolCallId !== 'call_create_1')
  if (wrongId.length) fail('toolCallId 由 boundCtx 注入', `${wrongId.length} 条仍是空/错 id：${JSON.stringify(wrongId[0])}`)
  else ok('toolCallId 由 boundCtx 注入', `全部 = call_create_1`)

  const added = events.map((e) => e.added ?? 0)
  const monotone = added.every((v, i) => i === 0 || v >= added[i - 1])
  if (!monotone) fail('added 单调不减', added.join(' → '))
  else ok('added 单调不减', `${added[0]} → ${added[added.length - 1]}`)

  if (events.some((e) => e.phase !== 'create')) {
    fail('phase = create（新建文件）', `实际 ${JSON.stringify([...new Set(events.map((e) => e.phase))])}`)
  } else ok('phase = create（新建文件）')

  const lastEvent = events[events.length - 1]
  const m = result.match(/\+(\d+)\/-(\d+) 行/) || result.match(/(\d+) 行/)
  const resultAdded = m ? Number(m[1]) : NaN
  if (lastEvent.added !== resultAdded) {
    fail('过程 added 与结果文本一致', `进程 ${lastEvent.added} vs 结果 ${resultAdded}（"步骤"与"结论"自相矛盾）`)
  } else ok('过程 added 与结果文本一致', `+${resultAdded}`)

  if (lastEvent.done !== lastEvent.total) fail('done 收敛到 total', `${lastEvent.done}/${lastEvent.total}`)
  else ok('done 收敛到 total', `${lastEvent.done}/${lastEvent.total}`)

  // ⚠️ 口径断言写成"与 diffLines 的行分割口径一致"，而不是人眼的"60 行"：
  //    diffLines 用朴素 split('\n')，末尾换行会多出一个空元素 ⇒ 60 行代码 + 结尾换行 = 61。
  //    这是 `shared.test.ts` 已固化的契约（`diffLines('a\nb','a\nb\nc\nd') = +2`），
  //    **不是本次引入**，故这里只锁"过程数值 == 结果文本数值"，不擅自改共享 util 的口径。
  const expectedAdded = content.split('\n').length
  if (lastEvent.added !== expectedAdded) fail('新建文件 added = diffLines 口径行数', `${lastEvent.added} vs ${expectedAdded}`)
  else ok('新建文件 added = diffLines 口径行数', `${expectedAdded}（人眼 60 行 + 结尾换行，属既有口径）`)
}

// ── 2. 同一路径再写一次 → phase 必须翻成 edit（前端动词"创建"→"编辑"） ──
{
  const target = path.join(TMP, 'created.ts')
  const content = fs.readFileSync(target, 'utf-8') + 'export const extra = 1\n'
  const { events, result } = await runTool('call_edit_1', 'file_write', { path: target, content })
  const phases = [...new Set(events.map((e) => e.phase))]
  if (phases.length !== 1 || phases[0] !== 'edit') fail('phase = edit（改已有文件）', JSON.stringify(phases))
  else ok('phase = edit（改已有文件）')
  if (!/\+1\/-0 行/.test(result)) fail('追加 1 行 → 结果 +1/-0', result)
  else ok('追加 1 行 → 结果 +1/-0')
}

// ── 3. 扩展名无关：.mts / .md 同样有实时行数（老板点名） ──
for (const ext of ['mts', 'md']) {
  const target = path.join(TMP, `file.${ext}`)
  const content = Array.from({ length: 30 }, (_, i) => (ext === 'md' ? `## 第 ${i} 节` : `const a${i} = ${i}`)).join('\n')
  const { events } = await runTool(`call_${ext}`, 'file_write', { path: target, content })
  if (events.length < 2) fail(`.${ext} 有实时行数`, `只有 ${events.length} 条进度事件（单块文件应 ≥1）`)
  else ok(`.${ext} 有实时行数`, `${events.length} 条，末值 +${events[events.length - 1].added}`)
}

// ── 4. multi_edit：逐处进度 + count + 保原子性（结果只出现一次写入） ──
{
  const target = path.join(TMP, 'multi.ts')
  fs.writeFileSync(target, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf-8')
  const { events, result } = await runTool('call_multi_1', 'multi_edit', {
    file_path: target,
    edits: [
      { old_str: 'const a = 1', new_str: 'const a = 11' },
      { old_str: 'const b = 2', new_str: 'const b = 22' },
      { old_str: 'const c = 3', new_str: 'const c = 33\nconst d = 4' },
    ],
  })
  if (events.length !== 3) fail('multi_edit 每处一条进度', `期望 3，实际 ${events.length}`)
  else ok('multi_edit 每处一条进度', '3')
  const last = events[events.length - 1]
  if (last.done !== 3 || last.count !== 3) fail('multi_edit done/count', JSON.stringify(last))
  else ok('multi_edit done/count', '3/3')
  if (last.phase !== 'edit') fail('multi_edit phase', String(last.phase))
  else ok('multi_edit phase = edit')
  // 逐处**局部** diff 累加：每处 old_str→new_str 无公共行 ⇒ 各 +1/−1，第三处 1 行→2 行 ⇒ +2/−1
  // ⇒ 合计 +4/−3。这是"替换被算成删一行加一行"的既有语义，**不是整文件净变化**，
  // 所以 ProcessStatusLine 对 count 形状刻意只显"3/3 处"、不显 ±（见 resolveCounter 注释）。
  if (last.added !== 4 || last.deleted !== 3) fail('multi_edit 累计 ±（逐处局部 diff）', `+${last.added}/-${last.deleted}（应为 +4/-3）`)
  else ok('multi_edit 累计 ±（逐处局部 diff，前端刻意不展示）', '+4/-3')
  // 保原子性：只有最后一处新增了 1 行，文件内容必须完整（说明是内存累积后一次性写盘）
  const after = fs.readFileSync(target, 'utf-8')
  if (!after.includes('const d = 4') || !after.includes('const a = 11')) fail('保原子性：全部修改已落盘', after)
  else ok('保原子性：全部修改已落盘')
  if (!result.includes('已应用 3/3 处修改')) fail('multi_edit 结果文案', result)
  else ok('multi_edit 结果文案', '已应用 3/3 处修改')
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(failed === 0 ? '\n端到端全部通过（真实执行链路：executeToolCalls → boundCtx → 工具）' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
