<template>
  <div v-if="visible" class="bgtask-dock">
    <div class="bgtask-card" :class="{ open }">
      <button class="bgtask-head" type="button" @click="open = !open">
        <svg class="bgtask-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" />
        </svg>
        <span class="bgtask-head-text">{{ headline }}</span>
        <span class="bgtask-head-hint">{{ $t('chat.bgTasksHeadHint') }}</span>
        <span class="bgtask-spacer"></span>
        <svg
          class="bgtask-chev" :class="{ up: open }" width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
        ><path d="M6 15l6-6 6 6" /></svg>
      </button>

      <!-- 列表在文档流内：展开时卡片变高 → footer 变高 → 消息区收缩，消息被顶上去（不遮盖） -->
      <div v-if="open" class="bgtask-list">
        <div
          v-for="t in shown"
          :key="t.id"
          class="bgtask-row"
          :class="{ sel: t.id === appStore.bgTaskPreviewId }"
          @click="preview(t.id)"
        >
          <svg class="bgtask-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
          </svg>
          <div class="bgtask-row-main">
            <div class="bgtask-row-title" :title="t.command">{{ t.title }}</div>
            <div class="bgtask-row-meta">{{ rowMeta(t) }}</div>
          </div>
          <!-- 删除要二次确认：运行中的任务被删 = 进程直接被终止，误点代价大 -->
          <n-popconfirm
            :positive-text="$t('chat.bgTasksDeleteConfirmYes')"
            :negative-text="$t('common.cancel')"
            @positive-click="remove(t)"
          >
            <template #trigger>
              <button
                class="bgtask-row-del"
                type="button"
                :title="t.status === 'running' ? $t('chat.bgTasksCancel') : $t('chat.bgTasksDelete')"
                @click.stop
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </template>
            <div class="bgtask-confirm-title">{{ $t('chat.bgTasksDeleteConfirmTitle') }}</div>
            <div class="bgtask-confirm-body">{{ $t('chat.bgTasksDeleteConfirmBody') }}</div>
          </n-popconfirm>
        </div>
        <div v-if="!shown.length" class="bgtask-empty">{{ $t('chat.bgTasksEmpty') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Background task dock — a single **in-flow** row above the composer card (same width as the card),
 * so it never covers the message action bar underneath the last reply.
 *
 * Collapsed: one row — clock icon + "N 个后台任务运行中" + secondary hint + chevron, fixed height
 * (it does NOT grow with the number of tasks, so the input box is never pushed down).
 * Expanded: the list is `position: absolute; bottom: 100%` → it opens **upward** over the message
 * area, adding no height anywhere. That is the one behaviour the earlier versions got wrong
 * (`top` anchor made it grow downward and cover the input box).
 *
 * Row trash button is hidden until the row is hovered (or keyboard-focused) — a permanent row of
 * trash icons reads as clutter. Deleting kills a running task first (see `deleteBgTask`).
 *
 * No token/cost numbers here: usage belongs to Settings -> Usage; while a process runs no model
 * call happens, so the hint says exactly that in plain words.
 *
 * Polling: 2s while the tab is visible (skipped on a hidden tab).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useAppStore } from '@/stores/app'
import { useSecondTick } from '@/composables/useSecondTick'

interface BgTaskView {
  id: string
  sessionId: string
  title: string
  command: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  bytes: number
  tail: string
}

const emit = defineEmits<{ (e: 'done', task: BgTaskView): void }>()

const { t } = useI18n({ useScope: 'global' })
const chatStore = useChatStore()
const appStore = useAppStore()

const tasks = ref<BgTaskView[]>([])
const open = ref(false)

const running = computed(() => tasks.value.filter((x) => x.status === 'running'))
/** 运行中的排前面，已结束的跟在后面（最多 20 行，超出在浮层内滚动） */
const shown = computed(() => [...running.value, ...tasks.value.filter((x) => x.status !== 'running')].slice(0, 20))
const visible = computed(() => tasks.value.length > 0)
const headline = computed(() =>
  running.value.length
    ? t('chat.bgTasksRunning', { n: running.value.length })
    : t('chat.bgTasksFinished', { n: tasks.value.length }),
)

const now = useSecondTick(() => running.value.length > 0, () => running.value[0]?.startedAt)

function elapsedText(task: BgTaskView): string {
  const end = task.endedAt ?? now.value
  const s = Math.max(0, Math.round((end - task.startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const mm = String(s % 60).padStart(2, '0')
  return m < 60 ? `${m}m${mm}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** 行内副标题：运行中给"已运行 22m59s"，结束给状态（失败附 exit code） */
function rowMeta(task: BgTaskView): string {
  if (task.status === 'running') return t('chat.bgTaskElapsed', { t: elapsedText(task) })
  if (task.status === 'done') return t('chat.bgTaskDone')
  if (task.status === 'cancelled') return t('chat.bgTaskCancelled')
  return `${t('chat.bgTaskFailed')}${task.exitCode === null ? '' : ` · exit ${task.exitCode}`}`
}

/**
 * 已处理过的任务 id（跨刷新去重，存 sessionStorage）。
 * 为什么不用内存：刷新后内存清零，同一个「已完成」会再触发一次续跑，白白多烧一轮模型调用。
 */
const HANDLED_KEY = 'supercrzy:bgResumed'
const handled = new Set<string>(
  (() => {
    try { return JSON.parse(sessionStorage.getItem(HANDLED_KEY) || '[]') as string[] } catch { return [] }
  })(),
)
function markHandled(id: string) {
  if (handled.has(id)) return
  handled.add(id)
  const arr = [...handled].slice(-50)
  try { sessionStorage.setItem(HANDLED_KEY, JSON.stringify(arr)) } catch { /* 隐私模式写不了，忽略 */ }
}

/**
 * 状态迁移检测：`running → 终态` 才触发一次续跑。
 *
 * 为什么不只靠 SSE 事件：页面刷新 / 切走会断流，事件就丢了 —— 而且"跑完继续做"本来就不该
 * 依赖某个标签页一直开着。轮询拿到新状态时补判一次，SSE 与轮询谁先到都只有一次效果。
 *
 * 不续跑的两类：`cancelled`（用户主动取消，再续跑等于违抗指令）与首次加载时就已是终态的任务
 * （页面关着期间跑完的——那会变成"一打开页面就自动烧一轮"，代价太不可见）。
 */
function detectFinished(next: BgTaskView[]) {
  const prev = new Map(tasks.value.map((x) => [x.id, x.status]))
  for (const t of next) {
    if (prev.get(t.id) !== 'running') continue
    if (t.status === 'running' || t.status === 'cancelled') continue
    if (handled.has(t.id)) continue
    markHandled(t.id)
    emit('done', t)
  }
}

async function refresh() {
  try {
    const sid = chatStore.currentSessionId || ''
    const res = await fetch(`/api/bg-tasks?sessionId=${encodeURIComponent(sid)}`)
    if (!res.ok) return
    const j: any = await res.json()
    const next: BgTaskView[] = Array.isArray(j?.tasks) ? j.tasks : []
    detectFinished(next)
    tasks.value = next
    if (!next.length) open.value = false
  } catch { /* network hiccup: keep the last known list */ }
}

/** 垃圾桶：运行中=杀掉并移除，已结束=直接移除记录 */
async function remove(task: BgTaskView) {
  try {
    await fetch(`/api/bg-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
  } catch { /* ignore */ }
  if (appStore.bgTaskPreviewId === task.id) appStore.bgTaskPreviewId = null
  await refresh()
}

function preview(id: string) {
  appStore.openBgTaskPreview(id)
}

let timer: ReturnType<typeof setTimeout> | null = null
let es: EventSource | null = null

/**
 * 事件源：任务进入终态时服务端推一条 `bg_task`（含 tail），不用轮询。
 * 兜底：EventSource 不可用或连接断了没恢复时，30s 慢轮询保证列表最终一致（不追求实时）。
 */
function start() {
  stop()
  if (typeof EventSource !== 'undefined') {
    es = new EventSource('/api/bg-tasks/stream')
    es.addEventListener('bg_task', (ev: MessageEvent) => {
      try {
        const task = JSON.parse(ev.data) as BgTaskView
        if (task.status !== 'cancelled' && !handled.has(task.id)) {
          markHandled(task.id)
          emit('done', task)
        }
      } catch { /* 坏帧忽略 */ }
      void refresh()
    })
    es.onerror = () => { /* EventSource 自带重连；慢轮询兜底 */ }
  }
  const loop = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      timer = setTimeout(loop, 15_000)
      return
    }
    void refresh().finally(() => {
      timer = setTimeout(loop, running.value.length ? 3_000 : 15_000)
    })
  }
  timer = setTimeout(loop, running.value.length ? 3_000 : 15_000)
}

function stop() {
  if (timer != null) { clearTimeout(timer); timer = null }
  if (es) { es.close(); es = null }
}

onMounted(() => { void refresh(); start() })
onBeforeUnmount(stop)
watch(() => chatStore.currentSessionId, () => { open.value = false; void refresh() })
</script>

<style scoped>
/* 流式占位：只占一行（与任务数量无关）→ 不遮挡消息操作栏，也不会随任务变多顶高输入框 */
.bgtask-dock {
  max-width: 800px;          /* 与 .composer-card 同宽，视觉上就是输入框正上方那一条 */
  margin: 0 auto 6px;
}

.bgtask-card {
  position: relative;
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.bgtask-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 14px;
  background: none;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-primary);
  text-align: left;
}
.bgtask-head:hover { background: var(--bg-hover); }
.bgtask-head-text { color: var(--text-primary); }
.bgtask-head-hint { color: var(--text-muted); font-size: 11.5px; }
.bgtask-spacer { flex: 1; }
.bgtask-chev { color: var(--text-muted); transition: transform .15s; flex: 0 0 auto; }
.bgtask-chev.up { transform: rotate(180deg); }
.bgtask-ico { color: var(--text-muted); flex: 0 0 auto; }

