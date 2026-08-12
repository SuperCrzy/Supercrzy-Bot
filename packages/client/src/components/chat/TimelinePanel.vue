<template>
  <div class="timeline-panel">
    <div class="tab-hint">{{ $t('chatui.timelineTitle') }}</div>

    <!-- 实时执行 -->
    <template v-if="liveTurns.length">
      <div class="tl-section-title">{{ $t('chatui.currentExec') }}</div>
      <div class="tl-list">
        <div
          v-for="(t, i) in liveTurns"
          :key="'live-' + i"
          class="tl-node"
          :class="{ current: i === liveTurns.length - 1 }"
        >
          <div class="tl-dot"></div>
          <div class="tl-content">
            <div class="tl-turn">Turn {{ t.turn }}</div>
            <div v-for="(tool, ti) in t.tools" :key="'tool-' + ti" class="tl-tool" :class="tool.status">
              <span class="tl-tool-name">{{ tool.name }}</span>
              <span class="tl-tool-status">{{ statusLabel(tool) }}</span>
              <span v-if="tool.duration" class="tl-tool-duration">{{ tool.duration }}s</span>
            </div>
            <div v-if="t.tools.length === 0" class="tl-tool-placeholder">{{ $t('chat.thinking') }}</div>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="tl-empty">{{ $t('chatui.timelineEmpty') }}</div>

    <!-- 历史执行记录 -->
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
          <button class="tl-resume" @click.stop="resumeFrom(c.id)">▶ {{ $t('chatui.resume') }}</button>
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
import type { ChatFlowNode } from '@/types'

interface LiveTool { name: string; status: string; duration?: number }
interface LiveTurn { turn: number; tools: LiveTool[] }
interface CheckpointMeta {
  id: string
  turn: number
  timestamp: string
  fileCount: number
  toolCallCount: number
  firstUserMsg: string
}

const { t: i18n } = useI18n({ useScope: 'global' })
const props = defineProps<{ flow?: ChatFlowNode[] }>()

const chatStore = useChatStore()
const checkpoints = ref<CheckpointMeta[]>([])
const expandedId = ref('')

/** 从时序流组装实时时间线（thinking → 该轮工具） */
const liveTurns = computed<LiveTurn[]>(() => {
  const turns: LiveTurn[] = []
  let cur: LiveTurn | null = null
  for (const n of props.flow || []) {
    if (n.kind === 'thinking') {
      cur = { turn: n.turn || turns.length + 1, tools: [] }
      turns.push(cur)
    } else if (n.kind === 'tool') {
      if (!cur) {
        cur = { turn: turns.length + 1, tools: [] }
        turns.push(cur)
      }
      cur.tools.push({ name: n.tool.name, status: n.tool.status, duration: n.tool.duration })
    }
  }
  return turns
})

async function loadCheckpoints() {
  try {
    const res = await fetch('/api/checkpoints')
    if (res.ok) checkpoints.value = await res.json()
  } catch { /* ignore */ }
}

function toggleDetail(c: CheckpointMeta) {
  expandedId.value = expandedId.value === c.id ? '' : c.id
}

/** 分支续跑：通知 ChatView 从该 checkpoint 继续 */
function resumeFrom(id: string) {
  chatStore.pendingResume = id
  expandedId.value = ''
}

function statusLabel(t: LiveTool) {
  if (t.status === 'done') return '✓'
  if (t.status === 'running') return i18n('chatui.running')
  if (t.status === 'pending') return i18n('chatui.pending')
  return '✗'
}

function shortTime(ts: string) {
  return ts ? ts.replace('T', ' ').slice(5, 16) : ''
}

onMounted(loadCheckpoints)
</script>

<style scoped>
.timeline-panel { padding: 4px 2px; font-size: 12px; }
.tl-section-title { font-size: 11px; font-weight: 600; color: var(--text-muted); margin: 12px 0 6px; }
.tl-empty { font-size: 12px; color: var(--text-muted); padding: 8px 0; }

/* 实时时间轴 */
.tl-list { position: relative; padding-left: 14px; }
.tl-list::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--border-color);
}
.tl-node { position: relative; padding: 4px 0 8px; }
.tl-dot {
  position: absolute;
  left: -14px;
  top: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-tertiary);
  border: 2px solid var(--text-muted);
}
.tl-node.current .tl-dot {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-muted, rgba(129, 140, 248, 0.2));
}
.tl-turn { font-weight: 600; color: var(--text-secondary); margin-bottom: 3px; }
.tl-tool {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
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
.tl-tool.error .tl-tool-status { color: var(--danger, #ef4444); }
.tl-tool-duration { font-size: 10px; color: var(--text-muted); }
.tl-tool-placeholder { font-size: 11px; color: var(--text-muted); font-style: italic; }

/* 历史记录 */
.tl-history-item {
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.tl-history-item:hover { border-color: var(--accent); }
.tl-history-item.expanded { border-color: var(--accent); }
.tl-history-head { display: flex; justify-content: space-between; margin-bottom: 3px; }
.tl-history-turn { font-weight: 600; font-size: 11px; }
.tl-history-time { font-size: 10px; color: var(--text-muted); }
.tl-history-msg {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-history-meta { font-size: 10px; color: var(--text-muted); margin-top: 3px; }
.tl-history-detail { margin-top: 8px; }
.tl-resume {
  width: 100%;
  padding: 6px 0;
  font-size: 12px;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
}
.tl-resume:hover { background: var(--accent-muted, rgba(129, 140, 248, 0.12)); }
</style>
