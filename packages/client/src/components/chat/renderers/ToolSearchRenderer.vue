<template>
  <div class="ts-card">
    <!-- 只有 meta 行：折叠/展开由 ToolCallBlock 外壳负责（与 WebSearchRenderer 一致） -->
    <div class="ts-meta">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ts-ico">
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
        <path d="M11 8v6M8 11h6" />
      </svg>
      <span class="ts-query" :title="payload?.query || ''">{{ payload?.query || $t('chat.toolSearchCardQuery') }}</span>
      <span class="ts-count">{{ $t(payload?.kind === 'list' ? 'chat.toolSearchCardListed' : 'chat.toolSearchCardLoaded', { n: payload?.hits.length || 0 }) }}</span>
      <span class="ts-spacer"></span>
    </div>

    <div class="ts-body">
      <!-- 解析失败就老实显示原文 -->
      <pre v-if="!payload" class="ts-raw">{{ result || $t('chat.toolSearchCardUnparsed') }}</pre>
      <div v-else-if="!payload.hits.length" class="ts-empty">{{ $t('chat.toolSearchCardEmpty') }}</div>
      <template v-else>
        <div v-for="(h, i) in shown" :key="h.name + i" class="ts-row">
          <code class="ts-name">{{ h.name }}</code>
          <span v-if="h.description" class="ts-desc" :title="h.description">{{ h.description }}</span>
        </div>
        <div v-if="payload.hits.length > shown.length" class="ts-more">
          <button class="ts-more-btn" type="button" @click="expandAll = true">
            {{ $t('chat.toolSearchCardMore', { n: payload.hits.length - shown.length }) }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * `tool_search` 专属卡（G4，2026-10-23）。
 *
 * 为什么不走 generic：tool_search 是两级加载的枢纽，用户需要一眼看到"搜了什么词、
 * 激活了哪几个工具"——这正是"能搜到调不到"排查时的关键证据。generic 把参数 JSON 和
 * 结果文本各堆一坨，什么都看不出来。
 *
 * 解析在 `utils/action-tool.ts`（纯函数 + 测试）；解析失败回落原文，不装成功。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseToolSearchPayload } from '@/utils/action-tool'

const props = defineProps<{
  result?: string
  args?: string
}>()

const { t } = useI18n({ useScope: 'global' })

const expandAll = ref(false)
const query = computed(() => {
  try { return String(JSON.parse(props.args || '{}').query || '') } catch { return '' }
})
const payload = computed(() => parseToolSearchPayload(props.result, query.value))
const shown = computed(() => {
  const all = payload.value?.hits || []
  return expandAll.value ? all : all.slice(0, 6)
})
</script>

<style scoped>
.ts-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.ts-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-primary);
}
.ts-ico { color: var(--text-muted); flex: 0 0 auto; }
.ts-query {
  max-width: 52%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ts-count { color: var(--text-muted); font-size: 11px; }
.ts-spacer { flex: 1; }

.ts-body { border-top: 1px solid var(--border-color); }
.ts-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px;
}
.ts-row + .ts-row { border-top: 1px solid var(--border-color); }
.ts-name {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-primary);
}
.ts-desc {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ts-more { padding: 6px 10px; border-top: 1px solid var(--border-color); }
.ts-more-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
}
.ts-more-btn:hover { color: var(--text-primary); }
.ts-empty { padding: 10px; font-size: 12px; color: var(--text-muted); }
.ts-raw {
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
