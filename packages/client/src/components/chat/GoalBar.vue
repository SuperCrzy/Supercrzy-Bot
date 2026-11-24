<template>
  <section class="goal-bar" :aria-label="$t('goal.title')">
    <button v-if="!goal && !creating" type="button" class="goal-add" @click="creating = true">＋ {{ $t('goal.create') }}</button>
    <div v-if="creating && !goal" class="goal-editor">
      <label for="goal-objective">{{ $t('goal.objective') }}</label>
      <textarea id="goal-objective" v-model="objective" maxlength="20000" rows="3" :placeholder="$t('goal.placeholder')" />
      <label for="goal-acceptance">{{ $t('goal.acceptance') }}</label>
      <textarea id="goal-acceptance" v-model="acceptance" maxlength="20000" rows="2" />
      <div class="goal-actions"><button :disabled="busy || !objective.trim()" @click="create">{{ $t('goal.save') }}</button><button :disabled="busy" @click="creating = false">{{ $t('goal.close') }}</button></div>
    </div>
    <div v-if="goal" class="goal-card">
      <div class="goal-row">
        <button class="goal-summary" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
          <strong>{{ $t('goal.title') }}</strong><span class="goal-text">{{ goal.objective }}</span><span>{{ statusText }}</span><span>{{ elapsed }}</span>
        </button>
        <button v-if="goal.status === 'active'" :disabled="busy" @click="action('pause')">{{ $t('goal.pause') }}</button>
        <button v-if="['paused', 'interrupted', 'waiting_user'].includes(goal.status)" :disabled="busy" @click="start">{{ $t('goal.start') }}</button>
        <button v-if="['paused', 'interrupted', 'waiting_user'].includes(goal.status)" :disabled="busy" @click="complete">{{ $t('goal.complete') }}</button>
        <button v-if="['paused', 'interrupted', 'waiting_user'].includes(goal.status)" :disabled="busy" @click="cancel">{{ $t('goal.cancel') }}</button>
      </div>
      <p class="goal-note">{{ $t('goal.singleRound') }}</p>
      <div v-if="expanded" class="goal-details">
        <div v-if="editing" class="goal-editor">
          <label for="goal-edit-objective">{{ $t('goal.objective') }}</label>
          <textarea id="goal-edit-objective" v-model="editObjective" maxlength="20000" rows="3" />
          <label for="goal-edit-acceptance">{{ $t('goal.acceptance') }}</label>
          <textarea id="goal-edit-acceptance" v-model="editAcceptance" maxlength="20000" rows="2" />
          <p v-if="editGoalId !== goal.id" class="goal-error" role="alert">{{ $t('goal.editChanged') }}</p>
          <div class="goal-actions"><button :disabled="busy || !editObjective.trim() || editGoalId !== goal.id" @click="saveEdit">{{ $t('goal.save') }}</button><button :disabled="busy" @click="editing = false">{{ $t('goal.close') }}</button></div>
        </div>
        <template v-else>
          <p v-if="goal.acceptance"><strong>{{ $t('goal.acceptance') }}：</strong>{{ goal.acceptance }}</p>
          <button v-if="['paused', 'interrupted', 'waiting_user'].includes(goal.status)" :disabled="busy" @click="beginEdit">{{ $t('goal.edit') }}</button>
        </template>
        <p v-if="goal.last_result"><strong>{{ $t('goal.lastResult') }}：</strong>{{ goal.last_result }}</p>
        <p v-if="displayStream" class="goal-output">{{ displayStream }}</p>
      </div>
      <div v-for="item in pending.confirmations" :key="item.id" class="goal-pending" role="alert">
        <strong>{{ $t('goal.approval') }}: {{ item.name }}</strong><pre>{{ item.arguments }}</pre>
        <div class="goal-actions"><button :disabled="busy" @click="confirmTool(item.id, 'allow')">{{ $t('goal.allow') }}</button><button :disabled="busy" @click="confirmTool(item.id, 'deny')">{{ $t('goal.deny') }}</button></div>
      </div>
      <div v-for="question in pending.questions" :key="question.id" class="goal-pending" role="alert">
        <strong>{{ question.question }}</strong>
        <div class="goal-actions"><button v-for="option in question.options || []" :key="String(option)" :disabled="busy" @click="answer(question.id, String(option))">{{ option }}</button></div>
        <form class="goal-actions" @submit.prevent="answer(question.id, reply)"><input v-model="reply" :placeholder="$t('goal.answerPlaceholder')" /><button :disabled="busy || !reply.trim()">{{ $t('goal.reply') }}</button></form>
      </div>
    </div>
    <button type="button" class="goal-add" @click="toggleHistory">{{ $t('goal.history') }}</button>
    <div v-if="historyOpen" class="goal-details">
      <p v-if="!history.length">{{ $t('goal.noHistory') }}</p>
      <div v-for="item in history" :key="item.id" class="goal-pending">
        <strong>{{ item.objective }}</strong> · {{ $t(`goal.status_${item.status}`) }}
        <p v-if="item.last_result">{{ item.last_result }}</p>
      </div>
    </div>
    <p v-if="error" class="goal-error" role="alert">{{ error }} <button type="button" @click="refresh">{{ $t('goal.retry') }}</button></p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'

