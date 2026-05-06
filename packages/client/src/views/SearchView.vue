<template>
  <div class="page-container"><header class="page-header"><h2>搜索</h2><p class="page-desc">搜索所有对话消息</p></header>
    <div class="search-area"><n-input v-model:value="query" placeholder="输入关键词搜索对话..." size="large" clearable @keyup.enter="doSearch"><template #prefix><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></template></n-input></div>
    <div class="results" v-if="results.length"><div v-for="r in results" :key="r.id" class="result-item"><div class="result-header"><n-tag size="tiny" :type="r.role === 'user' ? 'info' : 'success'">{{ r.role === 'user' ? '你' : 'AI' }}</n-tag><span class="result-time">{{ formatTime(r.created_at) }}</span><span class="result-session">{{ r.session_title }}</span></div><div class="result-content">{{ r.content.slice(0, 300) }}{{ r.content.length > 300 ? '...' : '' }}</div></div></div>
    <n-empty v-else-if="query && searched" description="未找到结果" /></div>
</template>
<script setup lang="ts">
import { ref } from 'vue'; const query = ref(''); const results = ref<any[]>([]); const searched = ref(false)
async function doSearch() { if (!query.value.trim()) return; try { const res = await fetch(`/api/sessions`); if (res.ok) { const sessions = await res.json(); const all: any[] = []; for (const s of sessions) { const msgs = await fetch(`/api/sessions/${s.id}`).then(r => r.json()).then(d => d.messages || []); for (const m of msgs) { if (m.content?.toLowerCase().includes(query.value.toLowerCase())) { all.push({ ...m, session_title: s.title }) } } } results.value = all } } catch {} finally { searched.value = true } }
function formatTime(d: string) { return new Date(d).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.search-area { padding: 32px 24px 16px; max-width: 640px; }
.results { flex: 1; overflow-y: auto; padding: 0 24px 24px; }
.result-item { padding: 16px; border: 1px solid var(--border-color); border-radius: 10px; margin-bottom: 12px; }
.result-header { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.result-time { font-size: 11px; color: var(--text-muted); }
.result-session { font-size: 11px; color: var(--text-muted); margin-left: auto; }
.result-content { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
</style>
