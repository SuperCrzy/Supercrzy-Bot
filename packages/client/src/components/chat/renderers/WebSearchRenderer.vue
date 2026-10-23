<template>
  <div class="ws-card">
    <!-- 只有 meta 行：折叠/展开由 ToolCallBlock 外壳负责（与 WebFetchCard 一致，避免双 header） -->
    <div class="ws-meta">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ws-ico">
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
      </svg>
      <span class="ws-query" :title="payload?.query || ''">{{ payload?.query || $t('chat.searchCardQuery') }}</span>
      <span class="ws-count">{{ $t('chat.searchCardCount', { n: payload?.results.length || 0 }) }}</span>
      <span class="ws-spacer"></span>
      <span v-if="payload?.engine" class="ws-engine">{{ payload.engine }}</span>
    </div>

    <div class="ws-body">
      <!-- 解析失败就老实显示原文：宁可难看，也不能装作搜到了什么 -->
      <pre v-if="!payload" class="ws-raw">{{ result || $t('chat.searchCardUnparsed') }}</pre>
      <div v-else-if="!payload.results.length" class="ws-empty">{{ $t('chat.searchCardEmpty') }}</div>
      <template v-else>
        <a
          v-for="(r, i) in shown"
          :key="r.url + i"
          class="ws-row"
          :href="r.url"
          target="_blank"
          rel="noopener noreferrer"
          :title="r.url"
        >
          <span class="ws-domain">{{ r.domain || $t('chat.searchCardUnknownDomain') }}</span>
          <span class="ws-main">
            <span class="ws-title">{{ r.title }}</span>
            <span v-if="r.snippet" class="ws-snippet">{{ r.snippet }}</span>
          </span>
          <span v-if="r.date" class="ws-date">{{ r.date }}</span>
        </a>
        <div v-if="payload.results.length > shown.length" class="ws-more">
          <button class="ws-more-btn" type="button" @click="expandAll = true">
            {{ $t('chat.searchCardMore', { n: payload.results.length - shown.length }) }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Dedicated card for `web_search`.
 *
 * Why not the generic card: a search result is only verifiable if the reader can see **where it came
 * from** (domain), **what it says** (title + snippet) and **when** (date). The generic card renders
 * one blob of text, so the reader cannot tell a real source from a hallucinated one — and in a long
 * session that blob takes half the screen.
 *
 * Layout: collapsed by default (search is the most frequent call — expanding it by default drowns
 * the conversation). Expanded shows the first 3 hits; the rest is one line away.
 *
 * Parsing lives in `utils/search-result.ts` (pure + tested). If the payload is not the structured
 * contract, we show the raw text instead of pretending the card worked.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseSearchPayload } from '@/utils/search-result'

const props = defineProps<{
  result?: string
  status?: string
}>()

const { t } = useI18n({ useScope: 'global' })

const expandAll = ref(false)
const payload = computed(() => parseSearchPayload(props.result))
const shown = computed(() => {
  const all = payload.value?.results || []
  return expandAll.value ? all : all.slice(0, 3)
})
</script>

<style scoped>
.ws-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.ws-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-primary);
}
.ws-ico { color: var(--text-muted); flex: 0 0 auto; }
.ws-query {
  max-width: 52%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ws-count { color: var(--text-muted); font-size: 11px; }
.ws-spacer { flex: 1; }
.ws-engine { color: var(--text-muted); font-size: 10.5px; }

.ws-body { border-top: 1px solid var(--border-color); }
.ws-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  text-decoration: none;
  color: inherit;
}
.ws-row + .ws-row { border-top: 1px solid var(--border-color); }
.ws-row:hover { background: var(--bg-hover); }
.ws-domain {
  flex: 0 0 auto;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 1px 5px;
  margin-top: 1px;
}
.ws-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ws-title { font-size: 12.5px; color: var(--text-primary); }
.ws-snippet {
  font-size: 11.5px;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ws-date { flex: 0 0 auto; font-size: 11px; color: var(--text-muted); margin-top: 1px; }
.ws-more { padding: 6px 10px; border-top: 1px solid var(--border-color); }
.ws-more-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
}
.ws-more-btn:hover { color: var(--text-primary); }
.ws-empty { padding: 10px; font-size: 12px; color: var(--text-muted); }
.ws-raw {
  margin: 0;
  padding: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
</style>
