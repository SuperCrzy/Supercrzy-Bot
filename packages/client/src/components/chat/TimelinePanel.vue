<template>
  <div class="timeline-panel">
    <!-- 搜索过滤（对齐 Harness TrajectoryTable 可搜索索引） -->
    <div class="tl-search">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        v-model="query"
        class="tl-search-input"
        :placeholder="$t('chatui.tlSearch')"
      />
    </div>

    <div v-if="filteredTurns.length === 0" class="tl-empty">{{ $t('chatui.timelineEmpty') }}</div>

    <!-- 轨迹回放：每条 assistant 消息 = 一轮 -->
    <div v-for="t in filteredTurns" :key="t.turn" class="tl-turn-card" :class="{ current: t.turn === latestTurn }">
      <div class="tl-turn-head" @click="toggleTurn(t.turn)">
        <svg class="tl-chevron" :class="{ open: isExpanded(t.turn) }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        <span class="tl-turn-no">{{ $t('detail.turn', { n: t.turn }) }}</span>
        <span class="tl-turn-summary">{{ t.summary }}</span>
        <span class="tl-turn-meta">
          <span v-if="t.tools.length" class="tl-toolcount">{{ t.tools.length }}</span>
          <button
            class="tl-jump"
            :title="$t('detail.jumpToMsg')"
            @click.stop="emit('focus-message', t.msgId)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
        </span>
      </div>

      <div v-show="isExpanded(t.turn)" class="tl-turn-body">
        <!-- 思考摘要 -->
        <div v-if="t.thinking" class="tl-reasoning">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><circle cx="12" cy="12" r="10"/></svg>
          <span>{{ t.thinking }}</span>
        </div>

        <!-- 工具轨迹 -->
        <div v-if="t.tools.length" class="tl-tools">
          <div
            v-for="(tool, ti) in t.tools"
            :key="'tool-' + ti"
            class="tl-tool"
            :class="tool.status"
          >
            <span class="tl-tool-name">{{ tool.name }}</span>
            <span class="tl-tool-status">{{ statusLabel(tool) }}</span>
            <span v-if="tool.duration" class="tl-tool-duration">{{ tool.duration }}s</span>
            <span v-if="tool.file" class="tl-tool-file">{{ tool.file }}</span>
          </div>
        </div>

        <!-- 产物 -->
        <div v-if="t.deliverables.length" class="tl-deliverables">
          <div
            v-for="(d, di) in t.deliverables"
            :key="'del-' + di"
            class="tl-deliverable"
            :class="d.kind"
            @click.stop="onDeliverableClick(d)"
          >
            <svg v-if="d.kind === 'diagram'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="tl-deliverable-name">{{ d.name }}</span>
          </div>
        </div>

        <!-- 每轮指标 -->
        <div v-if="t.metrics" class="tl-metrics">
          <span v-if="t.metrics.ttft" class="tl-metric">{{ $t('chatui.tlTtft') }} {{ t.metrics.ttft }}s</span>
          <span v-if="t.metrics.elapsed" class="tl-metric">{{ $t('chatui.tlElapsed') }} {{ t.metrics.elapsed }}</span>
        </div>
      </div>
    </div>

    <!-- 历史执行记录（checkpoint 续跑） -->
    <div class="tl-section-title">{{ $t('chatui.historyExec') }}</div>
    <div v-if="checkpoints.length" class="tl-history">
      <div
        v-for="c in checkpoints"
        :key="c.id"
        class="tl-history-item"
        :class="{ expanded: expandedId === c.id }"
        @click="toggleDetail(c)"
      >
        <div class="tl-history-head">
          <span class="tl-history-turn">{{ $t('chatui.turns', { n: c.turn }) }}</span>
          <span class="tl-history-time">{{ shortTime(c.timestamp) }}</span>
        </div>
        <div class="tl-history-msg">{{ c.firstUserMsg || $t('chatui.noUserMsg') }}</div>
        <div class="tl-history-meta">{{ $t('chatui.toolFileCount', { tools: c.toolCallCount, files: c.fileCount }) }}</div>
        <div v-if="expandedId === c.id" class="tl-history-detail">
          <button class="tl-resume" @click.stop="resumeFrom(c.id)">{{ $t('chatui.resume') }}</button>
        </div>
      </div>
    </div>
    <div v-else class="tl-empty">{{ $t('chatui.noHistory') }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useI18n } from 'vue-i18n'
import type { ChatFlowNode, ChatMessage } from '@/types'