interface Goal { id: string; objective: string; acceptance: string; status: string; version: number; elapsed_ms: number; running_since: number | null; last_result: string }
interface PendingItem { id: string; name?: string; arguments?: string; question?: string; options?: string[] }
const props = defineProps<{ sessionId: string }>()
const { t, locale } = useI18n({ useScope: 'global' })
const account = useAccountStore()
const app = useAppStore()
const goal = ref<Goal | null>(null), creating = ref(false), objective = ref(''), acceptance = ref(''), expanded = ref(false), busy = ref(false), error = ref(''), reply = ref('')
const pending = ref<{ questions: PendingItem[]; confirmations: PendingItem[] }>({ questions: [], confirmations: [] })
const streamText = ref(''), now = ref(Date.now())
const historyOpen = ref(false), history = ref<Array<Pick<Goal, 'id' | 'objective' | 'status' | 'last_result'>>>([])
const editing = ref(false), editObjective = ref(''), editAcceptance = ref(''), editVersion = ref(0), editGoalId = ref('')
const displayStream = computed(() => streamText.value.replace(/<goal_report>[\s\S]*$/, '').trim())
let generation = 0, cursor = 0, loadingGeneration: number | null = null, refreshQueued = false, disposed = false, streamRun = ''
const statusText = computed(() => t(`goal.status_${goal.value?.status || 'paused'}`))
const elapsed = computed(() => {
  const g = goal.value
  const ms = (g?.elapsed_ms || 0) + (g?.running_since && ['active', 'pausing'].includes(g.status) ? Math.max(0, now.value - g.running_since) : 0)
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})
function base(sid = props.sessionId) { return `/api/sessions/${encodeURIComponent(sid)}/goal` }
/** An error carrying the server's machine-readable code, when it sent one. */
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code || `HTTP ${status}`) }
}

/**
 * Keep the response body's error code on failure.
 *
 * It used to throw `HTTP 401` and drop the body, so callers could not tell "not
 * signed in" from "goal changed" from "network died" and showed one generic line for
 * all of them. The code is the only part the caller can act on.
 */
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) {
    let code = ''
    try { const body = await response.json(); if (typeof body?.error === 'string') code = body.error } catch { /* non-JSON error page */ }
    throw new ApiError(response.status, code)
  }
  return response.json()
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code
  return ''
}
async function refresh() {
  if (disposed) return
  if (loadingGeneration === generation) { refreshQueued = true; return }
  const stamp = generation, sid = props.sessionId
  loadingGeneration = stamp
  try {
    const data = await json(base(sid))
    if (stamp !== generation) return
    const next = data.goal as Goal | null
    if (next?.id !== goal.value?.id) { cursor = 0; streamRun = ''; streamText.value = ''; pending.value = { questions: [], confirmations: [] } }
    goal.value = next
    if (next) {
      let [events, waiting] = await Promise.all([
        json(`${base(sid)}/${encodeURIComponent(next.id)}/events?after=${cursor}`),
        json(`${base(sid)}/${encodeURIComponent(next.id)}/pending`),
      ])
      if (stamp !== generation || goal.value?.id !== next.id) return
      pending.value = waiting
      // Catch up in bounded batches. Schedule another refresh if the backlog
      // exceeds this batch, keeping approvals and session switches responsive.
      for (let page = 0; page < 5; page++) {
        const items = events.events || []
        for (const event of items) {
          cursor = Math.max(cursor, event.sequence)
          if (event.run_id !== streamRun) { streamRun = event.run_id; streamText.value = '' }
          if (event.event === 'goal_turn') streamText.value = ''
          if (event.event === 'content_chunk' && typeof event.payload?.text === 'string') streamText.value = (streamText.value + event.payload.text).slice(-12000)
          if (event.event === 'content' && typeof event.payload?.content === 'string') streamText.value = event.payload.content.slice(-12000)
        }
        if (items.length < 100) break
        if (page === 4) { refreshQueued = true; break }
        events = await json(`${base(sid)}/${encodeURIComponent(next.id)}/events?after=${cursor}`)
        if (stamp !== generation || goal.value?.id !== next.id) return
      }
    }
    error.value = ''
  } catch { if (stamp === generation) error.value = t('goal.loadError') }
  finally {
    if (loadingGeneration === stamp) {
      loadingGeneration = null
      if (refreshQueued && !disposed) { refreshQueued = false; queueMicrotask(() => void refresh()) }
    }
  }
}
/**
 * Map the server's error code to something the user can act on.
 *
 * Every failure used to collapse into "action failed, try again", which is why a
 * 401 looked like a dead button: the user was signed in, the request said otherwise,
 * and nothing on screen distinguished the two. The code is the one thing the server
 * is sure about, so it decides the message.
 */
