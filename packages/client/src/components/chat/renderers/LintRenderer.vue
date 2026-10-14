<template>
  <div class="lint-renderer">
    <!-- lint 展开态：诊断列表（主流实现 ReadLintsRenderer 同款） -->
    <div v-if="lintIssues.length" class="lint-list">
      <div v-for="(d, i) in lintIssues" :key="i" class="lint-item" :class="d.severity">
        <span class="lint-sev">{{ d.severity === 'error' ? 'E' : 'W' }}</span>
        <span class="lint-line">L{{ d.line }}</span>
        <span class="lint-msg">{{ d.message }}</span>
      </div>
    </div>
    <div v-else class="lint-clean">{{ $t('chatui.lintCleanDesc') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * lint 诊断渲染器（lint_file / read_lints 专属，主流实现 ReadLintsRenderer 同款）。
 * header（问题计数徽标）由 ToolCallBlock 外壳负责，这里只渲染诊断列表。
 */
const props = withDefaults(defineProps<{ result?: string }>(), { result: '' })

interface LintDiagnostic { severity: string; line: number; message: string }

const lintParsed = computed<{ diagnostics?: LintDiagnostic[] } | null>(() => {
  if (!props.result) return null
  try {
    return JSON.parse(props.result)
  } catch {
    return null
  }
})

const lintIssues = computed<LintDiagnostic[]>(
  () => (lintParsed.value && Array.isArray(lintParsed.value.diagnostics) ? lintParsed.value.diagnostics : []),
)
</script>

<style scoped>
.lint-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 260px;
  overflow-y: auto;
}
.lint-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 12px;
  background: var(--bg-secondary);
}
.lint-item.error { border-left: 2px solid var(--error, #ef4444); }
.lint-item.warning { border-left: 2px solid #f59e0b; }
.lint-sev {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--error, #ef4444);
}
.lint-item.warning .lint-sev { background: #f59e0b; }
.lint-line {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.lint-msg {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-word;
}
.lint-clean {
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px 0;
}
</style>
