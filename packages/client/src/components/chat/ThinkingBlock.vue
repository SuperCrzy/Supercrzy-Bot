<template>
  <div class="thinking-block" :class="{ completed: isCompleted }">
    <!-- 未完成：脉动指示 + 深度思考标题 + 推理实时流式（进行中不折叠，展开可见——老板 2026-08-21） -->
    <template v-if="!isCompleted">
      <div class="thinking-indicator">
        <div class="thinking-pulse active"></div>
      </div>
      <div class="thinking-content">
        <div class="thinking-header">
          <span v-if="turn" class="thinking-turn">Turn {{ turn }}</span>
          <span class="thinking-message">{{ $t('chatui.deepThinking') }}</span>
        </div>
        <!-- 思考进行中：实时流式显示推理内容（markdown 渲染，代码框整洁；限高滚动防刷屏；自动跟随最新一行） -->
        <div v-if="reasoning" ref="reasoningEl" class="thinking-reasoning live" @scroll="onReasoningScroll" v-html="reasoningHtml"></div>
      </div>
    </template>
    <!-- 已完成：一行"深度思考"标题，点击展开/收起推理（对齐 WorkBuddy ReasoningRenderer） -->
    <template v-else>
      <div class="thinking-done-indicator"></div>
      <div class="thinking-content">
        <div class="thinking-header thinking-header-clickable" :class="{ open: reasoningOpen }" @click="toggleReasoning">
          <span v-if="turn" class="thinking-turn">Turn {{ turn }}</span>
          <span class="thinking-done-label">{{ $t('chatui.deepThinking') }}</span>
          <span v-if="reasoningFirstLine" class="thinking-summary">{{ reasoningFirstLine }}</span>
          <svg v-if="reasoning" class="thinking-arrow" :class="{ open: reasoningOpen }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div v-if="reasoning && reasoningOpen" class="thinking-reasoning" v-html="reasoningHtml"></div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'

// ============ 推理内容 markdown 渲染（对齐 WorkBuddy reasoning theme：代码显示成整洁代码框，不是纯文本） ============
const reasoningMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {}
    }
    return `<pre class="hljs"><code>${reasoningMd.utils.escapeHtml(str)}</code></pre>`
  },
})

const props = withDefaults(defineProps<{
  message: string
  turn?: number
  completed?: boolean
  /** 真实推理内容（thinking_chunk 累积） */
  reasoning?: string
}>(), {
  turn: 0,
  completed: false,
  reasoning: '',
})

const reasoningOpen = ref(false)
const isCompleted = computed(() => props.completed)

// ============ 推理容器自动跟随最新（思考流式时滚到底部，用户上滑则暂停跟随） ============
const reasoningEl = ref<HTMLElement>()
let stickReasoningBottom = true