// ---- 轨迹数据结构（对齐 Harness TrajectoryTable 每轮轨迹行）----
interface TrajTool {
  name: string
  status: string
  duration?: number
  file?: string
}
interface TrajDeliverable {
  kind: 'edit' | 'diagram'
  name: string
  path?: string
}
interface TrajTurn {
  turn: number
  msgId: string
  summary: string
  thinking: string
  tools: TrajTool[]
  deliverables: TrajDeliverable[]
  metrics?: { ttft?: number; elapsed?: string }
}
interface CheckpointMeta {
  id: string
  turn: number
  timestamp: string
  fileCount: number
  toolCallCount: number
  firstUserMsg: string
}

const { t: i18n } = useI18n({ useScope: 'global' })
const props = defineProps<{ messages: ChatMessage[] }>()
const emit = defineEmits<{
  (e: 'preview-file', path: string): void
  (e: 'focus-message', id: string): void
}>()

const chatStore = useChatStore()
const checkpoints = ref<CheckpointMeta[]>([])
const expandedId = ref('')
const query = ref('')
const expandedTurns = ref<Set<number>>(new Set())

const FILE_PRODUCER_TOOLS = new Set(['file_write', 'multi_edit'])

function toolPath(args: string): string {
  try {
    const a = JSON.parse(args || '{}')
    return String(a.path || a.filePath || a.file || a.name || '')
  } catch { return '' }
}

/** 组装全对话轨迹：每条 assistant 消息 = 一轮 */
const allTurns = computed<TrajTurn[]>(() => {
  const turns: TrajTurn[] = []
  let turn = 0
  for (const m of props.messages) {
    if (m.role !== 'assistant') continue
    turn++
    const tools: TrajTool[] = []
    const deliverables: TrajDeliverable[] = []
    let thinking = ''
    let summary = ''
    for (const n of m.flow || []) {
      if (n.kind === 'thinking') {
        if (!thinking) thinking = n.message.trim().replace(/\s+/g, ' ').slice(0, 60)
      } else if (n.kind === 'text') {
        if (!summary) summary = n.text.trim().replace(/\s+/g, ' ').slice(0, 36)
      } else if (n.kind === 'tool') {
        const t = n.tool
        const f = FILE_PRODUCER_TOOLS.has(t.name) ? toolPath(t.arguments) : ''
        tools.push({ name: t.name, status: t.status, duration: t.duration, file: f || undefined })
        if (f) deliverables.push({ kind: 'edit', name: f.split('/').pop() || f, path: f })
      } else if (n.kind === 'diagram' && n.svg && !n.pending) {
        deliverables.push({ kind: 'diagram', name: n.title || '图' })
      }
    }
    // content file 块补充（去重）
    const seen = new Set(deliverables.filter((d) => d.kind === 'edit' && d.path).map((d) => d.path))
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'file' && !seen.has(b.path)) {
        deliverables.push({ kind: 'edit', name: b.name || b.path.split('/').pop() || b.path, path: b.path })
      }
    }
    const metrics: TrajTurn['metrics'] = {}
    if (m.firstTokenMs != null && m.firstTokenMs > 0) metrics.ttft = +(m.firstTokenMs / 1000).toFixed(1)
    if (m.elapsedMs != null && m.elapsedMs > 0) metrics.elapsed = formatElapsed(m.elapsedMs)
    turns.push({
      turn,
      msgId: m.id,
      summary: summary || thinking || '',
      thinking,
      tools,
      deliverables,
      metrics: Object.keys(metrics).length ? metrics : undefined,
    })
  }
  return turns
})

const latestTurn = computed(() => (allTurns.value.length ? allTurns.value[allTurns.value.length - 1].turn : 0))

/** 搜索过滤：工具名/文件名/思考/正文摘要关键词 */
const filteredTurns = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allTurns.value
  return allTurns.value.filter((t) => {
    const hay = [
      t.summary,
      t.thinking,
      ...t.tools.map((x) => x.name + ' ' + (x.file || '')),
      ...t.deliverables.map((d) => d.name),
    ].join(' ').toLowerCase()
    return hay.includes(q)
  })
})

