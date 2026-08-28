<template>
  <div class="compare-result">
    <!-- 推荐条（打字完成后出现 / 历史消息直接展示） -->
    <div v-if="recoText" class="compare-reco">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="compare-reco-icon"><path d="M8 21h8m-4-4v4m-7-9a7 7 0 1 1 14 0c0 3.5-1.5 5.5-3 6.5V17H8v-1.5c-1.5-1-3-3-3-6.5z"/><circle cx="12" cy="11" r="2"/></svg>
      <span class="compare-reco-label">{{ $t('chat.compareReco') }}</span>
      <span class="compare-reco-text">{{ recoText }}</span>
    </div>

    <!-- 打字模式（流式对比中）：多列同时打字机渲染 -->
    <div v-if="live && live.length > 0" class="compare-cols">
      <div
        v-for="c in live"
        :key="c.id"
        class="compare-col"
      >
        <div class="compare-col-head">
          <span class="compare-col-name">{{ c.label }}</span>
          <span v-if="c.done" class="compare-col-badge ok">{{ $t('chat.compareDoneShort') }}</span>
          <span v-else class="compare-col-badge typing">{{ $t('chat.compareTyping') }}</span>
        </div>
        <div class="compare-col-body live">
          <span class="live-text">{{ c.text }}</span>
          <span v-if="!c.done" class="live-cursor"></span>
        </div>
      </div>
    </div>

    <!-- 完成模式（历史消息 / 非流式）：markdown 渲染 -->
    <div v-else class="compare-cols">
      <div
        v-for="r in data.results"
        :key="r.id"
        class="compare-col"
        :class="{ 'is-error': !!r.error }"
      >
        <div class="compare-col-head">
          <span class="compare-col-name">{{ r.label }}</span>
          <span v-if="r.error" class="compare-col-badge err">error</span>
        </div>
        <div v-if="r.content" class="compare-col-body" v-html="renderMd(r.content)"></div>
        <div v-else class="compare-col-body is-error">
          {{ r.error || $t('chat.compareEmpty') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  data: {
    results: Array<{ id: string; model: string; label: string; content: string; error?: string }>
    recommendation?: string
    recommendationModel?: string
  }
  live?: Array<{ id: string; label: string; text: string; done: boolean }>
  liveReco?: string
  liveFinished?: boolean
}>()

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function renderMd(text: string): string {
  return md.render(text || '')
}

const recoText = computed(() => {
  if (props.live && props.live.length > 0 && props.liveFinished) return props.liveReco || ''
  return props.data?.recommendation || ''
})
</script>

<style scoped>
.compare-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 推荐条 */
.compare-reco {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--accent) 30%, transparent);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-primary);
}
.compare-reco-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.compare-reco-label {
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 1px;
}
.compare-reco-text {
  color: var(--text-primary);
  min-width: 0;
}
/* 多列 */
.compare-cols {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.compare-col {
  flex: 1 0 300px;
  max-width: 360px;
  min-width: 260px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.compare-col.is-error {
  border-color: color-mix(in srgb, var(--error) 40%, transparent);
}
.compare-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  position: sticky;
  left: 0;
}
.compare-col-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compare-col-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
  flex-shrink: 0;
}
.compare-col-badge.err {
  color: var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
}
.compare-col-badge.typing {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.compare-col-badge.ok {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}
.compare-col-body {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  max-height: 420px;
  overflow-y: auto;
  word-break: break-word;
}
/* 打字模式：纯文本 + 闪烁光标 */
.compare-col-body.live {
  white-space: pre-wrap;
  font-size: 13.5px;
  min-height: 60px;
}
.live-cursor {
  display: inline-block;
  width: 2px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: live-blink 1s step-end infinite;
}
@keyframes live-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.compare-col-body.is-error {
  color: var(--error);
  font-size: 12px;
}
:deep(.compare-col-body pre) {
  background: var(--bg-primary);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12px;
}
:deep(.compare-col-body code) {
  font-family: var(--font-mono);
}
:deep(.compare-col-body table) {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
:deep(.compare-col-body th),
:deep(.compare-col-body td) {
  border: 1px solid var(--border-color);
  padding: 4px 8px;
  text-align: left;
}
</style>
