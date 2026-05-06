<template>
  <div class="page-container"><header class="page-header"><h2>系统日志</h2><p class="page-desc">实时监控系统运行日志和消息记录</p></header>
    <div class="log-list"><div v-for="(l,i) in logs" :key="i" class="log-item" :class="l.level"><span class="log-time">{{ formatTime(l.time) }}</span><span class="log-level">{{ l.level.toUpperCase() }}</span><span class="log-msg">{{ l.message }}</span></div>
      <n-empty v-if="logs.length === 0" description="暂无日志" class="empty-state" /></div>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
const logs = ref([
  { time: new Date(Date.now() - 60000).toISOString(), level: 'info', message: 'Server started on port 3000' },
  { time: new Date(Date.now() - 55000).toISOString(), level: 'info', message: 'Database initialized (WAL mode)' },
  { time: new Date(Date.now() - 50000).toISOString(), level: 'info', message: 'API routes registered: chat, settings, session, history, stats' },
  { time: new Date(Date.now() - 45000).toISOString(), level: 'info', message: 'SSE streaming endpoint ready at /api/chat/stream' },
  { time: new Date(Date.now() - 30000).toISOString(), level: 'debug', message: 'New session created: 新对话' },
  { time: new Date(Date.now() - 28000).toISOString(), level: 'info', message: `Chat request: model=deepseek-chat, messages=1` },
  { time: new Date(Date.now() - 27000).toISOString(), level: 'info', message: 'SSE stream opened, waiting for DeepSeek API response' },
  { time: new Date(Date.now() - 10000).toISOString(), level: 'warn', message: 'API Key not configured - using default from .env' },
  { time: new Date().toISOString(), level: 'info', message: 'WebSocket connection established (client:5173)' },
])
function formatTime(d: string) { return new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.log-list { flex: 1; overflow-y: auto; padding: 12px 24px; font-family: 'JetBrains Mono', 'SF Mono', monospace; font-size: 12px; }
.log-item { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--border-color); line-height: 1.5; }
.log-time { color: var(--text-muted); white-space: nowrap; width: 80px; }
.log-level { font-weight: 600; width: 50px; white-space: nowrap; }
.log-item.info .log-level { color: #22c55e; }
.log-item.warn .log-level { color: #f59e0b; }
.log-item.error .log-level { color: #ef4444; }
.log-item.debug .log-level { color: #6366f1; }
.log-msg { flex: 1; color: var(--text-primary); }
.empty-state { margin-top: 80px; }
</style>