function messageFor(code: string): string {
  if (code === 'not_signed_in') return t('goal.notSignedIn')
  if (code === 'goal_changed' || code === 'invalid_version') return t('goal.goalChanged')
  if (code === 'goal_not_startable' || code === 'interruption_review_required') return t('goal.notStartable')
  return t('goal.actionError')
}

async function post(url: string, body: unknown) {
  const stamp = generation
  busy.value = true
  let failure = ''
  try {
    await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (stamp === generation) { error.value = ''; await refresh(); return stamp === generation }
    return false
  } catch (e) {
    failure = errorCode(e)
    if (stamp === generation) { await refresh(); if (stamp === generation) error.value = messageFor(failure) }
    return false
  } finally { if (stamp === generation) busy.value = false }
}
async function create() { if (await post(base(), { objective: objective.value, acceptance: acceptance.value })) { creating.value = false; objective.value = ''; acceptance.value = '' } }
function beginEdit() { if (!goal.value) return; editGoalId.value = goal.value.id; editObjective.value = goal.value.objective; editAcceptance.value = goal.value.acceptance; editVersion.value = goal.value.version; editing.value = true }
async function saveEdit() { if (!goal.value || goal.value.id !== editGoalId.value) return; if (await post(`${base()}/${encodeURIComponent(editGoalId.value)}/edit`, { version: editVersion.value, objective: editObjective.value, acceptance: editAcceptance.value })) editing.value = false }
async function action(kind: 'start' | 'pause' | 'cancel' | 'complete', extra: Record<string, unknown> = {}) {
  const g = goal.value; if (!g) return
  await post(`${base()}/${encodeURIComponent(g.id)}/${kind}`, { version: g.version, ...extra })
}
async function start() {
  if (goal.value?.status === 'interrupted' && !window.confirm(t('goal.reviewConfirm'))) return
  await action('start', { acknowledgeInterrupted: goal.value?.status === 'interrupted', model: app.currentModel || undefined, language: locale.value })
}
async function cancel() { if (window.confirm(t('goal.cancelConfirm'))) { await action('cancel'); if (historyOpen.value) await loadHistory() } }
async function complete() { if (window.confirm(t('goal.completeConfirm'))) { await action('complete'); if (historyOpen.value) await loadHistory() } }
async function loadHistory() {
  const stamp = generation
  try { const data = await json(`${base()}/history`); if (stamp === generation) history.value = data.goals }
  catch { if (stamp === generation) error.value = t('goal.loadError') }
}
async function toggleHistory() { historyOpen.value = !historyOpen.value; if (historyOpen.value) await loadHistory() }
async function confirmTool(id: string, decision: 'allow' | 'deny') { await post('/api/chat/tool-confirm', { toolCallId: id, decision }) }
async function answer(id: string, value: string) { if (!value.trim()) return; if (await post('/api/chat/question-answer', { questionId: id, answer: value }) && reply.value === value) reply.value = '' }
watch(() => [props.sessionId, account.accountId], () => { generation++; refreshQueued = false; goal.value = null; creating.value = false; editing.value = false; editObjective.value = ''; editAcceptance.value = ''; objective.value = ''; acceptance.value = ''; expanded.value = false; historyOpen.value = false; history.value = []; pending.value = { questions: [], confirmations: [] }; streamText.value = ''; streamRun = ''; cursor = 0; busy.value = false; void refresh() }, { immediate: true })
const timer = setInterval(() => { now.value = Date.now(); void refresh() }, 2000)
onBeforeUnmount(() => { disposed = true; generation++; clearInterval(timer) })
</script>

<style scoped>
.goal-bar { flex-shrink: 0; max-width: 800px; width: calc(100% - 32px); margin: 4px auto; font-size: 13px; color: var(--text-primary); }
.goal-card, .goal-editor { border: 1px solid var(--border-color); border-radius: 10px; padding: 9px 12px; background: var(--bg-secondary); }
.goal-row, .goal-actions { display: flex; align-items: center; gap: 8px; }
.goal-summary { flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px; text-align: left; }
.goal-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.goal-bar button { cursor: pointer; border: 0; border-radius: 6px; padding: 4px 7px; color: inherit; background: transparent; }
.goal-bar button:hover { background: var(--bg-hover); }
.goal-bar button:disabled { opacity: .5; cursor: not-allowed; }
.goal-add { color: var(--text-secondary) !important; }
.goal-note { margin: 4px 0 0; color: var(--text-muted); font-size: 11px; }
.goal-editor label { display: block; margin: 6px 0; }
.goal-editor textarea, .goal-pending input { box-sizing: border-box; width: 100%; border: 1px solid var(--border-color); border-radius: 6px; padding: 7px; color: inherit; background: var(--bg-primary); }
.goal-details, .goal-pending { margin-top: 8px; border-top: 1px solid var(--border-color); padding-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.goal-details p { margin: 4px 0; }
.goal-output, .goal-pending pre { max-height: 180px; overflow: auto; white-space: pre-wrap; }
.goal-error { color: var(--error, #c33); margin: 4px 0; }
</style>
