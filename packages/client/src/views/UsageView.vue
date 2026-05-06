<template>
  <div class="page-container"><header class="page-header"><h2>用量统计</h2><p class="page-desc">查看 API 调用量和费用统计</p></header>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-value">{{ stats.today.messages }}</div><div class="stat-label">今日消息</div></div>
      <div class="stat-card"><div class="stat-value">{{ formatNumber(stats.today.tokens) }}</div><div class="stat-label">今日 Token</div></div>
      <div class="stat-card"><div class="stat-value">¥{{ stats.today.cost?.toFixed(2) || '0.00' }}</div><div class="stat-label">今日费用</div></div>
      <div class="stat-card"><div class="stat-value">{{ stats.total.sessions }}</div><div class="stat-label">总会话</div></div>
      <div class="stat-card"><div class="stat-value">{{ stats.total.messages }}</div><div class="stat-label">总消息</div></div>
      <div class="stat-card"><div class="stat-value">{{ formatNumber(stats.total.tokens) }}</div><div class="stat-label">总 Token</div></div>
    </div>
    <div class="chart-area"><n-card size="small" title="近 7 日用量趋势"><div style="height:200px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">图表区域 — 将在 Phase 2 实现实时图表</div></n-card></div>
  </div>
</template>
<script setup lang="ts">
import { reactive, onMounted } from 'vue'
const stats = reactive({ today: { messages: 0, tokens: 0, cost: 0 }, total: { sessions: 0, messages: 0, tokens: 0, cost: 0 }, weekly: [] as any[] })
function formatNumber(n: number) { if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return String(n) }
onMounted(async () => { try { const res = await fetch('/api/stats/usage'); if (res.ok) Object.assign(stats, await res.json()) } catch {} })
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.stats-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 24px; }
.stat-card { padding: 20px; border-radius: 10px; border: 1px solid var(--border-color); background: var(--bg-secondary); text-align: center; }
.stat-value { font-size: 24px; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.chart-area { padding: 0 24px 24px; }
</style>
