<template>
  <div class="file-op-renderer">
    <!-- Arguments -->
    <div v-if="formattedArgs.length > 0" class="tool-section">
      <span class="tool-section-label">{{ $t('chat.toolParams') }}</span>
      <div class="tool-params">
        <div v-for="(arg, idx) in formattedArgs" :key="idx" class="tool-param-row">
          <code class="param-key">{{ arg.key }}</code>
          <code class="param-value">{{ arg.value }}</code>
        </div>
      </div>
    </div>

    <!-- 写文件 diff（对齐 WorkBuddy WriteFileRenderer：完成态展示改前/改后） -->
    <div v-if="fileDiff && status === 'done'" class="tool-section">
      <span class="tool-section-label">{{ $t('chat.diffTitle') }}</span>
      <FileDiffViewer :diff="fileDiff" />
    </div>
    <!-- 多文件编辑（WorkBuddy MultiEditDiffViewer 同款：N 处修改 + 接受/拒绝） -->
    <div v-if="isMultiEdit && multiEdits.length && status === 'done'" class="tool-section">
      <MultiEditDiffViewer :edits="multiEdits" @accept="emit('accept')" @reject="emit('reject')" />
    </div>
    <!-- Result -->
    <!-- 写文件代码视图（ChatGPT CodeDiff 同款：执行中代码逐行"长出来"+自动吸底；完成后保留完整代码，限高滚动——老板 2026-08-21：展开要看得到写了什么） -->
    <div v-if="streamOutput && (status === 'running' || status === 'stream_executing' || status === 'done')" class="tool-section tool-stream">
      <template v-if="isFileWrite">
        <div v-if="status === 'done'" class="tool-section-label">{{ $t('chat.toolWrittenCode') }}</div>
        <div ref="streamCodeEl" class="stream-code">
          <div v-for="(line, i) in streamCodeLines" :key="i" class="stream-code-line">
            <span class="stream-code-ln">{{ i + 1 }}</span>
            <code class="stream-code-text">{{ line }}</code>
          </div>
        </div>
        <div v-if="streamTruncated" class="stream-truncated-hint">{{ $t('chat.toolCodeTruncated', { n: MAX_RENDER_LINES }) }}</div>
      </template>
      <pre v-else class="stream-pre">{{ streamOutput }}</pre>
    </div>
    <div v-if="resultDisplay && status === 'done'" class="tool-section">
      <span class="tool-section-label">{{ $t('chat.toolResult') }}</span>
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
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import FileDiffViewer from '@/components/chat/FileDiffViewer.vue'
import MultiEditDiffViewer from '@/components/chat/MultiEditDiffViewer.vue'
import { isWriteFileTool } from '@/components/chat/renderers/tool-renderer-registry'

/**
 * 通用工具渲染器（Arguments + diff + 多文件编辑 + 流式代码视图 + 结果 + 错误）。
 * 由 ToolCallBlock 外壳按 rendererKey 分发；读/写文件语义（动词推导、行数统计）留在外壳。
 */
const props = withDefaults(defineProps<{
  toolName: string
  args?: string
  result?: string
  status?: string
  streamOutput?: string
  fileDiff?: { path: string; oldContent: string; newContent: string } | null
}>(), { args: '', result: '', status: 'done', streamOutput: '', fileDiff: null })

const emit = defineEmits<{ (e: 'accept'): void; (e: 'reject'): void }>()

const resultExpanded = ref(false)

const isFileWrite = computed(() => isWriteFileTool(props.toolName))
const isMultiEdit = computed(() => props.toolName === 'multi_edit')

const resultDisplay = computed(() => !!(props.result || '').trim())

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

/** 从 args 提取 edits 数组（{old_str, new_str} 列表） */
const multiEdits = computed(() => {
  if (!props.args) return []
  try {
    const obj = JSON.parse(props.args)
    if (Array.isArray(obj.edits)) return obj.edits
  } catch {}
  return []
})

/** 写文件流式区：从 streamOutput 提取代码内容（后端每块推送 `📝 写入 N/M 行\n```\n代码...\n````），按行渲染 */
/** 结果渲染行数上限（WorkBuddy MAX_RENDER_LINES=500 同款：超长文件截断显示 + 总行数提示） */
const MAX_RENDER_LINES = 500
const streamCodeLines = computed<string[]>(() => {
  if (!props.streamOutput) return []
  const out: string[] = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(props.streamOutput))) {
    const body = m[1].replace(/\n$/, '')
    for (const line of body.split('\n')) out.push(line)
  }
  return out.slice(0, MAX_RENDER_LINES)
})
/** 是否截断（超 500 行） */
const streamTruncated = computed(() => streamCodeLines.value.length >= MAX_RENDER_LINES)

/** 自动吸底：代码逐行滚出时跟随到底部（ChatGPT 同款） */
const streamCodeEl = ref<HTMLElement | null>(null)
watch(streamCodeLines, async () => {
  if (!streamCodeEl.value) return
  await nextTick()
  streamCodeEl.value.scrollTop = streamCodeEl.value.scrollHeight
})

// Result handling
const fullResult = computed(() => props.result || '')
const truncatedResult = computed(() => (props.result || '').slice(0, 400))
const isResultLong = computed(() => (props.result || '').length > 400)
</script>

<style scoped>
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

/* 写文件流式区：行号代码视图（ChatGPT CodeDiff 同款——代码逐行"长出来"，自动吸底） */
.stream-truncated-hint {
  padding: 4px 8px 6px;
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  background: var(--bg-secondary);
  border-radius: 0 0 6px 6px;
  border-top: 1px solid var(--border-color);
}
.stream-code {
  max-height: 260px;
  overflow-y: auto;
  border-radius: 6px;
  background: var(--code-bg, rgba(15, 20, 30, 0.9));
  padding: 8px 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.55;
}
.stream-code-line {
  display: flex;
  padding: 0 10px;
}
.stream-code-line:hover {
  background: rgba(128, 128, 128, 0.08);
}
.stream-code-ln {
  flex-shrink: 0;
  width: 40px;
  text-align: right;
  padding-right: 12px;
  color: var(--text-muted, #8b93a7);
  opacity: 0.6;
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.stream-code-text {
  white-space: pre;
  color: var(--text-primary, #e2e8f0);
}
.stream-code::-webkit-scrollbar {
  width: 6px;
}
.stream-code::-webkit-scrollbar-thumb {
  background: var(--border-color, #334155);
  border-radius: 3px;
}
.stream-pre {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--code-bg, rgba(15, 20, 30, 0.9));
  padding: 8px;
  border-radius: 6px;
  max-height: 260px;
  overflow-y: auto;
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
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 60px;
}
.param-value {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 3px;
  word-break: break-all;
}

.tool-result {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-primary);
  padding: 8px;
  border-radius: var(--radius-xs, 6px);
  max-height: 200px;
  overflow-y: auto;
}
.tool-error .tool-result {
  background: var(--error-muted, rgba(239, 68, 68, 0.08));
  color: var(--error, #ef4444);
}
.tool-result-expand {
  font-size: var(--text-xs, 12px);
  color: var(--accent, #6366f1);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 0;
  text-align: left;
}
.tool-result-expand:hover {
  text-decoration: underline;
}
</style>
