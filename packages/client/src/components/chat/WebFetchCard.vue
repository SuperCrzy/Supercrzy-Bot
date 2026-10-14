<template>
  <div class="web-fetch-card" :class="{ executing: isExecuting }">
    <!-- header 一行（主流实现 WebFetchCompactRenderer 同款：icon + action + title），执行中不展开正文 -->
    <div class="wf-header" @click="toggle">
      <svg v-if="!isExecuting" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="wf-icon"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <span class="wf-action" :class="{ 'wf-action--loading': isExecuting }">{{ actionText }}</span>
      <span class="wf-title" :title="fullUrl">{{ displayTitle }}</span>
      <span v-if="!isExecuting" class="wf-toggle">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </div>
    <!-- 展开态：结构化元信息 + 限高内容（Title / URL / Published Time 三级元数据） -->
    <div v-if="expanded && !isExecuting" class="wf-body">
      <div v-if="pageTitle" class="wf-meta-row">
        <span class="wf-meta-label">{{ $t('chatui.webFetchTitle') }}</span>
        <span class="wf-meta-value">{{ pageTitle }}</span>
      </div>
      <div v-if="pageUrl" class="wf-meta-row">
        <span class="wf-meta-label">{{ $t('chatui.webFetchUrl') }}</span>
        <span class="wf-meta-value wf-meta-url">{{ pageUrl }}</span>
      </div>
      <div v-if="publishedTime" class="wf-meta-row">
        <span class="wf-meta-label">{{ $t('chatui.webFetchPublished') }}</span>
        <span class="wf-meta-value">{{ publishedTime }}</span>
      </div>
      <div v-if="displayContent" class="wf-content">{{ visibleContent }}</div>
      <button v-if="isContentLong" class="wf-expand" @click.stop="contentExpanded = !contentExpanded">
        {{ contentExpanded ? $t('chatui.webFetchCollapse') : $t('chatui.webFetchShowMore', { n: contentLength }) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * WebFetch 专属卡片（主流实现 WebFetchCompactRenderer 同款）：
 * - 一行 header：icon + 状态词（生成摘要/网页获取）+ 标题（真实标题→域名→兜底三级语义）
 * - 执行中不展开正文（并行 N 张 = N 行，不占屏）
 * - 展开态：Title / URL / Published Time 元信息 + 内容限高 240px 滚动
 */
const { t } = useI18n({ useScope: 'global' })

const props = withDefaults(defineProps<{
  args?: string
  result?: string
  status?: string
}>(), { args: '', result: '', status: 'done' })

const expanded = ref(false)
const contentExpanded = ref(false)

/** 执行中集合（主流实现 5 态 running 集合，我们前端对齐） */
const isExecuting = computed(() => ['pending', 'approved', 'running', 'stream_executing'].includes(props.status))

/** 状态词联动：执行中 → "生成摘要"，完成 → "网页获取" */
const actionText = computed(() => (isExecuting.value ? t('chatui.webSummarizing') : t('chatui.webFetch')))

/** 请求 URL（args.url） */
const fullUrl = computed(() => {
  try {
    return String(JSON.parse(props.args || '{}').url || '')
  } catch {
    return ''
  }
})

interface WfData { title: string; url: string; publishedTime: string; content: string }

/** 解析 result：新版 JSON（{title,url,publishedTime,content}）+ 兼容旧文本格式（"网页内容 (前N字符):..."） */
const data = computed<WfData>(() => {
  const r = props.result || ''
  // 新版：结构化 JSON
  try {
    const d = JSON.parse(r)
    if (d && typeof d === 'object' && (d.content !== undefined || d.title !== undefined)) {
      return {
        title: String(d.title || ''),
        url: String(d.url || d.sourceUrl || ''),
        publishedTime: String(d.publishedTime || d.published || ''),
        content: String(d.content || ''),
      }
    }
  } catch {}
  // 旧版：文本格式（"网页内容 (前6000字符):\n..." 或 "网页内容:\n..."）
  const m = r.match(/网页内容(?:\s*\(前\d+字符\))?:\n?([\s\S]*)/)
  const content = m ? m[1].trim() : r
  // 尝试解析 Jina 头部（Title:/URL Source:/Published Time:）
  let title = ''
  let url = ''
  let published = ''
  const lines = content.split('\n')
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const l = lines[i]
    if (l.startsWith('Title:')) title = l.slice(6).trim()
    else if (l.startsWith('URL Source:')) url = l.slice(11).trim()
    else if (l.startsWith('Published Time:')) published = l.slice(15).trim()
    else if (l.startsWith('Markdown Content:')) { lines.splice(0, i + 1); break }
  }
  return { title, url, publishedTime: published, content: lines.join('\n').trim() }
})

const pageTitle = computed(() => data.value.title)
const pageUrl = computed(() => data.value.url || fullUrl.value)
const publishedTime = computed(() => data.value.publishedTime)

/** 标题三级语义回落：真实标题 → 域名 → i18n 兜底（主流实现 displayTitle 同款） */
const displayTitle = computed(() => {
  const t0 = pageTitle.value.trim()
  if (t0) return t0.length > 60 ? t0.slice(0, 60) + '…' : t0
  const d = domainOf(fullUrl.value)
  if (d) return d
  return t('chatui.webFetchTitle')
})

/** 域名提取（https://supercrzy.com/craze → supercrzy.com/craze） */
function domainOf(u: string): string {
  if (!u) return ''
  const m = u.replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  return m || ''
}

const contentLength = computed(() => data.value.content.length)
const displayContent = computed(() => data.value.content)
const isContentLong = computed(() => contentLength.value > 2000)
/** 内容展示：默认 2000 字符截断 + 限高 240px 滚动 */
const visibleContent = computed(() => (contentExpanded.value ? data.value.content : data.value.content.slice(0, 2000)))

function toggle() {
  if (!isExecuting.value) expanded.value = !expanded.value
}
</script>

<style scoped>
.web-fetch-card {
  margin: 4px 0;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
}
.web-fetch-card.executing { border-left-color: var(--accent, #6366f1); }
.wf-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  min-height: 26px;
}
.wf-header:hover { background: var(--bg-hover); }
.wf-icon { color: var(--text-muted); flex-shrink: 0; }
.wf-action { font-size: 12px; color: var(--text-secondary); flex-shrink: 0; }
.wf-action--loading { color: var(--accent, #6366f1); }
.wf-title {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.wf-toggle { margin-left: auto; display: flex; flex-shrink: 0; color: var(--text-muted); }
.wf-toggle svg { transition: transform var(--duration-fast, 0.15s); }
.wf-toggle svg.rotated { transform: rotate(180deg); }
.wf-body { padding: 8px 10px; border-top: 1px solid var(--border-color); }
.wf-meta-row { display: flex; gap: 6px; font-size: 11px; margin-bottom: 4px; }
.wf-meta-label { color: var(--text-muted); flex-shrink: 0; min-width: 56px; }
.wf-meta-value { color: var(--text-secondary); word-break: break-all; }
.wf-meta-url { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; }
.wf-content {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}
.wf-expand {
  margin-top: 6px;
  font-size: 11px;
  color: var(--accent, #6366f1);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.wf-expand:hover { text-decoration: underline; }
</style>
