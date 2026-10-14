<template>
  <!-- 无消息（欢迎页/空会话）不渲染；有对话内容才显示（0% 也显示，可点击查看窗口信息） -->
  <div v-if="hasMessages" ref="wrapRef" class="ctx-ring-wrap" @mouseenter="hover = true" @mouseleave="hover = false">
    <!-- SVG 圆环（20px，顶部会话栏比例协调） -->
    <div class="ctx-ring" @click="showDetail = !showDetail" :title="tipLabel">
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" stroke-width="2.5" />
        <circle
          cx="10" cy="10" r="8" fill="none"
          :stroke="ringColor" stroke-width="2.5" stroke-linecap="round"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
          transform="rotate(-90 10 10)"
          style="transition: stroke-dashoffset .5s, stroke .3s"
        />
        <text x="10" y="10" text-anchor="middle" dominant-baseline="central" fill="currentColor" font-size="8" font-weight="600">
          {{ pct }}
        </text>
      </svg>
      <!-- 压缩发生时的短暂标记 -->
      <transition name="fade">
        <span v-if="compressedFlash" class="ctx-flash">{{ $t('chat.ctxCompressed') }}</span>
      </transition>
    </div>

    <!-- hover tooltip（顶部栏下方弹出，不遮挡横栏内容） -->
    <div v-if="hover && !showDetail" class="ctx-tip">
      {{ tipLabel }} · {{ usedK }}K / {{ windowK }}K
      <span v-if="lastCompressedAt" class="ctx-tip-compress">{{ $t('chat.ctxLastCompress') }} {{ lastCompressedAt }}</span>
    </div>

    <!-- 点击详情 -->
    <div v-if="showDetail" class="ctx-detail">
      <div class="ctx-detail-title">{{ $t('chat.ctxDetailTitle') }}</div>
      <!-- 分类用量（对齐主流实现 usage-by-category-popover） -->
      <div v-if="catTokens.total > 0" class="ctx-cats">
        <div class="ctx-cat">
          <span class="ctx-cat-label"><span class="dot" style="background:#378ADD" />{{ $t('chat.ctxCatUser') }}</span>
          <span class="ctx-cat-val">{{ catTokens.user }}K</span>
          <div class="ctx-cat-bar"><span class="ctx-cat-fill" style="background:#378ADD" :style="{ width: catPct(catTokens.user) + '%' }" /></div>
        </div>
        <div class="ctx-cat">
          <span class="ctx-cat-label"><span class="dot" style="background:#8B5CF6" />{{ $t('chat.ctxCatAssistant') }}</span>
          <span class="ctx-cat-val">{{ catTokens.assistant }}K</span>
          <div class="ctx-cat-bar"><span class="ctx-cat-fill" style="background:#8B5CF6" :style="{ width: catPct(catTokens.assistant) + '%' }" /></div>
        </div>
        <div class="ctx-cat">
          <span class="ctx-cat-label"><span class="dot" style="background:#06B6D4" />{{ $t('chat.ctxCatTool') }}</span>
          <span class="ctx-cat-val">{{ catTokens.tool }}K</span>
          <div class="ctx-cat-bar"><span class="ctx-cat-fill" style="background:#06B6D4" :style="{ width: catPct(catTokens.tool) + '%' }" /></div>
        </div>
      </div>
      <div class="ctx-detail-row"><span class="dot" style="background:#16A34A" />{{ $t('chat.ctxSafe') }}</div>
      <div class="ctx-detail-row"><span class="dot" style="background:#F59E0B" />{{ $t('chat.ctxWarn') }}</div>
      <div class="ctx-detail-row"><span class="dot" style="background:#EF4444" />{{ $t('chat.ctxDanger') }}</div>
      <div v-if="lastCompressedAt" class="ctx-detail-last">{{ $t('chat.ctxLastCompress') }} {{ lastCompressedAt }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'

const { t } = useI18n({ useScope: 'global' })
const appStore = useAppStore()
const chatStore = useChatStore()

// 欢迎页/空会话（无消息）不显示环形：有对话内容才显示（即使 usage 为 0 也显示，可点击看窗口信息）
const hasMessages = computed(() => (chatStore.currentMessages?.length || 0) > 0)

const wrapRef = ref<HTMLElement | null>(null)
const hover = ref(false)
const showDetail = ref(false)
const compressedFlash = ref(false)

// 点击组件外部 → 收回详情弹窗（点击自身由模板切换，不冲突）
function onDocClick(e: MouseEvent) {
  if (wrapRef.value && !wrapRef.value.contains(e.target as Node)) {
    showDetail.value = false
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

// 数据源：appStore（ChatView 的 SSE 事件写入，顶部横栏/移动 header 共享）
// 已用 tokens：优先 usage 事件真实值（appStore.ctxUsed）；为 0 时（刷新页面/历史会话未发新请求）回退本地估算——
// catTokens.total 是字符量×0.6 的 K 值，转回 tokens 需 ×1024
const usedTokens = computed(() => {
  if (appStore.ctxUsed > 0) return appStore.ctxUsed
  return Math.round(catTokens.value.total * 1024)
})
const windowTokens = computed(() => appStore.ctxWindow)

// ---- 计算 ----
const pctNum = computed(() => {
  if (windowTokens.value <= 0) return 0
  return Math.min(100, Math.round((usedTokens.value / windowTokens.value) * 100))
})
const pct = computed(() => String(pctNum.value))
const circumference = computed(() => 2 * Math.PI * 8)
const dashOffset = computed(() => circumference.value * (1 - pctNum.value / 100))

// 三色分级（对齐压缩阈值：55% 触发 / 80% 危险）
const ringColor = computed(() => {
  const p = pctNum.value
  if (p >= 80) return '#E24B4A'
  if (p >= 55) return '#EF9F27'
  return '#378ADD'
})

const usedK = computed(() => Math.round(usedTokens.value / 1024))
const windowK = computed(() => Math.round(windowTokens.value / 1024))
// 注意：$t 的插值参数必须传数值（不能传 computed ref，否则 i18n 序列化 ref 触发 circular JSON → 渲染崩溃白屏）
const tipLabel = computed(() => t('chat.ctxUsage', { pct: pctNum.value }))

// ---- 分类用量（对齐主流实现 usage-by-category-popover：用户/AI 正文/工具过程 各占多少，前端估算 0.6 token/字符） ----
const catTokens = computed(() => {
  let user = 0
  let assistant = 0
  let tool = 0
  for (const m of chatStore.currentMessages || []) {
    let content = ''
    if (typeof m.content === 'string') content = m.content
    else if (Array.isArray(m.content)) content = (m.content as any[]).map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
    const len = content.length
    if (m.role === 'user') user += len
    else if (m.role === 'assistant') assistant += len
    for (const n of m.flow || []) {
      if (n.kind === 'tool') {
        tool += (n.tool.arguments || '').length + (n.tool.result || '').length + (n.tool.streamOutput || '').length
      }
    }
  }
  const toK = (v: number) => Math.round(((v * 0.6) / 1024) * 10) / 10
  const total = toK(user) + toK(assistant) + toK(tool)
  return { user: toK(user), assistant: toK(assistant), tool: toK(tool), total }
})
/** 分类条宽度（相对已用总量） */
const catPct = (v: number) => (catTokens.value.total > 0 ? Math.max(2, Math.round((v / catTokens.value.total) * 100)) : 0)

const lastCompressedAt = computed(() => {
  if (!appStore.ctxCompressedAt) return ''
  const d = new Date(appStore.ctxCompressedAt)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
})

// 压缩发生 → 闪烁标记
watch(() => appStore.ctxCompressedAt, (v, old) => {
  if (v && v !== old) {
    compressedFlash.value = true
    setTimeout(() => { compressedFlash.value = false }, 2000)
  }
})
</script>

<style scoped>
.ctx-ring-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  /* App 横栏 workspace-zone 是 pointer-events:none（整行可拖拽），这里恢复点击 */
  pointer-events: auto;
  /* 与相邻控件（模型选择/操作按钮）拉开间距 */
  margin-left: 8px;
  color: var(--text-secondary);
}
.ctx-ring { display: inline-flex; align-items: center; color: inherit; position: relative; }
.ctx-flash {
  position: absolute; top: -20px; left: 50%; transform: translateX(-50%);
  font-size: 10px; color: var(--warning, #EF9F27); white-space: nowrap;
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
}
.fade-enter-active, .fade-leave-active { transition: opacity .3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.ctx-tip {
  /* 顶部会话栏下方弹出 */
  position: absolute; top: 26px; left: 50%; transform: translateX(-50%);
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 8px; font-size: 11px; color: var(--text-secondary); white-space: nowrap; z-index: 60;
  pointer-events: none;
}
.ctx-tip-compress { color: var(--text-muted); margin-left: 4px; }

.ctx-detail {
  position: absolute; top: 26px; left: 50%; transform: translateX(-50%);
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; font-size: 11px; color: var(--text-secondary); white-space: nowrap; z-index: 60;
  display: flex; flex-direction: column; gap: 4px;
}
.ctx-detail-title { font-weight: 500; color: var(--text-primary); margin-bottom: 2px; }
/* 分类用量（对齐主流实现 usage-by-category-popover） */
.ctx-cats { display: flex; flex-direction: column; gap: 3px; margin-bottom: 2px; }
.ctx-cat { display: flex; align-items: center; gap: 6px; }
.ctx-cat-label { display: inline-flex; align-items: center; gap: 4px; min-width: 68px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.ctx-cat-val { width: 40px; text-align: right; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.ctx-cat-bar { flex: 1; min-width: 40px; height: 5px; border-radius: 3px; background: var(--bg-tertiary, rgba(128,128,128,.15)); overflow: hidden; }
.ctx-cat-fill { display: block; height: 100%; border-radius: 3px; transition: width .3s; }
.ctx-detail-row { display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 4px; display: inline-block; }
.ctx-detail-last { margin-top: 3px; color: var(--text-muted); }
</style>
