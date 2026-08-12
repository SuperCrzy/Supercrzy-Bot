<template>
  <div class="tool-call-block" :class="[status, `cat-${category}`, { 'just-completed': justCompleted, 'just-errored': justErrored }]">
    <!-- 确认拦截面板 (pending状态) -->
    <div v-if="status === 'pending' && isSensitive" class="confirm-panel">
      <div class="confirm-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <div class="confirm-title">{{ $t('chatui.confirmTitle') }}</div>
          <div class="confirm-desc">{{ sensitiveDesc }}</div>
        </div>
      </div>
      <div class="confirm-args" v-if="formattedArgs.length">
        <code v-for="(a,i) in formattedArgs.slice(0,3)" :key="i">{{ a.key }}: {{ a.value }}</code>
      </div>
      <div class="confirm-actions">
        <button class="confirm-deny" @click.stop="$emit('deny')">{{ $t('chatui.deny') }}</button>
        <button class="confirm-allow" @click.stop="$emit('allow')">{{ $t('chatui.allow') }}</button>
      </div>
    </div>

    <!-- Header -->
    <div class="tool-header" @click="toggle">
      <span class="tool-status-indicator">
        <svg v-if="status === 'running'" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <svg v-else-if="status === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </span>
      <code class="tool-name">{{ toolName }}</code>
      <span class="tool-category-tag">{{ categoryLabel }}</span>
      <span v-if="duration" class="tool-duration">{{ duration }}s</span>
      <span class="tool-expand-toggle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </div>

    <!-- Body -->
    <div class="tool-body" v-if="expanded">
      <!-- Arguments -->
      <div v-if="formattedArgs.length > 0" class="tool-section">
        <span class="tool-section-label">Parameters</span>
        <div class="tool-params">
          <div v-for="(arg, idx) in formattedArgs" :key="idx" class="tool-param-row">
            <code class="param-key">{{ arg.key }}</code>
            <code class="param-value">{{ arg.value }}</code>
          </div>
        </div>
      </div>

      <!-- Result -->
      <div v-if="resultDisplay && status === 'done'" class="tool-section">
        <span class="tool-section-label">Result</span>
        <div class="tool-result">
          <template v-if="resultExpanded">{{ fullResult }}</template>
          <template v-else>{{ truncatedResult }}</template>
        </div>
        <button v-if="isResultLong" class="tool-result-expand" @click.stop="resultExpanded = !resultExpanded">
          {{ resultExpanded ? 'Collapse' : `Show more (${fullResult?.length || 0} chars)` }}
        </button>
      </div>

      <!-- Error -->
      <div v-if="status === 'error'" class="tool-section tool-error">
        <span class="tool-section-label">Error</span>
        <div class="tool-result">{{ result }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = withDefaults(defineProps<{
  toolName: string
  args?: string
  result?: string
  status: 'running' | 'done' | 'error' | 'pending'
  duration?: number
}>(), {
  args: '',
  result: '',
  duration: undefined,
})

const emit = defineEmits<{
  (e: 'allow'): void
  (e: 'deny'): void
}>()

const expanded = ref(props.status === 'running' || props.status === 'pending')
const resultExpanded = ref(false)

// 是否有可展示的结果
const resultDisplay = computed(() => !!(props.result || '').trim())

// 状态过渡动画 + 自动展开/折叠
const justCompleted = ref(false)
const justErrored = ref(false)

watch(() => props.status, (newStatus, oldStatus) => {
  if (newStatus === 'running' || newStatus === 'pending') {
    expanded.value = true  // 执行中 → 展开
  }
  if (newStatus === 'done' && oldStatus === 'running') {
    justCompleted.value = true
    setTimeout(() => { justCompleted.value = false }, 700)
    setTimeout(() => { expanded.value = false }, 1200)  // 完成后折叠
  }
  if (newStatus === 'error' && oldStatus === 'running') {
    justErrored.value = true
    expanded.value = true  // 错误保持展开
    setTimeout(() => { justErrored.value = false }, 700)
  }
})

// 敏感操作列表 — 需要用户确认
const SENSITIVE_TOOLS = new Set(['shell_exec', 'file_write', 'file_delete'])
const isSensitive = computed(() => SENSITIVE_TOOLS.has(props.toolName))
const sensitiveDesc = computed(() => {
  const map: Record<string, string> = {
    shell_exec: t('chatui.toolDescShell'),
    file_write: t('chatui.toolDescFileWrite'),
    file_delete: t('chatui.toolDescFileDelete'),
  }
  return map[props.toolName] || t('chatui.toolDescSensitive')
})

// Tool category mapping
const categoryMap: Record<string, { label: string; cat: string }> = {
  web_search: { label: 'Network', cat: 'network' },
  web_fetch: { label: 'Network', cat: 'network' },
  memory_store: { label: 'Memory', cat: 'memory' },
  memory_recall: { label: 'Memory', cat: 'memory' },
  memory_list: { label: 'Memory', cat: 'memory' },
  file_read: { label: 'File', cat: 'file' },
  file_write: { label: 'File', cat: 'file' },
  file_exists: { label: 'File', cat: 'file' },
  shell_exec: { label: 'System', cat: 'system' },
}

const category = computed(() => categoryMap[props.toolName]?.cat || 'system')
const categoryLabel = computed(() => categoryMap[props.toolName]?.label || 'System')

// Format arguments as key-value pairs
const formattedArgs = computed(() => {
  if (!props.args) return []
  try {
    const obj = JSON.parse(props.args)
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: typeof value === 'string' && value.length > 120
        ? value.slice(0, 120) + '...'
        : String(value),
    }))
  } catch {
    return [{ key: 'raw', value: props.args.slice(0, 200) }]
  }
})

