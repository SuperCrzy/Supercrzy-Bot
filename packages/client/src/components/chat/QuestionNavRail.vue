<template>
  <!-- 历史提问导航条（DeepSeek 式：对话框右侧一列点，每个点 = 本会话一条历史提问；
       hover 点 → 右侧展开完整提问列表（顶部搜索 + 可滚动 + 点击跳转），仅当前会话） -->
  <div
    v-if="slotCount > 0"
    class="question-nav"
    @mouseenter="hoverActive = true"
    @mouseleave="onContainerLeave"
  >
    <div class="question-nav__rail">
      <!-- 垂直细轨道（对齐老板截图：2px 深灰贯穿列表高度） -->
      <div class="qn-track"></div>
      <!-- 白色滑块（当前阅读位置，随滚动上下滑动，对齐截图滚动条 thumb） -->
      <div class="qn-slider" :style="{ top: sliderTop }"></div>
      <!-- 每条提问一个水平短线标记（最多 9 格，>9 条按比例映射；对齐截图 dash 标记） -->
      <button
        v-for="slot in slotList"
        :key="`s${slot}`"
        class="question-nav__dash"
        :class="{ current: slot === activeSlot }"
        :title="slotText(slot)"
        @click="jumpToSlot(slot)"
        @mouseenter="onDotHoverSlot(slot)"
        @mouseleave="hoverIndex = -1"
      >
        <span class="qnd-inner"></span>
      </button>
    </div>

    <!-- 完整提问列表面板：顶部搜索 + 可滚动列表，hover 点展开，点击条目跳转
         （显隐由 CSS hover 控制：面板是容器子元素，鼠标移入面板时容器仍为 hover 态，
           修复"8px 间隙断链 → 面板消失"bug；panel-dismissed 在点击跳转后强制收起） -->
    <div
      class="question-nav__panel"
      :class="{ 'panel-dismissed': panelDismissed }"
    >
      <div class="qnp-search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="qnp-search-icon"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        <input
          v-model="searchQuery"
          class="qnp-search-input"
          :placeholder="searchPlaceholder"
          type="text"
        />
      </div>
      <div ref="panelListRef" class="qnp-list" @scroll="onPanelScroll">
        <div
          v-for="item in filteredQuestions"
          :key="item.id"
          class="qnp-item"
          :class="{ current: item.id === currentQuestionId }"
          :data-id="item.id"
          @click="jumpToQuestion(item.id)"
        >
          <span class="qnp-idx">{{ item.globalIndex + 1 }}</span>
          <div class="qnp-main">
            <span class="qnp-time">{{ formatTime(item.createdAt) }}</span>
            <div class="qnp-text">{{ item.text }}</div>
          </div>
        </div>
        <div v-if="filteredQuestions.length === 0" class="qnp-empty">{{ emptyText }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()
// 双语常量（不依赖 vue-i18n 运行时 messages：composer.t 与新加词条可能不一致，
// 且 i18n key 泄漏时 || 兜底不生效——直接按 locale 判断最稳）
const { locale } = useI18n({ useScope: 'global' })
const isZh = computed(() => String(locale.value).toLowerCase().startsWith('zh'))
const searchPlaceholder = computed(() => (isZh.value ? '搜索历史提问…' : 'Search past questions…'))
const emptyText = computed(() => (isZh.value ? '没有匹配的提问' : 'No matching questions'))

interface QuestionItem {
  id: string
  text: string
  createdAt: string
  globalIndex: number
}

/** 本会话所有 user 提问（仅当前会话——DeepSeek 式导航只针对本窗口） */
const questions = computed<QuestionItem[]>(() => {
  const msgs = chatStore.currentMessages || []
  let gi = 0
  return msgs
    .filter((m) => m.role === 'user')
    .map((m) => {
      let text = ''
      if (typeof m.content === 'string') {
        text = m.content.trim()
      } else if (Array.isArray(m.content)) {
        text = (m.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
          .trim()
      }
      return {
        id: m.id,
        text: text || '(图片/文件)',
        createdAt: m.createdAt,
        globalIndex: gi++,
      }
    })
})

/** 搜索过滤后的提问列表（保留全局序号用于点列对应） */
const searchQuery = ref('')
const filteredQuestions = computed<QuestionItem[]>(() => {
  const kw = searchQuery.value.trim().toLowerCase()
  if (!kw) return questions.value
  return questions.value.filter((q) => q.text.toLowerCase().includes(kw))
})

/** 点列最多 9 格（老板要求：第 10 条提问起不再增点，滑块/高亮按比例映射到全部提问） */
const MAX_SLOTS = 9
const slotCount = computed(() => {
  const n = questions.value.length
  return n > 1 ? Math.min(n, MAX_SLOTS) : 0
})
/** slot 序号 → 对应 questions 下标（>9 时按等距比例映射；≤9 时一一对应） */
function slotToQuestion(slot: number): number {
  const total = questions.value.length
  if (total <= MAX_SLOTS) return slot
  const sc = slotCount.value
  if (sc <= 1) return 0
  return Math.round((slot / (sc - 1)) * (total - 1))
}
/** 当前 activeIndex 所在的 slot（滑块落点 / 高亮点），钳制在 [0, sc-1] 防越界 */
const activeSlot = computed(() => {
  const total = questions.value.length
  if (total <= MAX_SLOTS) return Math.max(0, Math.min(total - 1, activeIndex.value))
  const sc = slotCount.value
  if (sc <= 1) return 0
  const a = Math.max(0, Math.min(total - 1, activeIndex.value))
  return Math.max(0, Math.min(sc - 1, Math.round((a / (total - 1)) * (sc - 1))))
})
/** slot 列表（渲染用） */
const slotList = computed(() => Array.from({ length: slotCount.value }, (_, i) => i))
/** 每个 slot 对应的提问文本（tooltip / title） */
function slotText(slot: number): string {
  return questions.value[slotToQuestion(slot)]?.text || ''
}
/** 滑块位置：activeSlot 在 9 格内滑动（超出比例映射，始终只在这几条内移动） */
const sliderTop = computed(() => {
  const sc = slotCount.value
  if (sc <= 1) return '50%'
  const pct = (activeSlot.value / (sc - 1)) * 100
  return `calc(${pct}% - 6px)`
})

/** 当前视口所在提问（ChatView 传入 activeQuestionIndex → 取 id 高亮当前条目） */
const props = defineProps<{ activeIndex: number }>()
const activeIndex = computed(() => props.activeIndex)
const currentQuestionId = computed(() => questions.value[activeIndex.value]?.id || '')

const hoverActive = ref(false)
const hoverIndex = ref(-1)
/** 面板显隐：CSS hover 驱动（容器 hover 即显示，子面板 hover 链不中断）；
 *  panelDismissed 仅用于点击跳转后强制收起（鼠标仍在点上） */
const panelDismissed = ref(false)

function onContainerLeave() {
  hoverActive.value = false
  hoverIndex.value = -1
}

function onDotHover(i: number) {
  hoverIndex.value = i
  panelDismissed.value = false
  // 标记本次 hoverIndex 来自用户 hover 短线 → watch 才会自动滚动面板
  // （面板自身滚动引起的 hoverIndex 变化不触发自动滚动，防"无限滚动"震荡）
  fromUserHover = true
}

/** hover 点槽 → 映射到实际提问下标 → 联动面板滚动/高亮 */
function onDotHoverSlot(slot: number) {
  onDotHover(slotToQuestion(slot))
}

/** hover 点 → 面板自动滚动到对应条目（居中显示）；仅用户 hover 触发，面板自身滚动不反哺 */
const panelListRef = ref<HTMLElement | null>(null)
let suppressScroll = false
let fromUserHover = false
watch(hoverIndex, async (i) => {
  if (i < 0) return
  if (!fromUserHover) return // 面板滚动引起的 hoverIndex 变化：只同步高亮，不自动滚动
  fromUserHover = false
  const q = questions.value[i]
  const list = panelListRef.value
  if (!q || !list) return
  await nextTick()
  const el = list.querySelector<HTMLElement>(`.qnp-item[data-id="${q.id}"]`)
  if (!el) return
  suppressScroll = true
  list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2
  requestAnimationFrame(() => {
    suppressScroll = false
  })
})

/** 面板内滚动 → 顶部最近条目反推 hoverIndex（点列高亮同步） */
function onPanelScroll() {
  if (suppressScroll) return
  const list = panelListRef.value
  if (!list) return
  let bestId = ''
  let bestDist = Infinity
  list.querySelectorAll<HTMLElement>('.qnp-item').forEach((el) => {
    const dist = Math.abs(el.offsetTop - list.scrollTop)
    if (dist < bestDist) {
      bestDist = dist
      bestId = el.dataset.id || ''
    }
  })
  if (!bestId) return
  const gi = questions.value.findIndex((q) => q.id === bestId)
  if (gi >= 0) hoverIndex.value = gi
}

function scrollToMessage(id: string) {
  const el = document.querySelector(`[data-msg-id="${id}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function jumpTo(i: number) {
  const id = questions.value[i]?.id
  if (!id) return
  scrollToMessage(id)
  panelDismissed.value = true
}

/** 点击点槽 → 映射到实际提问下标 → 跳转 */
function jumpToSlot(slot: number) {
  jumpTo(slotToQuestion(slot))
}

function jumpToQuestion(id: string) {
  scrollToMessage(id)
  panelDismissed.value = true
}

function formatTime(d: string): string {
  if (!d) return ''
  const date = new Date(d)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<style scoped>
/* 固定在对话区侧边：父容器是 chat-container（position: relative、不滚动），
   绝对定位天然不随消息滚动——这就是"侧边固定"的关键；
   若放在 messages-area（滚动容器）内，绝对定位会跟着内容一起滚 */
.question-nav {
  position: absolute;
  top: 46%;
  right: 6px;
  transform: translateY(-50%);
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
}
.question-nav__rail {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px; /* 短线间距（对齐截图行距节奏） */
  padding: 10px 0;
  pointer-events: auto;
  max-height: 70vh;
  overflow: visible; /* 滑块/轨道定位在 rail 内 */
}
/* 垂直细轨道（对齐截图：2px 深灰贯穿列表高度） */
.qn-track {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 2px;
  border-radius: 1px;
  background: var(--border-input, rgba(127, 127, 127, 0.25));
  opacity: 0.7;
  pointer-events: none;
}
/* 白色滑块（滚动条 thumb，当前阅读位置，随滚动滑动） */
.qn-slider {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 12px;
  border-radius: 2px;
  background: var(--text-primary, #fff);
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.3);
  transition: top 0.15s ease-out;
  pointer-events: none;
  z-index: 2;
}
/* 每条提问一个水平短线标记（对齐截图 dash） */
.question-nav__dash {
  position: relative;
  z-index: 1;
  width: 16px;
  height: 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.qnd-inner {
  width: 5px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--text-muted);
  opacity: 0.6;
  transition: all 0.15s;
}
.question-nav__dash:hover .qnd-inner,
.question-nav__dash.current .qnd-inner {
  background: var(--accent);
  opacity: 1;
  width: 8px;
}

/* ===== 完整提问列表面板 ===== */
.question-nav__panel {
  position: absolute;
  right: 100%; /* 紧贴 rail，消除 8px 间隙（hover 断链死循环根因） */
  top: 50%;
  transform: translateY(-50%);
  width: 300px;
  max-height: 60vh;
  display: none;
  flex-direction: column;
  background: var(--bg-elevated, var(--bg-secondary));
  border: 1px solid var(--border-input);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  pointer-events: auto;
  z-index: 41;
}
/* CSS hover 驱动显隐（修复 hover 间隙断链 bug）：容器 hover 或子面板 hover 时显示；
   面板是容器子元素，鼠标移入面板容器仍为 hover 态，跨 8px 间隙不消失 */
.question-nav:hover .question-nav__panel,
.question-nav__panel:hover {
  display: flex;
}
/* 点击跳转后强制收起（鼠标仍悬停在点上）；需更高特异性覆盖上面的 hover 规则 */
.question-nav:hover .question-nav__panel.panel-dismissed,
.question-nav__panel.panel-dismissed:hover,
.question-nav__panel.panel-dismissed {
  display: none;
}
.qnp-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 0.5px solid var(--border-color);
  background: var(--bg-secondary);
}
.qnp-search-icon {
  flex: none;
  color: var(--text-muted);
}
.qnp-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--text-primary);
}
.qnp-search-input::placeholder {
  color: var(--text-muted);
}
.qnp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
  max-height: calc(60vh - 38px);
}
.qnp-item {
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s;
}
.qnp-item:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}
.qnp-item.current {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.qnp-idx {
  flex: none;
  width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-hover, rgba(128, 128, 128, 0.1));
  border-radius: 50%;
  margin-top: 1px;
}
.qnp-main {
  min-width: 0;
  flex: 1;
}
.qnp-time {
  display: block;
  font-size: 10.5px;
  color: var(--text-muted);
  margin-bottom: 2px;
}
.qnp-text {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.qnp-empty {
  padding: 22px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
