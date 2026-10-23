<template>
  <div class="file-diff-viewer">
    <div class="fdv-head">
      <span class="fdv-path">{{ diff.path }}</span>
      <!-- ± 行数统计徽标（主流实现 addedLines/removedLines 同款） -->
      <span v-if="addedCount || removedCount" class="fdv-stat">
        <span class="fdv-stat-add">+{{ addedCount }}</span>
        <span class="fdv-stat-del">−{{ removedCount }}</span>
      </span>
    </div>
    <!-- 新文件：只有新增内容，截断保护 -->
    <div v-if="isNewFile" class="fdv-body">
      <template v-for="(line, i) in displayNewLines" :key="'n' + i">
        <div class="fdv-line add"><span class="fdv-marker">+</span><span class="fdv-text">{{ line }}</span></div>
      </template>
      <div v-if="omittedNew > 0" class="fdv-omitted">{{ omittedText }}</div>
    </div>
    <!-- 修改：改前/改后逐行 diff（LCS）+ 行内字符级高亮（GPT CodeDiff 同款） -->
    <div v-else class="fdv-body">
      <template v-for="(row, i) in diffRows" :key="i">
        <div v-if="row.type === 'ctx'" class="fdv-line ctx"><span class="fdv-marker"> </span><span class="fdv-text">{{ row.old }}</span></div>
        <div v-else-if="row.type === 'del'" class="fdv-line del"><span class="fdv-marker">−</span><span class="fdv-text"><span v-for="(seg, si) in charDiff(row.old, row.new)" :key="'d' + si" :class="seg.kind === 'del' ? 'ch-del' : ''">{{ seg.text }}</span></span></div>
        <div v-else class="fdv-line add"><span class="fdv-marker">+</span><span class="fdv-text"><span v-for="(seg, si) in charDiff(row.new, row.old)" :key="'a' + si" :class="seg.kind === 'add' ? 'ch-add' : ''">{{ seg.text }}</span></span></div>
      </template>
      <div v-if="diffTruncated" class="fdv-omitted">{{ omittedText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  diff: { path: string; oldContent: string; newContent: string }
}>()

const { t } = useI18n({ useScope: 'global' })

/** 最大渲染行数（对齐主流实现 MAX_RENDER_LINES 截断保护） */
const MAX_LINES = 60

const isNewFile = computed(() => !props.diff.oldContent.trim())
const oldLines = computed(() => props.diff.oldContent.split('\n'))
const newLines = computed(() => props.diff.newContent.split('\n'))

/** 新文件：截断显示 */
const displayNewLines = computed(() => newLines.value.slice(0, MAX_LINES))
const omittedNew = computed(() => newLines.value.length - MAX_LINES)

/** 修改文件：行级 LCS diff（简化版：公共子序列判定上下文/删除/新增） */
const diffRows = computed(() => {
  const a = oldLines.value
  const b = newLines.value
  const n = a.length
  const m = b.length
  // DP 计算 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  // 回溯生成行序列
  const rows: Array<{ type: 'ctx' | 'del' | 'add'; old?: string; new?: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', old: a[i], new: b[j] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', old: a[i] })
      i++
    } else {
      rows.push({ type: 'add', new: b[j] })
      j++
    }
  }
  while (i < n) { rows.push({ type: 'del', old: a[i] }); i++ }
  while (j < m) { rows.push({ type: 'add', new: b[j] }); j++ }
  return rows
})

const diffTruncated = computed(() => diffRows.value.length > MAX_LINES)
const omittedText = computed(() => t('chat.diffOmitted', { n: omittedNew.value || diffRows.value.length - MAX_LINES }))
/** ± 行数统计（主流实现 addedLines/removedLines 同款） */
const addedCount = computed(() => diffRows.value.filter(r => r.type === 'add').length)
const removedCount = computed(() => diffRows.value.filter(r => r.type === 'del').length)

/**
 * 行内字符级 diff（GPT CodeDiff 行内高亮同款）：
 * 对修改行的 old/new 做字符级 LCS，返回分段 [{text, kind}]——
 * kind: 'common' 未变 / 'add' 新增（仅 new 侧高亮）/ 'del' 删除（仅 old 侧高亮）
 */
function charDiff(cur: string | undefined, other: string | undefined): Array<{ text: string; kind: 'common' | 'add' | 'del' }> {
  const a = cur || ''
  const b = other || ''
  if (!a || !b || a === b) return [{ text: a, kind: 'common' }]
  // 简单算法：逐字符找公共前缀/后缀，中间部分标记为差异
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const out: Array<{ text: string; kind: 'common' | 'add' | 'del' }> = []
  if (pre > 0) out.push({ text: a.slice(0, pre), kind: 'common' })
  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  if (aMid) out.push({ text: aMid, kind: 'del' })
  if (bMid) out.push({ text: bMid, kind: 'add' })
  if (suf > 0) out.push({ text: a.slice(a.length - suf), kind: 'common' })
  return out
}
</script>

<style scoped>
.file-diff-viewer {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
}
.fdv-path {
  padding: 4px 10px;
  background: var(--bg-secondary);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
  word-break: break-all;
}
.fdv-head { display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
.fdv-head .fdv-path { flex: 1; border-bottom: none; }
.fdv-stat { padding: 0 10px; display: flex; gap: 8px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.fdv-stat-add { color: var(--success, #3fb950); }
.fdv-stat-del { color: var(--error); }
.fdv-body {
  max-height: 260px;
  overflow-y: auto;
}
.fdv-line {
  display: flex;
  gap: 8px;
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.fdv-line.add {
  background: rgba(16, 185, 129, 0.08);
  color: var(--success, #059669);
}
.fdv-line.del {
  background: rgba(239, 68, 68, 0.08);
  color: var(--error);
  text-decoration: line-through;
  opacity: 0.8;
}
.fdv-line.ctx {
  color: var(--text-secondary);
}
.fdv-marker {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  user-select: none;
  opacity: 0.7;
}
.fdv-text {
  flex: 1;
  min-width: 0;
}
/* 行内字符级高亮（GPT CodeDiff 同款：差异片段加深） */
.ch-del {
  background: rgba(239, 68, 68, 0.22);
  border-radius: 2px;
}
.ch-add {
  background: rgba(16, 185, 129, 0.22);
  border-radius: 2px;
}
.fdv-omitted {
  padding: 4px 10px;
  color: var(--text-muted);
  font-size: 11px;
  border-top: 1px dashed var(--border-color);
}
</style>
