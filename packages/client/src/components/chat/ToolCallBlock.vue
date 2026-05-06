<template>
  <div class="tool-call-block" :class="{ completed: status === 'done' }">
    <div class="tool-header">
      <span class="tool-icon">
        <template v-if="status === 'running'">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </template>
        <template v-else>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </template>
      </span>
      <span class="tool-name">{{ toolName }}</span>
      <n-tag size="tiny" :bordered="false" :type="status === 'running' ? 'warning' : 'success'">
        {{ status === 'running' ? '执行中' : '完成' }}
      </n-tag>
    </div>

    <div class="tool-body" v-if="argsDisplay">
      <div class="tool-section">
        <span class="tool-section-label">参数</span>
        <code class="tool-code">{{ argsDisplay }}</code>
      </div>
    </div>

    <div class="tool-body" v-if="resultDisplay && status === 'done'">
      <div class="tool-section">
        <span class="tool-section-label">结果</span>
        <div class="tool-result">{{ resultDisplay }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  toolName: string
  args?: string
  result?: string
  status: 'running' | 'done'
}>()

const toolLabels: Record<string, string> = {
  web_search: '🔍 搜索网页',
  web_fetch: '📄 获取网页',
  memory_store: '💾 存储记忆',
  memory_recall: '🧠 召回记忆',
  memory_list: '📋 列出记忆',
  file_read: '📖 读取文件',
  file_write: '✏️ 写入文件',
  file_exists: '🔎 检查文件',
  shell_exec: '⚡ 执行命令',
}

const toolName = computed(() => toolLabels[props.toolName] || `🔧 ${props.toolName}`)

const argsDisplay = computed(() => {
  if (!props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    // 简化展示
    const simple: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 80) {
        simple[k] = v.slice(0, 80) + '...'
      } else {
        simple[k] = String(v)
      }
    }
    return JSON.stringify(simple, null, 2)
  } catch {
    return props.args.slice(0, 200)
  }
})

const resultDisplay = computed(() => {
  if (!props.result) return ''
  return props.result.slice(0, 300)
})
</script>

<style scoped>
.tool-call-block {
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
  font-size: 12px;
}

.tool-call-block.completed {
  opacity: 0.85;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-primary);
  font-weight: 500;
}

.tool-icon {
  color: var(--accent);
  display: flex;
}

.spin {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
}

.tool-body {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
}

.tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-section + .tool-section {
  margin-top: 6px;
}

.tool-section-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tool-code {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 11px;
  background: var(--bg-primary);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}

.tool-result {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
