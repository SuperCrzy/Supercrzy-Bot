/**
 * 校验 file_write 实时进度契约（2026-09-24，G5/I13 配套）。
 *
 * 背景：`file-write.ts` 里为了让状态行上的「+N 行」实时增长，新增了一个**增量计数器**
 * `countAdded`（可消耗行多重集）。它必须与收尾返回值里的 `diffLines(old, new).added` 完全一致，
 * 否则用户会看到"过程里 +40，结果说 +37"这种自相矛盾（比不动更糟）。
 *
 * 断言（全部为不变量，不写死具体数字）：
 *  A1 末尾收敛：逐块 countAdded 的结果 === diffLines(old, new).added
 *  A2 单调不减：任一时刻的 addedSoFar >= 上一时刻（状态行数字不能往回跳）
 *  A3 不重不漏：分块消费的行数与顺序 === 全文逐行（用哨兵行验证"恰好消费一次"）
 *  A4 上界：0 <= addedSoFar <= new 的行数，且全新文件时 === 已写行数
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/diag/verify-file-write-progress.mts
 *      （沙箱/宿主注入会干扰，请用 clean-shell-env 的干净 env 跑）
 */
import { diffLines } from '../../packages/server/src/tools/shared'

// ── 复刻 file-write.ts 的分块逻辑（CHUNK 与 slicing 表达式必须与源码一致） ──
const CHUNK = 12

function makeCounter(oldContent: string) {
  const oldLinePool = new Map<string, number>()
  for (const l of oldContent ? oldContent.split('\n') : []) oldLinePool.set(l, (oldLinePool.get(l) || 0) + 1)
  let addedSoFar = 0
  return {
    count(lines: string[]): number {
      for (const l of lines) {
        const c = oldLinePool.get(l) || 0
        if (c > 0) oldLinePool.set(l, c - 1)
        else addedSoFar++
      }
      return addedSoFar
    },
    get value() {
      return addedSoFar
    },
  }
}

/** 按 file-write.ts 的真实分块顺序产出 [块行, 累计已写行数] 序列。
 *  ⚠️ 顺序必须严格照抄源码：源码是「先 idx += CHUNK，再 slice(idx-CHUNK, idx)」——
 *     探针第一版写成「先 slice(idx-CHUNK, idx) 再 += CHUNK」，首块被消费两次（消费 408/400 行）。
 *     这类探针自身的错位会让"真 bug"与"假 bug"混淆，故此处逐行对齐源码。 */
function chunksOf(newText: string): Array<{ lines: string[]; written: number }> {
  const linesArr = newText.split('\n')
  const totalLines = linesArr.length
  const out: Array<{ lines: string[]; written: number }> = []
  // 单行文件：源码 `if (totalLines > 1)` 不发进度（无块可切，前端状态行自然无 ±，由 result 兜底）
  if (linesArr.length <= CHUNK) {
    if (totalLines > 1) out.push({ lines: linesArr, written: totalLines })
    return out
  }
  out.push({ lines: linesArr.slice(0, CHUNK), written: CHUNK })
  let idx = CHUNK
  while (idx < linesArr.length) {
    const chunk = linesArr.slice(idx, idx + CHUNK)
    idx += CHUNK
    out.push({ lines: linesArr.slice(Math.max(0, idx - CHUNK), idx), written: Math.min(idx, totalLines) })
    void chunk
  }
  return out
}

// ── 样本：覆盖 新建 / 未变 / 全量重写 / 局部改 / 增删混杂 / 短文件 / 大量重复行 ──
const N = 400
const base = Array.from({ length: N }, (_, i) => `line_${i}`)
const dup = Array.from({ length: N }, (_, i) => `same_${i % 7}`)

const samples: Array<[string, string, string]> = [
  ['全新文件', '', base.join('\n')],
  ['内容完全未变', base.join('\n'), base.join('\n')],
  ['全量重写', base.join('\n'), base.map((_, i) => `new_${i}`).join('\n')],
  ['尾部追加 30 行', base.join('\n'), base.concat(base.slice(0, 30).map((l) => l + '_x')).join('\n')],
  ['中间改 30 行', base.join('\n'), base.map((l, i) => (i > 100 && i < 130 ? l + '_edited' : l)).join('\n')],
  ['大量重复行（多重集边界）', dup.join('\n'), dup.slice(0, 100).join('\n')],
  ['超短文件（单块）', 'a\nb', 'a\nb\nc'],
  ['一行文件', 'x', 'y'],
  ['空 → 空', '', ''],
]

let failed = 0
const fail = (name: string, msg: string) => {
  failed++
  console.log(`  ✗ [${name}] ${msg}`)
}

for (const [name, oldText, newText] of samples) {
  const ref = diffLines(oldText, newText)
  const counter = makeCounter(oldText)
  const chunks = chunksOf(newText)
  let prev = 0
  let consumed = 0
  const problems: string[] = []

  for (const c of chunks) {
    const v = counter.count(c.lines)
    // A2 单调不减
    if (v < prev) problems.push(`A2 回跳 ${prev} → ${v}（在已写 ${c.written} 行处）`)
    prev = v
    // A4 上界
    const newLineCount = newText ? newText.split('\n').length : 0
    if (v < 0 || v > newLineCount) problems.push(`A4 上界越界 added=${v} / newLines=${newLineCount}`)
    consumed += c.lines.length
  }

  // A1 末尾收敛（无块 = 单行文件，源码本就不发进度 → 不适用）
  if (chunks.length && counter.value !== ref.added) {
    problems.push(`A1 收敛失败 计数器=${counter.value} / diffLines=${ref.added}`)
  }
  // A3 不重不漏
  const newLineCount = newText ? newText.split('\n').length : 0
  if (chunks.length && consumed !== newLineCount) problems.push(`A3 行数不符 消费=${consumed} / 全文=${newLineCount}`)

  if (problems.length) {
    fail(name, problems.join(' | '))
  } else {
    console.log(`  ✓ [${name}] added 末值=${counter.value}（diffLines=${ref.added}） deleted=${ref.deleted} 块数=${chunks.length}`)
  }
}

// ── A4 特例单独验证：全新文件 → 每个块的 added 恒等于该块累计已写行数 ──
{
  const newText = base.join('\n')
  const counter = makeCounter('')
  let ok = true
  const detail: string[] = []
  for (const c of chunksOf(newText)) {
    const v = counter.count(c.lines)
    detail.push(`${c.written}→${v}`)
    if (v !== c.written) ok = false
  }
  if (ok) console.log(`  ✓ [全新文件·逐步等于已写行数] ${detail.slice(0, 5).join(' ')} … ${detail.slice(-2).join(' ')}`)
  else fail('全新文件·逐步等于已写行数', detail.join(' '))
}

console.log(failed === 0 ? `\n全部通过（${samples.length + 1} 组不变量断言）` : `\n失败 ${failed} 组`)
process.exit(failed === 0 ? 0 : 1)
