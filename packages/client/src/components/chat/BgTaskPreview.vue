<template>
  <div class="bgt-prev">
    <div v-if="!taskId" class="bgt-empty">{{ $t('chat.bgTasksPreviewEmpty') }}</div>

    <template v-else>
      <div class="bgt-head">
        <span class="bgdot" :class="'s-' + (meta?.status || 'running')"></span>
        <span class="bgt-title" :title="meta?.title">{{ meta?.title || taskId }}</span>
        <span class="bgt-spacer"></span>
        <span class="bgt-meta">{{ statusText }} · {{ elapsed }}</span>
      </div>

      <div class="bgt-label">{{ $t('chat.bgTasksCommand') }}</div>
      <!-- 命令与输出一律纯文本：不进 markdown、不做 HTML 转义，&& / < / > 保持原样 -->
      <pre class="bgt-pre">{{ meta?.command || '' }}</pre>

      <div class="bgt-label">
        {{ $t('chat.bgTasksLiveOutput') }}
        <span v-if="meta?.status === 'running'" class="bgt-live">{{ $t('chat.bgTaskRunning') }}</span>
      </div>
      <pre ref="outEl" class="bgt-pre bgt-out">{{ output || $t('chat.bgTasksNoOutput') }}</pre>

      <div class="bgt-foot">
        <button
          v-if="meta?.status === 'running'"
          class="bgt-btn bgt-btn-danger"
          type="button"
          @click="cancel"
        >{{ $t('chat.bgTasksCancel') }}</button>
        <span class="bgt-spacer"></span>
        <span class="bgt-meta">exit {{ meta?.exitCode ?? '—' }}<template v-if="truncated"> · {{ $t('chat.bgTasksTruncated') }}</template></span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Right-panel preview for one background task: title, the **exact command**, and live output.
 *
 * Output is fetched incrementally (`?from=cursor`) so a chatty command does not re-send everything
 * on each tick. Rendered inside `<pre>` on purpose — command text contains `&&`, `>`, `|` which must
 * survive verbatim (markdown / HTML escaping would mangle them).
 *
 * Polling stops as soon as the task is no longer running (no idle timer left behind).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useSecondTick } from '@/composables/useSecondTick'

interface BgTaskMeta {
  id: string
  title: string
  command: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt: number | null
  exitCode: number | null
}

const { t } = useI18n({ useScope: 'global' })
const appStore = useAppStore()

const taskId = computed(() => appStore.bgTaskPreviewId)
const meta = ref<BgTaskMeta | null>(null)
const output = ref('')
const truncated = ref(false)
const outEl = ref<HTMLElement | null>(null)

let cursor = 0
let timer: ReturnType<typeof setTimeout> | null = null
let alive = true

const now = useSecondTick(() => meta.value?.status === 'running', () => meta.value?.startedAt)

const elapsed = computed(() => {
  const m = meta.value
  if (!m) return ''
  const ms = Math.max(0, (m.endedAt ?? now.value) - m.startedAt)
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const mm = Math.floor(s / 60)
  return mm < 60 ? `${mm}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(mm / 60)}h${String(mm % 60).padStart(2, '0')}m`
})

const statusText = computed(() => {
  const s = meta.value?.status
  if (s === 'running') return t('chat.bgTaskRunning')
  if (s === 'done') return t('chat.bgTaskDone')
  if (s === 'failed') return t('chat.bgTaskFailed')
  if (s === 'cancelled') return t('chat.bgTaskCancelled')
  return ''
})

function reset() {
  meta.value = null
  output.value = ''
  truncated.value = false
  cursor = 0
}

async function fetchMeta(id: string) {
  try {
    const res = await fetch(`/api/bg-tasks/${encodeURIComponent(id)}`)
    if (!res.ok) return
    meta.value = (await res.json()) as BgTaskMeta
  } catch { /* keep previous */ }
}

async function fetchOutput(id: string) {
  try {
    const res = await fetch(`/api/bg-tasks/${encodeURIComponent(id)}/output?from=${cursor}`)
    if (!res.ok) return
    const j: any = await res.json()
    if (typeof j?.next === 'number') cursor = j.next
    if (j?.truncated) truncated.value = true
    if (j?.text) {
      output.value += String(j.text)
      // 只留尾部 200KB，长任务的输出不能无限吃内存
      if (output.value.length > 200 * 1024) output.value = output.value.slice(-200 * 1024)
      await nextTick()
      const el = outEl.value
      if (el) el.scrollTop = el.scrollHeight
    }
  } catch { /* keep previous */ }
}

async function cancel() {
  const id = taskId.value
  if (!id) return
  try {
    await fetch(`/api/bg-tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  } catch { /* ignore */ }
  await fetchMeta(id)
}

async function tick() {
  const id = taskId.value
  if (!id || !alive) return
  await fetchMeta(id)
  await fetchOutput(id)
  if (alive && meta.value?.status === 'running') {
    timer = setTimeout(tick, 1000)
  }
}

function stop() {
  if (timer != null) { clearTimeout(timer); timer = null }
}

watch(taskId, async (id) => {
  stop()
  reset()
  if (!id) return
  await tick()
}, { immediate: true })

onBeforeUnmount(() => { alive = false; stop() })
</script>

<style scoped>
.bgt-prev { padding: 10px 12px; font-size: 12px; }
.bgt-empty { color: var(--text-muted); padding: 12px 0; }
.bgt-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.bgt-title {
  color: var(--text-primary);
  max-width: 60%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bgt-spacer { flex: 1; }
.bgt-meta { color: var(--text-muted); font-size: 11px; }
.bgt-label { color: var(--text-muted); font-size: 11px; margin: 8px 0 4px; display: flex; gap: 6px; align-items: center; }
.bgt-live { color: var(--success); }
.bgt-pre {
  margin: 0;
  padding: 8px;
  background: var(--bg-code);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bgt-out { max-height: 320px; overflow: auto; min-height: 60px; }
.bgt-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.bgt-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.bgt-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.bgt-btn-danger { color: var(--error); border-color: var(--border-color); }
.bgdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--text-muted);
}
.bgdot.s-running { background: var(--success); }
.bgdot.s-failed { background: var(--error); }
.bgdot.s-cancelled { background: var(--warning); }
</style>
