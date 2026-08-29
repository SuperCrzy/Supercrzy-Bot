<template>
  <div class="collab-workbench">
    <!-- 顶栏：平台名 + 半自动/议院切换 + 授权状态 -->
    <header class="collab-topbar">
      <div class="collab-brand">
        <span class="collab-logo">协</span>
        <span class="collab-name">超级协作平台</span>
      </div>
      <div class="collab-mode-switch">
        <button
          class="mode-btn"
          :class="{ active: mode === 'semi' }"
          @click="switchMode('semi')"
        >半自动</button>
        <button
          class="mode-btn"
          :class="{ active: mode === 'senate' }"
          @click="switchMode('senate')"
        >全自动 · 议院</button>
      </div>
      <span class="collab-auth" :class="{ on: authSeconds > 0 }">
        {{ authSeconds > 0 ? `已授权 ${authSeconds}s` : '手动确认' }}
      </span>
      <span class="collab-api" v-if="apiOk">API 正常</span>
    </header>

    <div class="collab-body">
      <!-- 左栏：任务流水线看板 -->
      <aside class="collab-left">
        <p class="panel-title">任务流水线</p>
        <div class="task-list">
          <div v-if="tasks.length === 0" class="panel-empty">发布任务后在此实时跟踪</div>
          <div
            v-for="t in sortedTasks"
            :key="t.taskId"
            class="pipeline-card"
            :class="`pc--${t.status}`"
            @click="selectTask(t)"
          >
            <div class="pc-head">
              <span class="pc-name">{{ t.goal }}</span>
              <span class="pc-status" :class="`st--${t.status}`">{{ statusText(t.status) }}</span>
            </div>
            <div class="pc-sub">
              <span v-if="t.ghosts.length" class="pc-count">{{ t.ghosts.length }} 个 AI</span>
              <button v-if="t.status === 'running' || t.status === 'decomposing'" class="pc-stop" @click.stop="stopTask(t)">停止</button>
            </div>
          </div>
        </div>
      </aside>

      <!-- 中栏：多 AI 对话流 -->
      <main class="collab-main">
        <p class="panel-title">多 AI 协作</p>
        <div class="chat-flow" ref="chatFlowRef">
          <div v-if="!selectedTask" class="chat-empty">
            <p>选择左侧任务查看各 AI 的分工与进展</p>
            <p class="chat-empty-hint">执行 AI 负责实现，质检 AI / 议院负责把关，你可在底部 @ 协商</p>
          </div>
          <template v-else>
            <!-- 任务标题入口：模拟"你发布任务" -->
            <div class="chat-line user-line">
              <span class="chat-avatar" style="background:#eff6ff;color:#1d4ed8">你</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor">你</span>
                <div class="chat-bubble user">{{ selectedTask.goal }}</div>
              </div>
            </div>
            <!-- 各 AI 分工（执行/质检/议院 带身份） -->
            <div v-for="g in selectedTask.ghosts" :key="g.id" class="chat-line">
              <span class="chat-avatar" :style="{ background: actorBg(actorFor(g)), color: actorColor(actorFor(g)) }">{{ actorIcon(actorFor(g)) }}</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" :style="{ color: actorColor(actorFor(g)) }">{{ actorName(actorFor(g)) }}</span>
                <div class="chat-bubble">
                  <div class="chat-line-top">
                    <span class="chat-title">{{ g.title }}</span>
                    <span class="chat-status" :class="`cs--${g.status}`">{{ ghostStatusText(g.status) }}</span>
                    <span v-if="g.status === 'running'" class="chat-progress">{{ g.progress }}%</span>
                  </div>
                  <div v-if="g.status === 'running'" class="chat-bar"><div class="chat-bar-fill" :style="{ width: g.progress + '%' }" /></div>
                  <div v-if="g.log && g.log.length" class="chat-log">
                    <div v-for="(l,i) in g.log.slice(-2)" :key="i">{{ l }}</div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 议院汇总 -->
            <div v-if="selectedTask.summary" class="chat-line">
              <span class="chat-avatar" style="background:#f5f3ff;color:#6d28d9">院</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#6d28d9">议院</span>
                <div class="chat-bubble senate" v-html="renderMarkdown(selectedTask.summary)" />
              </div>
            </div>
            <!-- P2 质检报告 -->
            <div v-if="qualityReport && qualityReport.status !== 'pending'" class="chat-line">
              <span class="chat-avatar" style="background:#fffbeb;color:#b45309">检</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#b45309">质检 AI</span>
                <div class="chat-bubble quality">
                  <div class="quality-head">
                    <span class="quality-score" :class="qualityReport.status">{{ qualityReport.score }}</span>
                    <div>
                      <span class="quality-badge" :class="qualityReport.status">{{ qualityReport.status === 'pass' ? '通过' : '需复核' }}</span>
                      <span class="quality-summary">{{ qualityReport.summary }}</span>
                    </div>
                  </div>
                  <div class="quality-dims">
                    <span v-for="(v, k) in qualityReport.dimensions" :key="k" class="quality-dim">
                      {{ k }} <b>{{ v }}</b>
                    </span>
                  </div>
                  <div v-if="qualityReport.issues.length" class="quality-issues">
                    <div v-for="(i, idx) in qualityReport.issues" :key="idx" class="quality-issue" :class="i.severity">
                      <span class="qi-title">{{ i.title }}</span>
                      <span class="qi-evidence">{{ i.evidence }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- P4 议院审查 -->
            <div v-if="senateReport && senateReport.status !== 'pending'" class="chat-line">
              <span class="chat-avatar" style="background:#f5f3ff;color:#6d28d9">院</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#6d28d9">议院审查</span>
                <div class="chat-bubble senate">
                  <div class="quality-head">
                    <span class="quality-score" :class="senateReport.status">{{ senateReport.status === 'pass' ? '✓' : '需修订' }}</span>
                    <div>
                      <span>通过 {{ senateReport.passCount }} / {{ senateReport.totalSenators }} · 打回 {{ senateReport.rejectCount }}</span>
                    </div>
                  </div>
                  <div v-for="(v, idx) in senateReport.votes" :key="idx" class="senator-vote">
                    <div class="senator-head">
                      <b>{{ v.senator }}</b>
                      <span class="senator-verdict" :class="v.verdict">{{ v.verdict === 'pass' ? '通过' : (v.verdict === 'reject' ? '打回' : '弃权') }}</span>
                      <span class="senator-score">{{ v.score }}</span>
                    </div>
                    <div class="senator-summary">{{ v.summary }}</div>
                    <div v-for="(i, j) in v.issues.slice(0,3)" :key="j" class="quality-issue" :class="i.severity">
                      <span class="qi-title">{{ i.title }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 底部：任务输入 + 授权配置 -->
        <div class="chat-input-bar">
          <div class="chat-input-row">
            <input
              v-model="customGoal"
              class="chat-input"
              :placeholder="mode === 'senate' ? '发布任务，多位 AI 审查后交付…' : '发布任务，执行 + 质检完成后交付…'"
              @keyup.enter="startGoal(customGoal)"
            />
            <button class="chat-send" :disabled="starting || !customGoal.trim()" @click="startGoal(customGoal)">
              {{ starting ? '…' : '发布' }}
            </button>
          </div>
          <div class="chat-input-meta">
            <label class="auth-opt">
              <input type="checkbox" v-model="authEnabled" />
              <span>危险操作保留确认</span>
            </label>
            <span class="chat-hint">收敛后交付 · @议院 可集体评议</span>
          </div>
        </div>
      </main>

      <!-- AI 浏览器已并入可收缩的右侧 DetailPanel（browser tab），here 只留任务 + 对话流 -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownIt from 'markdown-it'
import { useChatStore } from '@/stores/chat'

// ---- 复用幽灵引擎的任务类型 ----
interface GhostGhost {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  progress: number
  log: string[]
  output: string
  error?: string
}
interface GhostTask {
  taskId: string
  goal: string
  status: 'decomposing' | 'running' | 'summarizing' | 'done' | 'failed' | 'stopped'
  createdAt: number
  ghosts: GhostGhost[]
  summary: string
  error?: string
}

const md = new MarkdownIt({ html: false, linkify: true })
function renderMarkdown(c: string) { return c ? md.render(c) : '' }

const { t } = useI18n({ useScope: 'global' })
const chatStore = useChatStore()
/** 任务 → 协作会话 ID 映射（发布任务时创建带"超级"标的会话，点侧边栏条目可回到该任务） */
const taskSession = new Map<string, string>()

const mode = ref<'semi' | 'senate'>('semi')
const authSeconds = ref(5)
const authEnabled = ref(true)
const apiOk = ref(true)
const tasks = ref<GhostTask[]>([])
const selectedTask = ref<GhostTask | null>(null)
const qualityReport = ref<any>(null)
const senateReport = ref<any>(null)
const customGoal = ref('')
const starting = ref(false)
const chatFlowRef = ref<HTMLElement | null>(null)

function switchMode(m: 'semi' | 'senate') {
  mode.value = m
  authSeconds.value = m === 'senate' ? 10 : 5
}

// 多 AI 角色映射（配合 P0 actor）
const ACTOR_BY_GHOST = ['执行AI', '质检AI', '议院']
function actorFor(g: GhostGhost): string {
  const i = parseInt(g.id.split('_').pop() || '0', 10) || 0
  return mode.value === 'senate' ? (i > 0 ? ACTOR_BY_GHOST[Math.min(i - 1, 2)] : '执行AI') : (i > 0 ? '质检AI' : '执行AI')
}
function actorIcon(a: string) { return ({ '执行AI': '执', '质检AI': '检', '议院': '院' } as Record<string,string>)[a] || 'AI' }
function actorName(a: string) { return ({ '执行AI': '执行AI', '质检AI': '质检AI', '议院': '议院' } as Record<string,string>)[a] || a }
function actorColor(a: string) { return ({ '执行AI': '#374151', '质检AI': '#b45309', '议院': '#6d28d9' } as Record<string,string>)[a] || '#374151' }
function actorBg(a: string) { return ({ '执行AI': '#e5e7eb', '质检AI': '#fffbeb', '议院': '#f5f3ff' } as Record<string,string>)[a] || '#e5e7eb' }

const sortedTasks = computed(() => {
  const order = { decomposing: 0, running: 1, summarizing: 2, done: 3, failed: 4, stopped: 5 } as Record<string, number>
  return [...tasks.value].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt - a.createdAt)
})

function statusText(s: string) {
  return ({ decomposing: t('ghost.statusDecomposing'), running: t('ghost.statusRunning'), summarizing: t('ghost.statusSummarizing'), done: t('ghost.statusDone'), failed: t('ghost.statusFailed'), stopped: t('ghost.statusStopped') } as Record<string,string>)[s] || s
}
function ghostStatusText(s: string) {
  return ({ running: t('ghost.gStatusRunning'), done: t('ghost.gStatusDone'), failed: t('ghost.gStatusFailed'), stopped: t('ghost.gStatusStopped') } as Record<string,string>)[s] || s
}

async function loadTasks() {
  try {
    const r = await fetch('/api/collab/tasks')
    if (r.ok) {
      tasks.value = await r.json()
      if (selectedTask.value) {
        const cur = tasks.value.find(x => x.taskId === selectedTask.value!.taskId)
        if (cur) selectedTask.value = cur
      }
    }
  } catch { apiOk.value = false }
}

function selectTask(t: GhostTask) {
  selectedTask.value = t
  qualityReport.value = null
  senateReport.value = null
  if (t.status === 'done') {
    fetchQuality(t.taskId)
    fetchSenate(t.taskId)
  }
}

async function fetchQuality(taskId: string) {
  qualityReport.value = { status: 'pending' }
  try {
    const r = await fetch(`/api/collab/tasks/${taskId}/quality`)
    if (r.ok) qualityReport.value = await r.json()
  } catch { qualityReport.value = { status: 'failed' } }
}

async function fetchSenate(taskId: string) {
  senateReport.value = { status: 'pending' }
  try {
    const r = await fetch(`/api/collab/tasks/${taskId}/senate`)
    if (r.ok) senateReport.value = await r.json()
  } catch { senateReport.value = { status: 'failed' } }
}

async function startGoal(goal: string) {
  const g = String(goal || '').trim()
  if (!g || starting.value) return
  starting.value = true
  try {
    const r = await fetch('/api/collab/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: g, mode: mode.value, authSeconds: authEnabled.value ? authSeconds.value : 0,
      }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    const mk: GhostTask = { taskId: d.taskId, goal: g, status: 'decomposing', createdAt: Date.now(), ghosts: [], summary: '' }
    tasks.value.unshift(mk)
    selectedTask.value = mk
    customGoal.value = ''
    // 超级协作平台：为该任务创建一条"超级"协作会话（侧边栏会话列表带 超级 徽标，
    // 与任务绑定，点开即可回到这条任务的协作视图）
    try {
      const s = await chatStore.createSession(g, '', mode.value)
      taskSession.set(d.taskId, s.id)
    } catch (e) { /* 会话创建失败不阻塞任务 */ }
  } catch (e: any) { console.error('发布失败', e) }
  starting.value = false
}

async function stopTask(t: GhostTask) {
  await fetch(`/api/collab/tasks/${t.taskId}/stop`, { method: 'POST' }).catch(() => {})
  t.status = 'stopped'
}

// ---- 实时轮询（WS /ws/ghost 可复用，MVP 先用短轮询保证即时）----
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  loadTasks()
  pollTimer = setInterval(loadTasks, 1500)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.collab-workbench { height: 100%; display: flex; flex-direction: column; background: var(--bg-primary); overflow: hidden; }
.collab-topbar { flex-shrink: 0; display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--border-color); }
.collab-brand { display: flex; align-items: center; gap: 8px; }
.collab-logo { width: 26px; height: 26px; border-radius: 7px; background: #534AB7; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.collab-name { font-weight: 600; font-size: 14px; }
.collab-mode-switch { display: flex; background: var(--bg-tertiary); border-radius: 8px; padding: 3px; gap: 2px; }
.mode-btn { border: none; background: transparent; font-size: 12px; padding: 5px 16px; border-radius: 6px; color: var(--text-muted); cursor: pointer; }
.mode-btn.active { background: var(--bg-primary); color: var(--text-primary); font-weight: 500; box-shadow: inset 0 0 0 1px var(--border-color); }
.collab-auth { font-size: 11px; background: #f0fdf4; color: #0f766e; border-radius: 6px; padding: 2px 10px; }
.collab-auth.on { background: #f0fdf4; color: #0f766e; }
.collab-api { font-size: 11px; color: var(--text-tertiary); margin-left: auto; }
.collab-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 230px 1fr; }
.collab-left { overflow-y: auto; border-right: 1px solid var(--border-color); padding: 14px; background: var(--bg-tertiary); min-height: 0; }
.collab-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg-tertiary); overflow: hidden; }
.panel-title { font-size: 12px; font-weight: 600; margin: 0 0 10px; }
.panel-empty { font-size: 12px; color: var(--text-tertiary); padding: 20px 0; text-align: center; }
.pipeline-card { border: 1px solid var(--border-color); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; cursor: pointer; background: var(--bg-primary); }
.pipeline-card:hover { border-color: var(--border-strong); }
.pc--running, .pc--decomposing { border-left: 3px solid #f59e0b; }
.pc--done { border-left: 3px solid #22c55e; }
.pc-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.pc-name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-status { font-size: 10px; border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
.st--running, .st--decomposing { background: #fffbeb; color: #b45309; }
.st--done { background: #f0fdf4; color: #15803d; }
.pc-sub { display: flex; justify-content: space-between; margin-top: 4px; align-items: center; }
.pc-count { font-size: 11px; color: var(--text-tertiary); }
.pc-stop { font-size: 11px; border: none; background: transparent; color: var(--text-danger, #dc2626); cursor: pointer; padding: 0; }
.chat-flow { flex: 1; overflow-y: auto; padding: 16px; min-height: 0; }
.chat-empty { text-align: center; color: var(--text-tertiary); padding: 40px 0; }
.chat-empty-hint { font-size: 12px; margin-top: 6px; }
.chat-line { display: flex; gap: 10px; margin-bottom: 14px; align-items: flex-start; }
.chat-line.user-line { justify-content: flex-end; }
.chat-avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.chat-bubble-meta { max-width: 80%; }
.chat-line.user-line .chat-bubble-meta { order: -1; }
.chat-actor { font-size: 11px; margin-bottom: 2px; display: block; }
.chat-bubble { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 2px 10px 10px 10px; padding: 9px 12px; font-size: 13px; }
.chat-line.user-line .chat-bubble { background: #eff6ff; border-color: #dbeafe; border-radius: 10px 2px 10px 10px; }
.chat-bubble.senate { border-color: #e4dcf5; background: #faf8ff; }
.chat-bubble.quality { border-color: #f0dcab; background: #fffbeb; }
.quality-head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.quality-score { font-size: 24px; font-weight: 600; line-height: 1; }
.quality-score.pass { color: #15803d; }
.quality-score.review { color: #b45309; }
.quality-badge { font-size: 11px; border-radius: 10px; padding: 1px 8px; margin-right: 8px; }
.quality-badge.pass { background: #f0fdf4; color: #15803d; }
.quality-badge.review { background: #fffbeb; color: #b45309; }
.quality-summary { font-size: 12px; color: var(--text-secondary); }
.quality-dims { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.quality-dim { font-size: 11px; background: var(--bg-tertiary); border-radius: 6px; padding: 2px 8px; }
.quality-dim b { font-weight: 500; }
.quality-issues { display: flex; flex-direction: column; gap: 4px; }
.quality-issue { font-size: 12px; padding: 6px 10px; border-radius: 6px; border-left: 3px solid #eab308; }
.quality-issue.high { border-left-color: #ef4444; background: #fef2f2; }
.quality-issue.medium { border-left-color: #f59e0b; background: #fffbeb; }
.quality-issue.low { border-left-color: #94a3b8; background: #f8fafc; }
.qi-title { font-weight: 500; display: block; }
.qi-evidence { color: var(--text-tertiary); font-size: 11px; }
.senator-vote { border-top: 1px dashed var(--border-color); padding: 8px 0; font-size: 12px; }
.senator-vote:first-of-type { border-top: none; padding-top: 0; }
.senator-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.senator-verdict { font-size: 11px; border-radius: 10px; padding: 0 8px; }
.senator-verdict.pass { background: #f0fdf4; color: #15803d; }
.senator-verdict.reject { background: #fef2f2; color: #dc2626; }
.senator-verdict.abstain { background: #f8fafc; color: #64748b; }
.senator-score { margin-left: auto; font-weight: 500; }
.senator-summary { color: var(--text-secondary); margin-bottom: 4px; }
.chat-line-top { display: flex; align-items: center; gap: 8px; }
.chat-title { font-weight: 500; }
.chat-status { font-size: 10px; }
.chat-progress { font-size: 11px; color: var(--text-tertiary); }
.cs--running { color: #b45309; } .cs--done { color: #15803d; } .cs--failed { color: #dc2626; }
.chat-bar { height: 4px; background: var(--bg-tertiary); border-radius: 3px; margin: 6px 0; overflow: hidden; }
.chat-bar-fill { height: 100%; background: #f59e0b; border-radius: 3px; }
.chat-log { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; }
.chat-log div { margin: 2px 0; }
.chat-input-bar { border-top: 1px solid var(--border-color); padding: 10px 16px; background: var(--bg-primary); flex-shrink: 0; }
.chat-input-row { display: flex; gap: 10px; }
.chat-input { flex: 1; border: 1px solid var(--border-color); border-radius: 8px; padding: 9px 12px; font-size: 13px; background: var(--bg-tertiary); }
.chat-send { border: none; background: #534AB7; color: #fff; border-radius: 8px; padding: 0 18px; font-size: 13px; cursor: pointer; }
.chat-send:disabled { opacity: .5; cursor: not-allowed; }
.chat-input-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 7px; }
.auth-opt { font-size: 11px; color: var(--text-tertiary); display: flex; align-items: center; gap: 4px; }
.chat-hint { font-size: 11px; color: var(--text-tertiary); }
</style>
