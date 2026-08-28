<template>
  <!-- 错误横幅（对齐 WorkBuddy error-banner：对话区顶部 fixed，变体配色 + 标题行 + 详情行 + 动作区，可关闭） -->
  <div class="error-banner" :class="`error-banner--${variant}`">
    <button v-if="dismissible" type="button" class="error-banner__close" :title="labels.close" @click="emit('dismiss')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <div class="error-banner__title-row">
      <span class="error-banner__icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="7"/><path d="M8 4.5v4.2"/><circle cx="8" cy="11.6" r="0.9" fill="currentColor" stroke="none"/></svg>
      </span>
      <span class="error-banner__title">{{ title }}</span>
      <span v-if="details.code" class="error-banner__code">{{ details.code }}</span>
      <span v-if="details.requestId || details.traceId" class="error-banner__trace">
        <template v-if="details.requestId">Req {{ details.requestId }}</template>
        <template v-if="details.requestId && details.traceId"> · </template>
        <template v-if="details.traceId">Trace {{ details.traceId }}</template>
      </span>
    </div>
    <div v-if="message" class="error-banner__detail">{{ message }}</div>
    <div class="error-banner__actions">
      <button type="button" class="error-banner__btn error-banner__btn--copy" :class="{ copied }" @click="handleCopy">
        {{ copied ? labels.copied : labels.copyError }}
      </button>
      <button v-if="canRetry" type="button" class="error-banner__btn" @click="emit('retry')">{{ labels.retry }}</button>
      <a v-if="docsUrl" class="error-banner__btn" :href="docsUrl" target="_blank" rel="noopener noreferrer">{{ labels.viewDocs }}</a>
      <a v-if="feedbackUrl" class="error-banner__btn" :href="feedbackUrl" target="_blank" rel="noopener noreferrer">{{ labels.feedback }}</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

const props = withDefaults(
  defineProps<{
    title: string
    message?: string
    /** 错误详情（复制错误报告用）：code/requestId/traceId/timestamp/serverDetail/appVersion 等 */
    details?: {
      code?: string
      requestId?: string
      traceId?: string
      messageId?: string
      timestamp?: string
      serverDetail?: string
      appVersion?: string
      resetTime?: string
    }
    variant?: 'error' | 'warning' | 'success'
    dismissible?: boolean
    canRetry?: boolean
    docsUrl?: string
    feedbackUrl?: string
  }>(),
  {
    message: '',
    details: () => ({}),
    variant: 'error',
    dismissible: true,
    canRetry: true,
    docsUrl: '',
    feedbackUrl: '',
  },
)

const emit = defineEmits<{ dismiss: []; retry: [] }>()

const labels = computed(() => ({
  close: t('chat.errorBannerClose'),
  copyError: t('chat.errorBannerCopy'),
  retry: t('chat.errorBannerRetry'),
  viewDocs: t('chat.errorBannerDocs'),
  feedback: t('chat.errorBannerFeedback'),
  copied: t('chat.copied'),
}))

const copied = ref(false)
function handleCopy() {
  // 对齐 WorkBuddy：结构化错误报告（用户友好信息 + 技术细节）
  const d = props.details || {}
  const lines = [
    '=== Error Report ===',
    '',
    '--- User-Friendly Information ---',
    `Message: ${props.title}`,
    '',
    '--- Technical Details ---',
    `Error Code: ${d.code || '-'}`,
  ]
  if (d.requestId) lines.push(`Request ID: ${d.requestId}`)
  if (d.traceId) lines.push(`Trace ID: ${d.traceId}`)
  if (d.messageId) lines.push(`Message ID: ${d.messageId}`)
  lines.push(`Timestamp: ${d.timestamp || new Date().toISOString()}`)
  if (d.serverDetail) lines.push(`Server Detail: ${d.serverDetail}`)
  if (d.appVersion) lines.push(`App Version: ${d.appVersion}`)
  if (d.resetTime) {
    lines.push('')
    lines.push(`Reset Time: ${d.resetTime}`)
  }
  const text = lines.join('\n')
  const ok = (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => true)
    .catch(() => {
      // fallback textarea 复制
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        return true
      } catch {
        return false
      } finally {
        document.body.removeChild(ta)
      }
    })
  ok.then((success) => {
    if (success) {
      copied.value = true
      setTimeout(() => { copied.value = false }, 2000)
    }
  })
}
</script>

<style scoped>
.error-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
  border-radius: 8px;
  padding: 10px 14px;
  border: 1px solid;
  animation: eb-slide-in 0.2s ease-out;
}
@keyframes eb-slide-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
.error-banner--error {
  background: var(--error-muted, rgba(248, 113, 113, 0.08));
  border-color: rgba(248, 113, 113, 0.4);
}
.error-banner--warning {
  background: var(--warning-muted, rgba(251, 191, 36, 0.08));
  border-color: rgba(251, 191, 36, 0.4);
}
.error-banner--success {
  background: var(--success-muted, rgba(74, 222, 128, 0.08));
  border-color: rgba(74, 222, 128, 0.4);
}
.error-banner__close {
  position: absolute;
  top: 8px;
  right: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}
.error-banner__close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.error-banner__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 24px;
}
.error-banner__icon {
  display: flex;
  color: var(--error, #f87171);
}
.error-banner--warning .error-banner__icon { color: var(--warning, #fbbf24); }
.error-banner--success .error-banner__icon { color: var(--success, #4ade80); }
.error-banner__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.error-banner__code {
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--text-secondary);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 4px;
}
.error-banner__trace {
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--text-muted);
}
.error-banner__detail {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}
.error-banner__actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.error-banner__btn {
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 5px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.error-banner__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.error-banner__btn--copy.copied {
  color: var(--success, #16a34a);
  border-color: rgba(22, 163, 74, 0.4);
}
</style>
