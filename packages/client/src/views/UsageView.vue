<template>
  <div class="page-container">
    <header class="page-header">
      <h2>{{ $t('usage.title') }}</h2>
      <p class="page-desc">{{ $t('usage.desc') }}</p>
    </header>

    <!-- API 余额：DeepSeek 官方 /user/balance 的服务端代理（key 不下发前端） -->
    <div class="balance-bar" :class="{ low: balance.supported && balance.low, unsupported: !balance.supported }">
      <span class="balance-label">{{ $t('usage.balanceLabel') }}</span>
      <template v-if="balance.supported">
        <span class="balance-value">{{ formatCurrency(balanceTotal, 2) }}</span>
        <span class="balance-breakdown" :title="$t('usage.balanceBreakdownTip')">
          {{ $t('usage.balanceBreakdown', { granted: (balance.balances[0]?.granted ?? 0).toFixed(2), topup: (balance.balances[0]?.toppedUp ?? 0).toFixed(2) }) }}
        </span>
        <span v-if="balance.low" class="balance-warn">{{ $t('usage.balanceLow', { n: balance.thresholdCny }) }}</span>
        <span v-else-if="!balance.isAvailable" class="balance-warn">{{ $t('usage.balanceUnavailable') }}</span>
      </template>
      <span v-else class="balance-note">{{ balance.note || $t('usage.balanceUnsupported') }}</span>
      <button class="balance-refresh" :disabled="balanceLoading" @click="loadBalance(true)">
        {{ balanceLoading ? $t('usage.balanceLoading') : $t('usage.balanceRefresh') }}
      </button>
    </div>

    <!-- 概览卡片 -->
    <div class="stats-overview">
      <div class="overview-card primary">
        <div class="overview-value">{{ formatNumber(stats.total.messages) }}</div>
        <div class="overview-label">{{ $t('usage.totalMessages') }}</div>
        <div class="overview-sub">{{ $t('usage.sessionCount', { n: stats.total.sessions }) }}</div>
      </div>
      <div class="overview-card accent">
        <div class="overview-value">{{ formatNumber(stats.total.tokens) }}</div>
        <div class="overview-label">{{ $t('usage.totalTokenCost') }}</div>
        <div class="overview-sub">{{ $t('usage.about') }} {{ formatCurrency(stats.total.cost) }}</div>
        <!-- token 口径：模型返回的是真值，前端字符×0.6 的是估算。混在一起汇报等于撒谎，这里把占比摊开 -->
        <div
          v-if="stats.total.estimatedTokens > 0"
          class="overview-flag"
          :title="$t('usage.estimatedHint')"
        >
          {{ $t('usage.estimatedShare', { n: Math.round(stats.total.estimatedShare * 100) }) }}
        </div>
        <!-- 费用口径：按官方美元定价（含缓存命中折扣 + 峰谷价差）× 固定汇率折算成人民币 -->
        <div class="overview-flag" :title="$t('usage.costBasisNote')">USD→CNY</div>
      </div>
      <div class="overview-card success">
        <div class="overview-value">{{ stats.today.messages }}</div>
        <div class="overview-label">{{ $t('usage.todayMessages') }}</div>
        <div class="overview-sub">{{ formatNumber(stats.today.tokens) }} tokens</div>
      </div>
      <div class="overview-card warning">
        <div class="overview-value">{{ formatCurrency(stats.today.cost, 6) }}</div>
        <div class="overview-label">{{ $t('usage.todayCost') }}</div>
        <div class="overview-sub">{{ $t('usage.messageCount', { n: stats.today.messages }) }}</div>
      </div>
    </div>

    <!-- 7日趋势 -->
    <div class="section">
      <h3 class="section-title">{{ $t('usage.trendTitle') }}</h3>
      <div class="trend-chart">
        <VChart v-if="stats.weekly.length > 0" :option="chartOption" style="height:180px" autoresize />
        <div v-else class="chart-empty">{{ $t('usage.noData') }}</div>
      </div>
    </div>

    <!-- 任务级可观测（P2-02）：任务维度而非消息维度 —— 完成率/耗时/token/成本 -->
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">{{ $t('usage.taskSection') }}</h3>
        <!-- 统计窗口：过滤在服务端做，切换后指标与明细一起变（B4） -->
        <div class="window-switch" role="group" :aria-label="$t('usage.taskWindowLabel')">
          <span class="window-label">{{ $t('usage.taskWindowLabel') }}</span>
          <button
            v-for="opt in TASK_WINDOWS"
            :key="opt.days"
            class="window-btn"
            :class="{ active: taskDays === opt.days }"
            @click="setTaskWindow(opt.days)"
          >
            {{ $t(opt.key) }}
          </button>
        </div>
      </div>
      <div class="task-grid">
        <div class="task-cell">
          <div class="task-value">{{ taskStats.total }}</div>
          <div class="task-label">{{ $t('usage.taskTotal') }}</div>
        </div>
        <div class="task-cell">
          <div class="task-value">{{ (taskStats.successRate * 100).toFixed(0) }}%</div>
          <div class="task-label">{{ $t('usage.taskSuccessRate') }}</div>
        </div>
        <div class="task-cell">
          <div class="task-value">{{ formatNumber(taskStats.totalTokens) }}</div>
          <div class="task-label">{{ $t('usage.taskTokens') }}</div>
        </div>
        <div class="task-cell">
          <div class="task-value">{{ formatCurrency(taskStats.totalCostUsd, 6) }}</div>
          <div class="task-label">{{ $t('usage.taskCost') }}</div>
        </div>
        <div class="task-cell">
          <div class="task-value">{{ formatDuration(taskStats.avgDurationMs) }}</div>
          <div class="task-label">{{ $t('usage.taskAvgDuration') }}</div>
        </div>
      </div>
      <n-empty v-if="taskStats.total === 0" :description="$t('usage.noTaskData')" class="empty-mini" />

      <!-- 明细下钻：聚合数字看不出"哪几个任务在烧 token"，这里逐条列出 -->
      <n-table v-if="taskStats.tasks.length > 0" :single-line="false" size="small" class="model-table">
        <thead>
          <tr>
            <th>{{ $t('usage.taskCol') }}</th>
            <th>{{ $t('usage.taskStatusCol') }}</th>
            <th>{{ $t('usage.taskTokensCol') }}</th>
            <th>{{ $t('usage.taskCostCol') }}</th>
            <th>{{ $t('usage.taskDurationCol') }}</th>
            <th>{{ $t('usage.taskUpdatedCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in taskStats.tasks" :key="t.task_id">
            <td>
              <span class="task-row-label">{{ t.label || t.task_id.slice(0, 8) }}</span>
              <span v-if="t.failure_message" class="task-row-fail"> · {{ t.failure_message }}</span>
            </td>
            <td><code class="model-name">{{ t.status }}</code></td>
            <td>{{ formatNumber(t.tokens) }}</td>
            <td>{{ formatCurrency(t.cost_usd, 6) }}</td>
            <td>{{ formatDuration(t.duration_ms) }}</td>
            <td>{{ formatShortDate(new Date(t.updated_at).toISOString()) }}</td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="taskStats.total > taskStats.tasks.length" class="table-note">
        {{ $t('usage.taskTruncated', { shown: taskStats.tasks.length, total: taskStats.total }) }}
      </div>
    </div>

    <!-- 闲置能力建议（G3）：≥14 天没用过的工具，系统主动提醒而不是装了没人用 -->
    <div class="section">
      <h3 class="section-title">{{ $t('usage.idleSection') }}</h3>
      <p class="idle-desc">{{ $t('usage.idleDesc') }}</p>
      <n-table v-if="idleSuggestions.length > 0" :single-line="false" size="small" class="model-table">
        <thead>
          <tr>
            <th>{{ $t('usage.idleToolCol') }}</th>
            <th>{{ $t('usage.idleReasonCol') }}</th>
            <th>{{ $t('usage.idleDaysCol') }}</th>
            <th>{{ $t('usage.idleLastUsedCol') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in idleSuggestions" :key="s.tool">
            <td><code class="model-name">{{ s.tool }}</code></td>
            <td>{{ $t(s.reason === 'never-used' ? 'usage.idleNever' : 'usage.idleReason') }}</td>
            <td>{{ $t('usage.idleDays', { n: s.idleDays }) }}</td>
            <td>{{ s.lastUsed ? formatShortDate(s.lastUsed) : '-' }}</td>
            <td class="idle-action">
              <button class="idle-dismiss" :disabled="dismissing === s.tool" @click="dismissIdle(s.tool)">
                {{ $t('usage.idleDismiss') }}
              </button>
            </td>
          </tr>
        </tbody>
      </n-table>
      <n-empty v-else :description="$t('usage.idleEmpty')" class="empty-mini" />
    </div>

    <!-- 模型用量详情 -->
    <div class="section">
      <h3 class="section-title">{{ $t('usage.modelDetail') }}</h3>
      <n-table :single-line="false" size="small" class="model-table">
        <thead>
          <tr>
            <th>{{ $t('usage.modelCol') }}</th>
            <th>{{ $t('usage.messagesCol') }}</th>
            <th>{{ $t('usage.tokensCol') }}</th>
            <th>{{ $t('usage.costCol') }}</th>
            <th>{{ $t('usage.lastCallCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in modelStats" :key="m.model">
            <td>
              <code class="model-name">{{ m.model }}</code>
              <span v-if="m.unattributed > 0" class="attr-warn" :title="$t('usage.attributionTip', { n: m.unattributed })">*</span>
            </td>
            <td>{{ m.count }}</td>
            <td :title="m.estimatedTokens > 0 ? $t('usage.estimatedHint') : undefined">{{ tokensLabel(m) }}</td>
            <td>{{ formatCurrency(m.cost, 6) }}</td>
            <td>{{ m.lastUsed || '-' }}</td>
          </tr>
        </tbody>
      </n-table>
      <n-empty v-if="modelStats.length === 0" :description="$t('usage.noModelData')" class="empty-mini" />
      <p v-if="stats.total.unattributedMessages > 0" class="attr-note">
        {{ $t('usage.attributionNote', { n: stats.total.unattributedMessages }) }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { NTable, NEmpty } from 'naive-ui'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

const chartOption = computed(() => ({
  grid: { top: 10, right: 20, bottom: 20, left: 40 },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: stats.weekly.map(d => d.date.slice(5)), axisLabel: { fontSize: 10 } },
  yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
  series: [{
    type: 'line', data: stats.weekly.map(d => d.messages),
    smooth: true, lineStyle: { color: '#4F46E5' },
    itemStyle: { color: '#4F46E5' }, areaStyle: { color: 'rgba(79,70,229,0.08)' },
    symbolSize: 4,
  }],
}))

interface WeeklyPoint { date: string; messages: number; tokens: number; estimated_messages?: number }
interface ModelStat { model: string; count: number; tokens: number; estimatedTokens: number; cost: number; lastUsed: string; unattributed: number }

/** P2-02 任务级可观测（端点 /api/task-state/stats） */
interface TaskRow {
  task_id: string
  session_id: string
  label: string
  source: string
  status: string
  tokens: number
  cost_usd: number
  duration_ms: number
  started_at: number
  updated_at: number
  failure_message: string | null
}

const taskStats = reactive({
  total: 0,
  byStatus: {} as Record<string, number>,
  successRate: 0,
  failureRate: 0,
  cancelRate: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  avgDurationMs: 0,
  windowDays: 0,
  tasks: [] as TaskRow[],
})

/** 统计窗口选项：day=0 表示全量（服务端不做时间过滤） */
const TASK_WINDOWS = [
  { days: 7, key: 'usage.taskWindow7' },
  { days: 30, key: 'usage.taskWindow30' },
  { days: 0, key: 'usage.taskWindowAll' },
] as const

const taskDays = ref(7)

/** 拉任务统计（窗口由服务端执行过滤，前端只传参并显示生效值） */
async function loadTaskStats() {
  try {
    const qs = taskDays.value > 0 ? `?days=${taskDays.value}` : ''
    const res = await fetch(`/api/task-state/stats${qs}`)
    if (!res.ok) return
    const data = await res.json()
    if (data && data.stats) Object.assign(taskStats, data.stats)
  } catch {}
}

function setTaskWindow(days: number) {
  if (taskDays.value === days) return
  taskDays.value = days
  void loadTaskStats()
}

// ---- 闲置能力建议（G3）：口径 = playbook.tools_used，服务端按天记账 ----
interface IdleSuggestion { tool: string; reason: 'never-used' | 'idle'; idleDays: number; lastUsed: string | null }
const idleSuggestions = ref<IdleSuggestion[]>([])
const dismissing = ref('')

async function loadIdleCapabilities() {
  try {
    const res = await fetch('/api/capabilities/idle')
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data.suggestions)) idleSuggestions.value = data.suggestions
  } catch { /* 拿不到不影响用量页其他部分 */ }
}

async function dismissIdle(tool: string) {
  if (dismissing.value) return
  dismissing.value = tool
  try {
    const res = await fetch('/api/capabilities/idle/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool }),
    })
    if (res.ok) idleSuggestions.value = idleSuggestions.value.filter((s) => s.tool !== tool)
  } catch {} finally {
    dismissing.value = ''
  }
}

const stats = reactive({
  today: { messages: 0, tokens: 0, cost: 0 },
  total: {
    sessions: 0, messages: 0, tokens: 0, cost: 0,
    // token 口径拆分：measuredTokens 来自模型 usage，estimatedTokens 是字符×0.6 推算
    measuredTokens: 0, estimatedTokens: 0, estimatedShare: 0,
    estimatedMessages: 0, tokenizedMessages: 0,
    // 模型归属不可靠的老消息数（迁移前没有逐条 model，只能借 sessions.model 顶包）
    unattributedMessages: 0,
  },
  weekly: [] as WeeklyPoint[],
  byModel: [] as Array<{ model: string; count: number; tokens: number; estimated_tokens?: number; unattributed?: number; cost: number; last_used: string | null }>,
})

// ---- API 余额（服务端代理，前端只拿数字，永远不接触 key） ----
interface BalanceState {
  supported: boolean
  provider: 'deepseek' | 'other'
  isAvailable: boolean
  balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>
  thresholdCny: number
  low: boolean
  note?: string
}
const balance = reactive<BalanceState>({
  supported: false, provider: 'other', isAvailable: false, balances: [], thresholdCny: 5, low: false,
})
const balanceLoading = ref(false)

/** 优先展示人民币账户；只有美元账户时展示美元（不拿汇率硬换，避免两次折算误差叠加） */
const balanceTotal = computed(() => {
  const list = balance.balances
  if (!list.length) return 0
  return (list.find((b) => b.currency === 'CNY') || list[0]).total
})

async function loadBalance(force = false) {
  if (balanceLoading.value) return
  balanceLoading.value = true
  try {
    const res = await fetch(`/api/stats/balance${force ? '?force=1' : ''}`)
    if (!res.ok) return
    const data = await res.json()
    Object.assign(balance, {
      supported: data.supported === true,
      provider: data.provider === 'deepseek' ? 'deepseek' : 'other',
      isAvailable: data.isAvailable === true,
      balances: Array.isArray(data.balances) ? data.balances : [],
      thresholdCny: typeof data.thresholdCny === 'number' ? data.thresholdCny : 5,
      low: data.low === true,
      note: typeof data.note === 'string' ? data.note : undefined,
    })
  } catch {
    // 余额查不到不影响用量页其他部分
  } finally {
    balanceLoading.value = false
  }
}

const modelStats = computed<ModelStat[]>(() => {  // 后端按模型分组统计（真实数据）；无数据时保持空表
  return stats.byModel.map((m) => ({
    model: m.model,
    count: m.count,
    tokens: m.tokens,
    estimatedTokens: m.estimated_tokens || 0,
    unattributed: m.unattributed || 0,
    cost: m.cost || 0,
    lastUsed: m.last_used ? formatShortDate(m.last_used) : '-',
  }))
})

/** token 单元格文案：该模型下有估算数据时加 ~ 前缀，避免把估算当真值读 */
function tokensLabel(m: ModelStat) {
  return `${m.estimatedTokens > 0 ? '~' : ''}${formatNumber(m.tokens)}`
}

const maxMsgs = computed(() => Math.max(...stats.weekly.map(d => d.messages), 1))

function barHeight(count: number) {
  return Math.max((count / maxMsgs.value) * 100, 3)
}

function formatNumber(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.floor(n))
}

/**
 * 货币格式化。
 * 库里 messages.cost / task_state.cost_usd 存的都是**人民币**（后端按 USD 官方价 × 7.2 折算后落库），
 * 以前这里按界面语言把同一个数字换成 $ 显示 —— 数值不变、符号变了，等于把费用除以 7.2 展示。
 * 现在只认存储口径：人民币就是人民币，英文界面也不换符号。
 */
function formatCurrency(amount?: number, digits = 4) {
  return '¥' + (amount ?? 0).toFixed(digits)
}

/** P2-02：任务平均耗时格式化 */
function formatDuration(ms: number) {
  if (!ms) return '0s'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return sec + 's'
  const m = Math.floor(sec / 60)
  return m + 'm' + (sec % 60 ? (sec % 60) + 's' : '')
}

function formatShortDate(d: string) {
  return d.slice(5) // MM-DD
}

onMounted(async () => {
  try {
    const res = await fetch('/api/stats/usage')
    if (res.ok) {
      const data = await res.json()
      Object.assign(stats, data)
    }
  } catch {}
  // P2-02：任务级可观测（来自统一任务状态机 /api/task-state/stats）
  await loadTaskStats()
  // 余额与用量并行拉，查不到不影响上面
  void loadBalance()
  // 闲置能力建议（G3）：独立端点，失败不阻塞页面
  void loadIdleCapabilities()
})
</script>

<style scoped>
.page-container { height: 100%; display: flex; flex-direction: column; overflow-y: auto; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }

/* Overview Cards */
.stats-overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; padding: 20px 24px; }
.overview-card { padding: 18px 16px; border-radius: 12px; border: 1px solid var(--border-color); }
.overview-card.primary { background: linear-gradient(135deg, rgba(79,70,229,.06), rgba(79,70,229,.02)); }
.overview-card.accent { background: linear-gradient(135deg, rgba(6,182,212,.06), rgba(6,182,212,.02)); }
.overview-card.success { background: linear-gradient(135deg, rgba(34,197,94,.06), rgba(34,197,94,.02)); }
.overview-card.warning { background: linear-gradient(135deg, rgba(245,158,11,.06), rgba(245,158,11,.02)); }

.overview-value { font-size: 26px; font-weight: 700; color: var(--text-primary); }
.overview-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.overview-sub { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
/* 估算占比标记：token 口径不纯时必须可见，不能靠 hover 才知道 */
.overview-flag {
  display: inline-block; margin-top: 6px; padding: 1px 6px; border-radius: 4px;
  font-size: 10px; line-height: 16px; cursor: help;
  color: var(--warning);
  background: rgba(245, 158, 11, .1);
  border: 1px solid rgba(245, 158, 11, .25);
}

/* Section */
.section { padding: 0 24px 20px; }
/* P2-02 任务级可观测 */
.task-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.task-cell { padding: 12px; border-radius: 10px; border: 1px solid var(--border-color); }
.task-value { font-size: 18px; font-weight: 700; color: var(--text-primary); }
.task-label { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
@media (max-width: 900px) { .task-grid { grid-template-columns: repeat(2, 1fr); } }
.section-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; }

/* 任务统计窗口切换（B4）：过滤在服务端做，这里只是传参 */
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.section-head .section-title { margin-bottom: 12px; }
.window-switch { display: flex; align-items: center; gap: 4px; }
.window-label { font-size: 11px; color: var(--text-muted); margin-right: 2px; }
.window-btn {
  padding: 2px 8px; font-size: 11px; line-height: 18px; cursor: pointer;
  color: var(--text-secondary); background: transparent;
  border: 1px solid var(--border-color); border-radius: 5px;
}
.window-btn:hover { color: var(--text-primary); border-color: var(--text-muted); }
.window-btn.active {
  color: var(--accent); border-color: var(--accent);
  background: rgba(79, 70, 229, .08);
}
.task-row-label { font-size: 12px; color: var(--text-primary); }
.task-row-fail { font-size: 11px; color: var(--error); }
.table-note { margin-top: 8px; font-size: 11px; color: var(--text-muted); }

/* Bar Chart */
.trend-chart { background: var(--bg-secondary); border-radius: 10px; border: 1px solid var(--border-color); padding: 20px; }
.chart-empty { text-align: center; color: var(--text-muted); font-size: 13px; padding: 40px 0; }

.bar-chart { display: flex; align-items: flex-end; gap: 12px; height: 140px; padding-top: 20px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; }
.bar-value { font-size: 10px; color: var(--text-secondary); font-weight: 600; }
.bar-fill { width: 100%; max-width: 40px; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 3px; transition: height var(--duration-normal); }
.bar-label { font-size: 10px; color: var(--text-muted); margin-top: 4px; }

/* Model Table */
.model-table { width: 100%; margin-top: 8px; }
/* API 余额条：低余额时整条变暖色，不去弹窗打扰 */
.balance-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary, #fafafa);
  font-size: 12px;
  color: var(--text-primary, #111827);
}
.balance-bar.low { border-color: rgba(217, 119, 6, 0.45); background: rgba(217, 119, 6, 0.07); }
.balance-bar.unsupported { color: var(--text-tertiary, #6B7280); }
.balance-label { font-weight: 600; }
.balance-value { font-family: var(--font-mono); font-size: 15px; font-weight: 600; }
.balance-breakdown { color: var(--text-tertiary, #6B7280); font-size: 11px; }
.balance-warn { color: #B45309; font-weight: 600; }
.balance-note { color: var(--text-tertiary, #6B7280); }
.balance-refresh {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 11px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.balance-refresh:disabled { opacity: 0.5; cursor: default; }

.model-name { font-family: var(--font-mono); font-size: 11px; }
/* 归属不可靠标记：老消息没有逐条 model，只能借 sessions.model 顶包 */
.attr-warn {
  margin-left: 2px;
  color: var(--text-tertiary, #9CA3AF);
  cursor: help;
  font-size: 11px;
  vertical-align: super;
}
.attr-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary, #9CA3AF);
}
.empty-mini { margin: 20px 0; }

/* 闲置能力建议（G3） */
.idle-desc { font-size: 12px; color: var(--text-muted); margin: 0 0 10px; }
.idle-action { text-align: right; }
.idle-dismiss {
  padding: 2px 10px; font-size: 11px; cursor: pointer;
  color: var(--text-secondary); background: transparent;
  border: 1px solid var(--border-color); border-radius: 5px;
}
.idle-dismiss:hover { color: var(--text-primary); border-color: var(--text-muted); }
.idle-dismiss:disabled { opacity: 0.5; cursor: default; }
</style>
