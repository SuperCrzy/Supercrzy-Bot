<template>
  <div class="web-search-card" :class="{ collapsed: !expanded }">
    <div class="ws-header" @click="expanded = !expanded">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span class="ws-query">{{ query || '搜索' }}</span>
      <span v-if="resultCount > 0" class="ws-count">{{ resultCount }}条结果</span>
      <svg class="ws-chevron" :class="{ open: expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div v-if="expanded" class="ws-body">
      <div v-if="results.length === 0" class="ws-empty">暂无搜索结果</div>
      <a
        v-for="(r, i) in results"
        :key="i"
        class="ws-result"
        :href="r.url || r.link"
        target="_blank"
        rel="noopener"
      >
        <div class="ws-result-title">{{ r.title || '无标题' }}</div>
        <div class="ws-result-snippet">{{ r.snippet || r.description || '' }}</div>
        <div class="ws-result-url">{{ formatUrl(r.url || r.link) }}</div>
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{ args?: string; result?: string }>()

const expanded = ref(false)

const query = computed(() => {
  try { return JSON.parse(props.args || '{}').query || '' }
  catch { return '' }
})

const results = computed(() => {
  if (!props.result) return []
  try {
    const data = JSON.parse(props.result)
    if (Array.isArray(data)) return data.slice(0, 10)
    if (data.results) return data.results.slice(0, 10)
    if (data.items) return data.items.slice(0, 10)
    if (data.organic) return data.organic.slice(0, 10)
    return []
  } catch {
    return []
  }
})

const resultCount = computed(() => results.value.length)

function formatUrl(url: string) {
  try { return new URL(url).hostname } catch { return url }
}
</script>

<style scoped>
.web-search-card {
  margin: 2px 0;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
  transition: border-color var(--duration-fast);
}

.web-search-card.collapsed {
  opacity: 0.75;
}

.web-search-card:hover {
  opacity: 1;
  border-left-color: var(--cat-network);
}

.ws-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-fast);
}

.ws-header:hover { color: var(--text-secondary); }

.ws-query { font-weight: 500; color: var(--text-secondary); font-size: 12px; }

.ws-count {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
}

.ws-chevron {
  margin-left: auto;
  flex-shrink: 0;
  transition: transform var(--duration-fast);
}
.ws-chevron.open { transform: rotate(180deg); }

.ws-body {
  padding: 4px 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border-color);
}

.ws-empty { font-size: 12px; color: var(--text-muted); padding: 6px 0; text-align: center; }

.ws-result {
  display: block;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  text-decoration: none;
  transition: background var(--duration-fast);
}

.ws-result:hover { background: var(--bg-hover); }

.ws-result-title {
  font-size: 12px; font-weight: 500; color: var(--accent);
  margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.ws-result-snippet {
  font-size: 12px; color: var(--text-secondary);
  line-height: 1.4; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.ws-result-url {
  font-size: 10px; color: var(--success);
  margin-top: 3px; font-family: var(--font-mono);
}
</style>