/** 推理内容增长 → 自动滚到底部（用户没上滑时），最新思考始终可见不用手滑 */
watch(
  () => props.reasoning,
  () => {
    if (!stickReasoningBottom) return
    nextTick(() => {
      const el = reasoningEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

/** 用户手动滚动：上滑查看历史时暂停跟随；回到底部恢复 */
function onReasoningScroll(e: Event) {
  const el = e.target as HTMLElement
  stickReasoningBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
}

/** 点击"深度思考"标题：展开/收起推理内容（对齐 WorkBuddy 点击 header 切换） */
function toggleReasoning() {
  if (props.reasoning) reasoningOpen.value = !reasoningOpen.value
}

/** 完成态折叠摘要（对齐 Harness ReasoningRow）：显示推理"第一行"作为主题摘要，截断防溢出 */
const reasoningFirstLine = computed(() => {
  const text = props.reasoning || ''
  const line = text.trim().split('\n')[0] || ''
  return line.slice(0, 42)
})

/**
 * 节流视觉更新（对齐 Harness useThrottledVisualUpdate，2026-08-23）：
 * 流式思考每 chunk 都触发 markdown+hljs 重渲染开销大 → rAF 合并到动画帧，完成时强制刷最后一帧
 */
const throttledReasoning = ref('')
let reasoningRaf: number | null = null
watch(
  () => props.reasoning,
  (val) => {
    if (reasoningRaf !== null) return  // 本帧已调度，等待下一帧合并
    reasoningRaf = requestAnimationFrame(() => {
      reasoningRaf = null
      throttledReasoning.value = props.reasoning || ''
    })
  },
)
watch(
  () => props.completed,
  (done) => {
    if (done) {
      if (reasoningRaf !== null) { cancelAnimationFrame(reasoningRaf); reasoningRaf = null }
      throttledReasoning.value = props.reasoning || ''  // 完成：立即渲染完整推理
    }
  },
)
onUnmounted(() => { if (reasoningRaf !== null) cancelAnimationFrame(reasoningRaf) })

/** 思考内容过滤：仅剥离裸 SVG 草稿（正文的 SVG 会提取成图卡片，思考里的草稿不应裸露）；代码块保留 → markdown 渲染成代码框（对齐 WorkBuddy reasoning 代码框整洁展示，老板 2026-08-21） */
const filteredReasoning = computed(() => cleanReasoning(throttledReasoning.value))

/** 渲染后 HTML：cleanReasoning 剥 SVG 后 markdown 渲染（代码块 → hljs 高亮代码框） */
const reasoningHtml = computed(() => reasoningMd.render(filteredReasoning.value))

/** 剥离推理内容中的裸 SVG 草稿（模型思考时常草拟 SVG——过程草稿，不应裸露展示） */
function cleanReasoning(text: string | undefined): string {
  if (!text) return ''
  let s = text
  // 裸 SVG（未包在代码块里）兜底——代码块 ``` 里的 SVG 文本保留（渲染成代码框，WorkBuddy 同款）
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '[SVG 图草稿]')
  return s
}
</script>

<style scoped>
.thinking-block {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  margin: 2px 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  transition: opacity var(--duration-fast) var(--ease-out);
}

.thinking-block.completed {
  opacity: 0.55;
  padding: 2px 0;
}
.thinking-block.completed .thinking-header {
  min-height: 20px;
}

/* 完成态：小圆点替代脉动动画 */
.thinking-done-indicator {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.thinking-done-label {
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.thinking-summary {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin-left: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
  opacity: 0.8;
}

/* Pulse indicator */
.thinking-indicator {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 4px;
  position: relative;
}

.thinking-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  position: relative;
}

.thinking-pulse.active::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.3;
  animation: pulse-ring 1.5s ease-out infinite;
}

.thinking-pulse.active::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.1;
  animation: pulse-ring 1.5s ease-out infinite 0.3s;
}

@keyframes pulse-ring {
  0% { transform: scale(0.8); opacity: 0.4; }
  100% { transform: scale(2); opacity: 0; }
}

.thinking-block.completed .thinking-pulse {
  background: var(--text-muted);
}

/* Content */
.thinking-content {
  flex: 1;
  min-width: 0;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 完成态"深度思考"标题整行可点击（对齐 WorkBuddy ReasoningRenderer 点击 header 展开） */
.thinking-header-clickable {
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
  padding: 1px 4px 1px 2px;
  margin-left: -2px;
  transition: background var(--duration-fast);
}
.thinking-header-clickable:hover {
  background: var(--bg-tertiary);
}

.thinking-arrow {
  color: var(--text-muted);
  transition: transform var(--duration-fast);
  flex-shrink: 0;
}
.thinking-arrow.open {
  transform: rotate(180deg);
}

.thinking-turn {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-muted);
  color: var(--accent);
  flex-shrink: 0;
}

.dark .thinking-turn {
  background: rgba(129, 140, 248, 0.15);
  color: var(--accent);
}

.thinking-block.completed .thinking-turn {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.thinking-message {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.thinking-reasoning {
  margin-top: 6px;
  padding: 8px 10px;
  border-left: 2px solid var(--accent-muted);
  background: var(--bg-tertiary);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}
/* 推理内 markdown 元素（对齐 WorkBuddy reasoning theme：弱化紧凑、代码框整洁） */
.thinking-reasoning :deep(p) { margin: 0 0 6px; }
.thinking-reasoning :deep(p:last-child) { margin-bottom: 0; }
.thinking-reasoning :deep(ul), .thinking-reasoning :deep(ol) { margin: 0 0 6px; padding-left: 18px; }
.thinking-reasoning :deep(li) { margin: 1px 0; }
.thinking-reasoning :deep(code:not(pre code)) {
  background: rgba(128, 128, 128, 0.14);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.thinking-reasoning :deep(pre.hljs) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-code, rgba(0, 0, 0, 0.06));
  overflow-x: auto;
  font-size: 11.5px;
  line-height: 1.5;
}
.thinking-reasoning :deep(pre.hljs code) {
  background: none;
  padding: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: pre;
}
.thinking-reasoning :deep(a) { color: var(--accent); }
.thinking-reasoning :deep(strong) { color: var(--text-primary); }
/* 流式中（live）：推理实时流式可见（不折叠）；限高 360px 滚动，防止超长推理把页面撑爆（老板 2026-08-21：思考时可展开） */
.thinking-reasoning.live {
  border-left-color: var(--accent);
  opacity: 0.92;
  max-height: 360px;
  overflow-y: auto;
}
</style>

<!-- 推理代码框 hljs token 配色（全局：ThinkingBlock scoped 不覆盖子块渲染；WorkBuddy one-light/one-dark 双主题同款） -->
<style>
/* 浅色模式（默认）：one-light 深色系 token */
.thinking-reasoning .hljs {
  color: #383a42;
}
.thinking-reasoning .hljs-keyword,
.thinking-reasoning .hljs-selector-tag,
.thinking-reasoning .hljs-literal,
.thinking-reasoning .hljs-section,
.thinking-reasoning .hljs-link {
  color: #a626a4;
}
.thinking-reasoning .hljs-string,
.thinking-reasoning .hljs-title,
.thinking-reasoning .hljs-name,
.thinking-reasoning .hljs-type,
.thinking-reasoning .hljs-attribute,
.thinking-reasoning .hljs-symbol,
.thinking-reasoning .hljs-bullet,
.thinking-reasoning .hljs-addition,
.thinking-reasoning .hljs-variable,
.thinking-reasoning .hljs-template-tag,
.thinking-reasoning .hljs-template-variable {
  color: #50a14f;
}
.thinking-reasoning .hljs-comment,
.thinking-reasoning .hljs-quote,
.thinking-reasoning .hljs-deletion {
  color: #a0a1a7;
  font-style: italic;
}
.thinking-reasoning .hljs-number,
.thinking-reasoning .hljs-meta {
  color: #986801;
}
.thinking-reasoning .hljs-built_in,
.thinking-reasoning .hljs-builtin-name,
.thinking-reasoning .hljs-params {
  color: #c18401;
}
.thinking-reasoning .hljs-attr,
.thinking-reasoning .hljs-attribute {
  color: #986801;
}
.thinking-reasoning .hljs-function .hljs-title,
.thinking-reasoning .hljs-class .hljs-title {
  color: #4078f2;
}
/* 深色模式：one-dark 亮色系 token */
.dark .thinking-reasoning .hljs {
  color: #abb2bf;
}
.dark .thinking-reasoning .hljs-keyword,
.dark .thinking-reasoning .hljs-selector-tag,
.dark .thinking-reasoning .hljs-literal,
.dark .thinking-reasoning .hljs-section,
.dark .thinking-reasoning .hljs-link {
  color: #c678dd;
}
.dark .thinking-reasoning .hljs-string,
.dark .thinking-reasoning .hljs-title,
.dark .thinking-reasoning .hljs-name,
.dark .thinking-reasoning .hljs-type,
.dark .thinking-reasoning .hljs-attribute,
.dark .thinking-reasoning .hljs-symbol,
.dark .thinking-reasoning .hljs-bullet,
.dark .thinking-reasoning .hljs-addition,
.dark .thinking-reasoning .hljs-variable,
.dark .thinking-reasoning .hljs-template-tag,
.dark .thinking-reasoning .hljs-template-variable {
  color: #98c379;
}
.dark .thinking-reasoning .hljs-comment,
.dark .thinking-reasoning .hljs-quote,
.dark .thinking-reasoning .hljs-deletion {
  color: #7f848e;
  font-style: italic;
}
.dark .thinking-reasoning .hljs-number,
.dark .thinking-reasoning .hljs-meta {
  color: #d19a66;
}
.dark .thinking-reasoning .hljs-built_in,
.dark .thinking-reasoning .hljs-builtin-name,
.dark .thinking-reasoning .hljs-params {
  color: #e5c07b;
}
.dark .thinking-reasoning .hljs-attr,
.dark .thinking-reasoning .hljs-attribute {
  color: #d19a66;
}
.dark .thinking-reasoning .hljs-function .hljs-title,
.dark .thinking-reasoning .hljs-class .hljs-title {
  color: #61afef;
}
</style>