function isExpanded(turn: number): boolean {
  if (expandedTurns.value.has(turn)) return true
  return turn === latestTurn.value
}
function toggleTurn(turn: number) {
  const s = new Set(expandedTurns.value)
  if (s.has(turn)) s.delete(turn); else s.add(turn)
  expandedTurns.value = s
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

/** 产物点击 → 通知父组件预览文件（edit 走文件预览） */
function onDeliverableClick(d: TrajDeliverable) {
  if (d.path) emit('preview-file', d.path)
}

function statusLabel(t: TrajTool) {
  if (t.status === 'done') return '✓'
  if (t.status === 'running') return i18n('chatui.running')
  if (t.status === 'pending') return i18n('chatui.pending')
  return '✗'
}

function shortTime(ts: string) {
  return ts ? ts.replace('T', ' ').slice(5, 16) : ''
}

async function loadCheckpoints() {
  try {
    const res = await fetch('/api/checkpoints')
    if (res.ok) checkpoints.value = await res.json()
  } catch { /* ignore */ }
}

function toggleDetail(c: CheckpointMeta) {
  expandedId.value = expandedId.value === c.id ? '' : c.id
}

function resumeFrom(id: string) {
  chatStore.pendingResume = id
  expandedId.value = ''
}

onMounted(loadCheckpoints)
</script>

<style scoped>
.timeline-panel { padding: 4px 2px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.tl-section-title { font-size: 11px; font-weight: 500; color: var(--text-muted); margin: 8px 0 4px; }
.tl-empty { font-size: 12px; color: var(--text-muted); padding: 8px 0; }

/* 搜索框 */
.tl-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-muted);
}
.tl-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12px;
  color: var(--text-primary);
}
.tl-search-input::placeholder { color: var(--text-muted); }

/* 轨迹卡片 */
.tl-turn-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}
.tl-turn-card.current { border-color: var(--accent, #4f7cff); }
.tl-turn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  user-select: none;
  background: color-mix(in srgb, var(--bg-hover, rgba(127,127,127,0.06)) 60%, transparent);
}
.tl-turn-head:hover { background: var(--bg-hover, rgba(127,127,127,0.1)); }
.tl-chevron { flex-shrink: 0; transition: transform 0.18s ease; color: var(--text-muted); }
.tl-chevron.open { transform: rotate(180deg); }
.tl-turn-no { font-size: 11px; font-weight: 600; color: var(--accent, #4f7cff); white-space: nowrap; }
.tl-turn-summary {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl-turn-meta { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.tl-toolcount {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-hover, rgba(127,127,127,0.12));
  border-radius: 8px;
  padding: 0 6px;
  line-height: 15px;
}
.tl-jump {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}
.tl-turn-head:hover .tl-jump { opacity: 1; }
.tl-jump:hover { background: var(--bg-hover, rgba(127,127,127,0.12)); color: var(--accent, #4f7cff); }

.tl-turn-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.tl-reasoning {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary, rgba(127,127,127,0.05));
  border-radius: 6px;
  padding: 5px 8px;
  line-height: 1.5;
}
.tl-reasoning svg { flex-shrink: 0; margin-top: 2px; }

.tl-tools { display: flex; flex-direction: column; gap: 3px; }
.tl-tool { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
.tl-tool-name {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
}
.tl-tool-status { font-size: 11px; }
.tl-tool.done .tl-tool-status { color: var(--success, #22c55e); }
.tl-tool.running .tl-tool-status { color: var(--warning, #eab308); }
.tl-tool.error .tl-tool-status { color: var(--error); }
.tl-tool-duration { font-size: 10px; color: var(--text-muted); }
.tl-tool-file {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.tl-deliverables { display: flex; flex-wrap: wrap; gap: 4px; }
.tl-deliverable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--accent, #4f7cff);
  background: color-mix(in srgb, var(--accent, #4f7cff) 10%, transparent);
}
.tl-deliverable.diagram { color: #a78bfa; background: color-mix(in srgb, #a78bfa 12%, transparent); }
.tl-deliverable:hover { opacity: 0.8; }

.tl-metrics { display: flex; gap: 10px; font-size: 10px; color: var(--text-muted); }

/* 历史 checkpoint（续跑） */
.tl-history { display: flex; flex-direction: column; gap: 4px; }
.tl-history-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 7px 10px;
  cursor: pointer;
}
.tl-history-item.expanded { border-color: var(--accent, #4f7cff); }
.tl-history-head { display: flex; justify-content: space-between; font-size: 11px; }
.tl-history-turn { font-weight: 600; color: var(--text-secondary); }
.tl-history-time { color: var(--text-muted); }
.tl-history-msg {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 3px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl-history-meta { font-size: 10px; color: var(--text-muted); }
.tl-history-detail { margin-top: 5px; }
.tl-resume {
  font-size: 11px;
  color: var(--accent, #4f7cff);
  border: 1px solid var(--accent, #4f7cff);
  border-radius: 6px;
  padding: 2px 10px;
  background: transparent;
  cursor: pointer;
}
</style>
