<template>
<div v-if="hasDelivery(msg)" class="delivery-summary">
              <!-- Status line and the one-sentence outcome -->
              <div v-if="msg.deliverySummary?.summary" class="ds-head" :class="deliveryHeadClass(msg)">
                <span class="ds-dot"></span>
                <span class="ds-status">{{ deliveryStatusText(msg) }}</span>
                <span class="ds-summary-text">{{ msg.deliverySummary?.summary }}</span>
              </div>
              <!-- Artifact cards -->
              <template v-if="msg.deliverySummary?.artifacts.length">
              <div class="ds-title" :class="{ 'ds-title-toggle': (msg.deliverySummary?.artifacts.length || 0) > 3 }" @click="toggleDeliverySummary(msg)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                {{ $t('chat.deliveryTitle') }} ({{ msg.deliverySummary.artifactCount }})
                <svg v-if="(msg.deliverySummary?.artifacts.length || 0) > 3" class="ds-toggle-arrow" :class="{ open: deliverySummaryExpanded(msg) }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </div>
              <div class="ds-cards">
                <div v-for="(a, i) in deliverySummaryArtifacts(msg)" :key="i" class="ds-card" :title="a.path">
                  <span class="ds-card-icon">
                    <svg v-if="isArtifactImage(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    <svg v-else-if="isArtifactSheet(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                    <svg v-else-if="isArtifactDoc(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                  </span>
                  <span class="ds-card-info">
                    <span class="ds-card-name">{{ a.name }}</span>
                    <span class="ds-card-path">{{ a.path }}</span>
                  </span>
                  <button class="ds-card-open" :title="$t('chat.artifactOpen')" @click="openDeliveryArtifact(a)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </button>
                </div>
                <div v-if="(msg.deliverySummary?.artifacts.length || 0) > 3" class="ds-more" @click="toggleDeliverySummary(msg)">
                  {{ deliverySummaryExpanded(msg) ? $t('chatui.webFetchCollapse') : $t('chat.deliveryMore', { n: msg.deliverySummary.artifactCount - 3 }) }}
                </div>
              </div>
              </template>
              <!-- Changed files: show up to five, then a remaining count -->
              <div v-if="msg.deliverySummary?.changedFiles?.length" class="ds-changes">
                <span class="ds-changes-label">{{ $t('chat.deliveryChanges', { n: msg.deliverySummary?.changedCount || msg.deliverySummary?.changedFiles?.length }) }}</span>
                <span v-for="(c, i) in (msg.deliverySummary?.changedFiles || []).slice(0, 5)" :key="i" class="ds-change" :title="c.path">{{ c.name }}</span>
                <span v-if="(msg.deliverySummary?.changedFiles?.length || 0) > 5" class="ds-change-more">+{{ (msg.deliverySummary?.changedFiles?.length || 0) - 5 }}</span>
              </div>
              <!-- Stats: turns, tools, elapsed, tokens, cost -->
              <div class="ds-stats">
                <span>{{ $t('chat.deliveryTurns', { n: msg.deliverySummary?.turns }) }}</span>
                <span>{{ $t('chat.deliveryTools', { n: msg.deliverySummary?.toolCallCount }) }}</span>
                <span v-if="msg.deliverySummary?.durationMs">{{ fmtDeliveryDuration(msg.deliverySummary?.durationMs || 0) }}</span>
                <span v-if="msg.deliverySummary?.totalTokens">{{ $t('chat.deliveryTokens', { n: msg.deliverySummary?.totalTokens }) }}</span>
                <span v-if="msg.deliverySummary?.cost">{{ fmtDeliveryCost(msg.deliverySummary?.cost) }}</span>
              </div>
              <!-- Next step: offer a resumable checkpoint when unfinished -->
              <div v-if="msg.deliverySummary?.canResume && msg.deliverySummary?.checkpointId" class="ds-next">
                {{ $t('chat.deliveryResume') }}
                <code class="ds-ckpt">{{ msg.deliverySummary?.checkpointId }}</code>
              </div>
            </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ChatMessage } from '@/types'
import { hasDelivery, deliveryHeadClass, fmtDeliveryDuration, fmtDeliveryCost } from '@/utils/delivery'
import { isArtifactImage, isArtifactSheet, isArtifactDoc, deliverySummaryArtifacts, deliverySummaryExpanded, toggleDeliverySummary, deliveryStatusKey } from '@/utils/artifact-kind'

defineProps<{ msg: ChatMessage }>()
const { t } = useI18n({ useScope: 'global' })
function deliveryStatusText(msg: ChatMessage): string { return t(deliveryStatusKey(msg.deliverySummary?.status)) }
function openDeliveryArtifact(a: { path?: string }) {
  if (a.path) window.open(`/api/workspace/file?path=${encodeURIComponent(a.path)}`, '_blank')
}
</script>

<style scoped>
/* ---- Task delivery panel (P1-05) ---- */
.ds-head {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 1.5;
  padding: 6px 8px; margin-bottom: 8px;
  border-radius: 7px;
  background: var(--bg-secondary, rgba(127,127,127,.07));
}
.ds-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: #2fa36b; }
.ds-head--cancelled .ds-dot { background: #9aa0ab; }
.ds-head--failed .ds-dot { background: #d9534f; }
.ds-status { font-weight: 600; color: var(--text-primary); flex: 0 0 auto; }
.ds-summary-text { color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ds-changes {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  margin-top: 8px; font-size: 11px;
}
.ds-changes-label { color: var(--text-secondary); }
.ds-change {
  padding: 1px 6px; border-radius: 5px;
  background: var(--bg-secondary, rgba(127,127,127,.1));
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ds-change-more { color: var(--text-secondary); }
.ds-stats {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  margin-top: 8px; font-size: 11px; color: var(--text-tertiary, var(--text-secondary));
}
.ds-next {
  display: flex; align-items: center; gap: 6px;
  margin-top: 8px; font-size: 11px; color: var(--text-secondary);
}
.ds-ckpt {
  font-family: var(--font-mono, ui-monospace, monospace);
  padding: 1px 5px; border-radius: 4px;
  background: var(--bg-secondary, rgba(127,127,127,.1));
  font-size: 10px;
}
.delivery-summary {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-tertiary);
}

.ds-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}
.ds-title svg { color: var(--accent); }
.ds-title-toggle { cursor: pointer; user-select: none; }
.ds-title-toggle:hover { color: var(--accent); }
.ds-toggle-arrow { transition: transform var(--duration-fast, 0.15s); }
.ds-toggle-arrow.open { transform: rotate(180deg); }
/* Collapsed state: "show all" entry point */
.ds-more {
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 2px;
  user-select: none;
}
.ds-more:hover { text-decoration: underline; }

/* Artifact row, modelled on the artifact-slot pattern */
.ds-cards {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ds-card {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  border: 0.5px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  transition: border-color var(--duration-fast);
}
.ds-card:hover {
  border-color: var(--accent);
}
.ds-card-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--accent);
}
.ds-card-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ds-card-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-card-path {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-card-open {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ds-card-open:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

</style>
