<template>
  <div class="collab-workbench">
    <!-- 顶栏：平台名 + 半自动/议院切换 + 授权状态 -->
    <header class="collab-topbar">
      <div class="collab-brand">
        <span class="collab-logo"><SvgIcon name="super" :size="15" /></span>
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
      <button class="collab-browser-toggle" @click="toggleAiBrowser">
        <SvgIcon name="super" :size="13" />
        <span>AI 浏览器</span>
      </button>
    </header>

    <div class="collab-body">
      <!-- 侧边栏"超级任务"列表承担任务导航；此处为聚焦当前任务的协作视图 -->
      <!-- 多 AI 对话流 -->
      <main class="collab-main">
        <div class="chat-flow" ref="chatFlowRef">
          <div v-if="!selectedTask" class="chat-empty">
            <p>在左侧选择一个超级任务查看各 AI 的分工与进展</p>
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
            <!-- 串行流水线推进（history：执行→质检→议院） -->
            <div v-for="(h, hi) in (selectedTask.history || [])" :key="hi" class="chat-line">
              <span class="chat-avatar" :style="{ background: actorBg(h.actor), color: actorColor(h.actor) }">{{ actorIcon(h.actor) }}</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" :style="{ color: actorColor(h.actor) }">{{ h.actor }}</span>
                <div class="chat-bubble">
                  <span>{{ h.summary }}</span>
                </div>
              </div>
            </div>
            <!-- 当前运行状态 -->
            <div v-if="RUNNING_STATES.includes(selectedTask.state)" class="chat-line">
              <span class="chat-avatar" style="background:#eef2ff;color:#4338ca">步</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#4338ca">平台</span>
                <div class="chat-bubble"><span class="run-dot" /> 正在{{ stateText(selectedTask.state) }}…</div>
              </div>
            </div>
            <!-- 最终交付物（done） -->
            <div v-if="selectedTask.summary" class="chat-line">
              <span class="chat-avatar" style="background:#e5e7eb;color:#374151">执</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#374151">交付物</span>
                <div class="chat-bubble" v-html="renderMarkdown(selectedTask.summary)" />
              </div>
            </div>
            <!-- 质检报告（引擎自动产出） -->
            <div v-if="selectedTask.quality && selectedTask.quality.status !== 'pending'" class="chat-line">
              <span class="chat-avatar" style="background:#fffbeb;color:#b45309">检</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#b45309">质检 AI</span>
                <div class="chat-bubble quality">
                  <div class="quality-head">
                    <span class="quality-score" :class="selectedTask.quality.status">{{ selectedTask.quality.score }}</span>
                    <div>
                      <span class="quality-badge" :class="selectedTask.quality.status">{{ selectedTask.quality.status === 'pass' ? '通过' : '需复核' }}</span>
                      <span class="quality-summary">{{ selectedTask.quality.summary }}</span>
                    </div>
                  </div>
                  <div class="quality-dims">
                    <span v-for="(v, k) in selectedTask.quality.dimensions" :key="k" class="quality-dim">
                      {{ k }} <b>{{ v }}</b>
                    </span>
                  </div>
                  <div v-if="selectedTask.quality.issues.length" class="quality-issues">
                    <div v-for="(i, idx) in selectedTask.quality.issues" :key="idx" class="quality-issue" :class="i.severity">
                      <span class="qi-title">{{ i.title }}</span>
                      <span class="qi-evidence">{{ i.evidence }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 议院审查（senate 模式） -->
            <div v-if="selectedTask.senate && selectedTask.senate.status !== 'pending'" class="chat-line">
              <span class="chat-avatar" style="background:#f5f3ff;color:#6d28d9">院</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#6d28d9">议院审查</span>
                <div class="chat-bubble senate">
                  <div class="quality-head">
                    <span class="quality-score" :class="selectedTask.senate.status">{{ selectedTask.senate.status === 'pass' ? '✓' : '需修订' }}</span>
                    <div>
                      <span>通过 {{ selectedTask.senate.passCount }} / {{ selectedTask.senate.totalSenators }} · 打回 {{ selectedTask.senate.rejectCount }}</span>
                    </div>
                  </div>
                  <div v-for="(v, idx) in selectedTask.senate.votes" :key="idx" class="senator-vote">
                    <div class="senator-head">
                      <!-- 品牌 LOGO 头像（按 provider：DeepSeek/Kimi 品牌色首字母） -->
                      <span class="senator-brand-avatar" :style="{ background: brandColor(v.brand), color: '#fff' }">{{ (v.brand || v.senator).slice(0,1).toUpperCase() }}</span>
                      <div class="senator-brand-wrap">
                        <b>{{ v.senator }}</b>
                        <span class="senator-brand-name">{{ v.brand || '' }}</span>
                      </div>
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
            <!-- 失败/中断提示 -->
            <div v-if="selectedTask.state === 'failed'" class="chat-line">
              <span class="chat-avatar" style="background:#fef2f2;color:#dc2626">!</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#dc2626">平台</span>
                <div class="chat-bubble fail-box">{{ selectedTask.error || '任务失败' }}</div>
              </div>
            </div>
            <!-- 半自动人控裁定（质检后停下等你） -->
            <div v-if="selectedTask.state === 'awaiting_decision'" class="chat-line">
              <span class="chat-avatar" style="background:#eff6ff;color:#1d4ed8">你</span>
              <div class="chat-bubble-meta">
                <span class="chat-actor" style="color:#1d4ed8">请裁定这份交付</span>
                <div class="chat-bubble decision-box">
                  <div class="decision-hint">质检已完成，这份结果你认为满意吗？</div>
                  <div class="decision-actions">
                    <button class="dec-btn pass" @click="sendDecision('accept')">通过验收</button>
                    <button class="dec-btn revise" @click="sendDecision('revise', feedback)">打回重做</button>
                    <button class="dec-btn discard" @click="sendDecision('discard')">放弃</button>
                  </div>
                  <input v-model="feedback" class="dec-feedback" placeholder="（打回时可选）说明你想让它改哪里…" @keyup.enter="sendDecision('revise', feedback)" />
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
import { useAppStore } from '@/stores/app'
import SvgIcon from '@/components/ui/SvgIcon.vue'

// ---- 串行引擎任务类型（对齐后端 collab-engine，2026-09-01）----
interface CollabHistory {
  stage: string; at: number; actor: string; summary: string
}
interface CollabTask {
  taskId: string
  goal: string
  state: string          // init/executing/reviewing/senate/delivering/done/failed
  stage: string
  mode: 'semi' | 'senate'
  round: number
  createdAt: number
  summary: string        // done 时=交付物
  delivery?: string
  quality?: any
  senate?: any
  history?: CollabHistory[]
  error?: string
}

const md = new MarkdownIt({ html: false, linkify: true })
function renderMarkdown(c: string) { return c ? md.render(c) : '' }

const { t } = useI18n({ useScope: 'global' })
const chatStore = useChatStore()

/** 展开/收起右侧"AI 浏览器"可收缩栏（DetailPanel browser tab） */
function toggleAiBrowser() {
  const appStore = useAppStore()
  appStore.setDetailPanelTab('browser')
  if (!appStore.detailPanelVisible) appStore.toggleDetailPanel()
}

const mode = ref<'semi' | 'senate'>('semi')
const authSeconds = ref(5)
const authEnabled = ref(true)
const apiOk = ref(true)
const tasks = ref<CollabTask[]>([])
const selectedTask = ref<CollabTask | null>(null)
const customGoal = ref('')
const feedback = ref('')
const starting = ref(false)
const chatFlowRef = ref<HTMLElement | null>(null)

/** 半自动人控裁定：awaiting_decision 时通过/打回/放弃 */
async function sendDecision(decision: 'accept' | 'revise' | 'discard', fb?: string) {
  const t = selectedTask.value
  if (!t) return
  try {
    await fetch(`/api/collab/tasks/${t.taskId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, feedback: fb || undefined }),
    })
    feedback.value = ''
  } catch (e) { /* 后台失败忽略 */ }
}

function switchMode(m: 'semi' | 'senate') {
  mode.value = m
  authSeconds.value = m === 'senate' ? 10 : 5
}

const sortedTasks = computed(() => {
  const order = { init: 0, executing: 1, reviewing: 2, senate: 3, delivering: 4, done: 5, failed: 6 } as Record<string, number>
  return [...tasks.value].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || b.createdAt - a.createdAt)
})

const STATE_TEXT: Record<string, string> = {
  init: '发起', executing: '执行中', reviewing: '质检中', senate: '议院评审', optimizing: '优化中', awaiting_decision: '待你裁定', delivering: '交付中', done: '完成', failed: '失败',
}
function stateText(s: string) { return STATE_TEXT[s] || s }
// 需展示"运行中"状态点的阶段（awaiting_decision 是停下等你，不算运行）
const RUNNING_STATES = ['init', 'executing', 'reviewing', 'senate', 'optimizing', 'delivering']

// 发言人身份映射（执行/质检/议院）
function actorIcon(a: string) { return ({ '执行AI': '执', '质检AI': '检', '议院': '院', '平台': '平' } as Record<string,string>)[a] || 'AI' }
function actorColor(a: string) { return ({ '执行AI': '#374151', '质检AI': '#b45309', '议院': '#6d28d9', '平台': '#4338ca' } as Record<string,string>)[a] || '#374151' }
function actorBg(a: string) { return ({ '执行AI': '#e5e7eb', '质检AI': '#fffbeb', '议院': '#f5f3ff', '平台': '#eef2ff' } as Record<string,string>)[a] || '#e5e7eb' }
// 议院 provider→品牌 LOGO 名（后续接真多品牌时按 provider 返回）
function providerName(): string { return '议院' }

// 品牌 LOGO 头像色（议院各厂商）；无品牌用议院紫
function brandColor(brand?: string): string {
  const b = (brand || '').toLowerCase()
  if (b.includes('kimi')) return '#111111';      // Kimi（月之暗面，黑）
  if (b.includes('deepseek')) return '#4D6BFE';  // DeepSeek 蓝
  if (b.includes('gpt') || b.includes('openai')) return '#10A37F'
  if (b.includes('claude') || b.includes('anthropic')) return '#C15F3C'
  if (b.includes('qwen') || b.includes('通义')) return '#615CED'
  if (b.includes('gemini') || b.includes('google')) return '#4285F4'
  return '#6d28d9'
}

async function loadTasks() {
  try {
    const r = await fetch('/api/collab/tasks')
    if (r.ok) {
      const list: any[] = await r.json()
      tasks.value = list
      if (selectedTask.value) {
        const cur = tasks.value.find((x: any) => x.taskId === selectedTask.value!.taskId)
        if (cur) selectedTask.value = cur
      } else if (tasks.value.length > 0) {
        // 无选中时：优先匹配当前打开的超级任务会话标题（goal===session title），否则选最新
        const curSession = chatStore.sessions.find(s => s.collabMode && s.id === chatStore.currentSessionId)
        const match = curSession ? tasks.value.find((x: any) => x.goal === curSession.title) : undefined
        selectTask(match || tasks.value[0])
      }
    }
  } catch { apiOk.value = false }
}

function selectTask(t: CollabTask) {
  selectedTask.value = t
}

async function startGoal(goal: string) {
  const g = String(goal || '').trim()
  if (!g || starting.value) return
  starting.value = true
  try {
    const r = await fetch('/api/collab/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: g, mode: mode.value, sessionId: chatStore.currentSessionId || undefined }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    const mk: CollabTask = { taskId: d.taskId, goal: g, state: 'init', stage: 'init', mode: mode.value, round: 0, createdAt: Date.now(), summary: '' }
    tasks.value.unshift(mk)
    selectedTask.value = mk
    customGoal.value = ''
    // 为该任务创建一条"超级"协作会话（侧边栏会话列表带 超级 徽标）
    try {
      const s = await chatStore.createSession(g, '', mode.value)
      // 任务会话绑定（可选）见 taskSession
    } catch (e) { /* 会话创建失败不阻塞任务 */ }
  } catch (e: any) { console.error('发布失败', e) }
  starting.value = false
}

async function stopTask(t: CollabTask) {
  await fetch(`/api/collab/tasks/${t.taskId}/stop`, { method: 'POST' }).catch(() => {})
  const cur = selectedTask.value
  if (cur) cur.state = 'failed'
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
.collab-logo { width: 26px; height: 26px; border-radius: 7px; background: #f5f3ff; color: #534AB7; display: flex; align-items: center; justify-content: center; }
.collab-name { font-weight: 600; font-size: 14px; }
.collab-mode-switch { display: flex; background: var(--bg-tertiary); border-radius: 8px; padding: 3px; gap: 2px; }
.mode-btn { border: none; background: transparent; font-size: 12px; padding: 5px 16px; border-radius: 6px; color: var(--text-muted); cursor: pointer; }
.mode-btn.active { background: var(--bg-primary); color: var(--text-primary); font-weight: 500; box-shadow: inset 0 0 0 1px var(--border-color); }
.collab-auth { font-size: 11px; background: #f0fdf4; color: #0f766e; border-radius: 6px; padding: 2px 10px; }
.collab-auth.on { background: #f0fdf4; color: #0f766e; }
.collab-api { font-size: 11px; color: var(--text-tertiary); margin-left: auto; }
.collab-browser-toggle { margin-left: 8px; display: flex; align-items: center; gap: 5px; font-size: 12px; color: #534AB7; background: #f5f3ff; border: 1px solid #e4dcf5; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.collab-browser-toggle:hover { background: #eeedfe; }
.collab-body { flex: 1; min-height: 0; display: flex; }
.collab-left { overflow-y: auto; border-right: 1px solid var(--border-color); padding: 14px; background: var(--bg-tertiary); min-height: 0; }
.collab-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg-tertiary); overflow: hidden; }
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
.senator-brand-avatar { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 600; flex-shrink: 0; }
.senator-brand-wrap { display: flex; flex-direction: column; line-height: 1.1; }
.senator-brand-name { font-size: 9px; color: var(--text-tertiary); }
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
.run-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #4338ca; margin-right: 6px; animation: runpulse 1s ease-in-out infinite; vertical-align: 1px; }
@keyframes runpulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.fail-box { color: #dc2626; font-size: 12px; }
.decision-box { display: flex; flex-direction: column; gap: 8px; }
.decision-hint { font-size: 12px; color: var(--text-secondary); }
.decision-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dec-btn { border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.dec-btn.pass { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; }
.dec-btn.revise { background: #fffbeb; color: #b45309; border-color: #fde68a; }
.dec-btn.discard { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
.dec-btn:hover { opacity: .85; }
.dec-feedback { border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 9px; font-size: 12px; background: var(--bg-tertiary); }
</style>
