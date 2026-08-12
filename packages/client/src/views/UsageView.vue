<template>
  <div class="page-container">
    <header class="page-header">
      <h2>{{ $t('usage.title') }}</h2>
      <p class="page-desc">{{ $t('usage.desc') }}</p>
    </header>

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
        <div class="overview-sub">{{ $t('usage.about') }} ¥{{ stats.total.cost?.toFixed(4) || '0' }}</div>
      </div>
      <div class="overview-card success">
        <div class="overview-value">{{ stats.today.messages }}</div>
        <div class="overview-label">{{ $t('usage.todayMessages') }}</div>
        <div class="overview-sub">{{ formatNumber(stats.today.tokens) }} tokens</div>
      </div>
      <div class="overview-card warning">
        <div class="overview-value">¥{{ stats.today.cost?.toFixed(6) || '0' }}</div>
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
            <td><code class="model-name">{{ m.model }}</code></td>
            <td>{{ m.count }}</td>
            <td>{{ formatNumber(m.tokens) }}</td>
            <td>¥{{ m.cost?.toFixed(6) || '0' }}</td>
            <td>{{ m.lastUsed || '-' }}</td>
          </tr>
        </tbody>
      </n-table>
      <n-empty v-if="modelStats.length === 0" :description="$t('usage.noModelData')" class="empty-mini" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, onMounted } from 'vue'
import { NTable } from 'naive-ui'
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

interface WeeklyPoint { date: string; messages: number; tokens: number }
interface ModelStat { model: string; count: number; tokens: number; cost: number; lastUsed: string }

const stats = reactive({
  today: { messages: 0, tokens: 0, cost: 0 },
  total: { sessions: 0, messages: 0, tokens: 0, cost: 0 },
  weekly: [] as WeeklyPoint[],
})

const modelStats = computed<ModelStat[]>(() => {
  // 简化：按模型分组统计（需要后端支持，这里先用通用统计）
  return [
    { model: 'deepseek-v4-pro', count: stats.total.messages, tokens: stats.total.tokens, cost: stats.total.cost, lastUsed: '刚刚' },
  ]
})

const maxMsgs = computed(() => Math.max(...stats.weekly.map(d => d.messages), 1))

function barHeight(count: number) {
  return Math.max((count / maxMsgs.value) * 100, 3)
}

function formatNumber(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.floor(n))
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
})
</script>

<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; overflow-y: auto; }
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

/* Section */
.section { padding: 0 24px 20px; }
.section-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; }

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
.model-name { font-family: var(--font-mono); font-size: 11px; }
.empty-mini { margin: 20px 0; }
</style>