/*
 * 列表**在文档流里**（不浮起）：展开时卡片变高 → footer 变高 → 消息区（flex:1）自动收缩，
 * 于是消息被"顶上去"而不是被盖住（老板对照 WorkBuddy：回复中/回复结束都是顶上去）。
 * 列表自身限高滚动，任务再多也不会把消息区压没。
 */
.bgtask-list {
  border-top: 1px solid var(--border-color);
  max-height: 260px;
  overflow: auto;
  padding: 4px 0;
}

.bgtask-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px 7px 14px;
  cursor: pointer;
}
.bgtask-row:hover { background: var(--bg-hover); }
.bgtask-row.sel { background: var(--bg-active); }
.bgtask-row-main { flex: 1; min-width: 0; }
.bgtask-row-title {
  font-size: 12.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bgtask-row-meta { font-size: 11px; color: var(--text-muted); }
.bgtask-empty { padding: 8px 14px; font-size: 11.5px; color: var(--text-muted); }

/* 删除按钮：默认隐形，hover / 键盘聚焦才出现（常驻一排垃圾桶视觉太吵） */
.bgtask-row-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s, color .12s;
}
.bgtask-row:hover .bgtask-row-del,
.bgtask-row-del:focus-visible { opacity: 1; }
.bgtask-confirm-title { font-size: 13px; color: var(--text-primary); }
.bgtask-confirm-body { font-size: 12px; color: var(--text-muted); margin-top: 4px; max-width: 240px; }
.bgtask-row-del:hover { color: var(--error); background: var(--bg-primary); }
</style>
