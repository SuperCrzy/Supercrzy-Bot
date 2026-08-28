<template>
  <div class="page-container"><header class="page-header"><h2>{{ $t('search.title') }}</h2><p class="page-desc">{{ $t('search.desc') }}</p></header>
    <div class="search-area"><n-input v-model:value="query" :placeholder="$t('search.searchPlaceholder')" size="large" clearable @keyup.enter="doSearch"><template #prefix><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></template></n-input></div>
    <div class="results" v-if="results.length"><div v-for="r in results" :key="r.id" class="result-item"><div class="result-header"><n-tag size="tiny" :type="r.role === 'user' ? 'info' : 'success'">{{ r.role === 'user' ? $t('chat.roleUser') : 'AI' }}</n-tag><span class="result-time">{{ formatTime(r.created_at) }}</span><span class="result-session">{{ r.session_title }}</span></div><div class="result-content">{{ displayContent(r.content).slice(0, 300) }}{{ displayContent(r.content).length > 300 ? '...' : '' }}</div></div></div>
    <n-empty v-else-if="query && searched" :description="$t('search.noResults')" /></div>
</template>
<script setup lang="ts">
import { ref } from 'vue'; const query = ref(''); const results = ref<any[]>([]); const searched = ref(false)
async function doSearch() { if (!query.value.trim()) return; try { const res = await fetch(`/api/history/search?q=${encodeURIComponent(query.value.trim())}`); if (res.ok) results.value = await res.json() } catch {} finally { searched.value = true } }
// 兼容两种 content：纯文本 / ContentBlock[] JSON 字符串（agent 消息）
function displayContent(content: any): string {
  if (typeof content !== 'string') return ''
  const trimmed = content.trim()
  if (trimmed.startsWith('[')) {
    try {
      const blocks = JSON.parse(trimmed)
      if (Array.isArray(blocks)) {
        return blocks.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      }
    } catch {}
  }
  return content
}
function formatTime(d: string) { return new Date(d).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
</script>
<style scoped>
.page-container { height: 100%; display: flex; flex-direction: column; }
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