// Result handling
const fullResult = computed(() => props.result || '')
const truncatedResult = computed(() => (props.result || '').slice(0, 400))
const isResultLong = computed(() => (props.result || '').length > 400)

function toggle() {
  if (props.args || props.result) {
    expanded.value = !expanded.value
  }
}
</script>

<style scoped>
.tool-call-block {
  margin: 3px 0;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
  font-size: var(--text-sm);
  transition: border-color var(--duration-fast) var(--ease-out);
}

.tool-call-block.running { border-left-color: var(--accent); }
.tool-call-block.done { border-left-color: var(--success); opacity: 0.85; }
.tool-call-block.error { border-left-color: var(--error); }
.tool-call-block.pending { border-left-color: var(--warning); }

/* 状态过渡动画 */
.tool-call-block.just-completed {
  animation: pulse-done 0.6s ease-out;
}

@keyframes pulse-done {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.5); border-color: var(--success); }
  50%  { box-shadow: 0 0 0 6px rgba(34,197,94,0.18); border-color: var(--success); }
  100% { box-shadow: 0 0 0 0 transparent; border-color: var(--border-color); }
}

.tool-call-block.just-errored {
  animation: pulse-error 0.6s ease-out;
}

@keyframes pulse-error {
  0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); border-color: var(--error); }
  50%  { box-shadow: 0 0 0 6px rgba(239,68,68,0.18); border-color: var(--error); }
  100% { box-shadow: 0 0 0 0 transparent; border-color: var(--border-color); }
}

/* Category color accents — subtle, not competing with status */
.tool-call-block.cat-memory { border-left-color: #8b5cf6; }
.tool-call-block.cat-file { border-left-color: #2563eb; }
.tool-call-block.cat-network { border-left-color: #059669; }
.tool-call-block.cat-system { border-left-color: #64748b; }
.tool-call-block.running.cat-memory,
.tool-call-block.running.cat-file,
.tool-call-block.running.cat-network,
.tool-call-block.running.cat-system { border-left-color: var(--accent); }

/* Header */
.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}

.tool-status-indicator {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.tool-call-block.running .tool-status-indicator {
  color: var(--warning);
}

.tool-call-block.done .tool-status-indicator {
  color: var(--success);
}

.tool-call-block.error .tool-status-indicator {
  color: var(--error);
}

.spin {
  animation: spin 1.5s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-name {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  flex: 1;
  font-weight: 500;
}

.tool-category-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}

.cat-memory .tool-category-tag { background: rgba(139, 92, 246, 0.12); color: var(--cat-memory); }
.cat-file .tool-category-tag { background: rgba(37, 99, 235, 0.12); color: var(--cat-file); }
.cat-network .tool-category-tag { background: rgba(5, 150, 105, 0.12); color: var(--cat-network); }
.cat-system .tool-category-tag { background: rgba(100, 116, 139, 0.12); color: var(--cat-system); }

.dark .cat-memory .tool-category-tag { background: rgba(139, 92, 246, 0.2); }
.dark .cat-file .tool-category-tag { background: rgba(37, 99, 235, 0.2); }
.dark .cat-network .tool-category-tag { background: rgba(5, 150, 105, 0.2); }
.dark .cat-system .tool-category-tag { background: rgba(100, 116, 139, 0.2); }

.tool-duration {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.tool-expand-toggle {
  display: flex;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tool-expand-toggle svg {
  transition: transform var(--duration-fast) var(--ease-out);
}

.tool-expand-toggle svg.rotated {
  transform: rotate(180deg);
}

/* Body */
.tool-body {
  padding: 6px 10px;
  border-top: 1px solid var(--border-color);
}

.tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-section + .tool-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
}

.tool-section-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.tool-params {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tool-param-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
}

.param-key {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 60px;
}

.param-value {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 3px;
  word-break: break-all;
}

.tool-result {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-primary);
  padding: 8px;
  border-radius: var(--radius-xs);
  max-height: 200px;
  overflow-y: auto;
}

.tool-error .tool-result {
  background: var(--error-muted);
  color: var(--error);
}

.tool-result-expand {
  font-size: var(--text-xs);
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 0;
  text-align: left;
}

.tool-result-expand:hover {
  text-decoration: underline;
}

/* ===== Confirm Panel ===== */
.tool-call-block.pending {
  border-color: var(--warning);
}

.confirm-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-secondary);
}

.confirm-header {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.confirm-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

.confirm-args {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.confirm-args code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 3px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.confirm-deny,
.confirm-allow {
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: background var(--duration-fast);
}

.confirm-deny {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.confirm-deny:hover {
  background: var(--bg-hover);
}

.confirm-allow {
  background: var(--accent);
  color: white;
}

.confirm-allow:hover {
  filter: brightness(1.1);
}
</style>
