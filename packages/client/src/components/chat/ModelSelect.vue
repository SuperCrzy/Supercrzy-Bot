<script setup lang="ts">
/**
 * ModelSelect — 自适应宽度的模型选择器（2026-10-18）
 *
 * 为什么不用原生 <select>：
 *   原生 select 的宽度由**最长的 option** 决定，与当前选中项无关。
 *   模型列表里 "V3.2 Speciale (DeepSeek)" 比 "V4 Flash (DeepSeek)" 长 7 个字符，
 *   而 CSS 又有 max-width: 180px ⇒ 选中短项时文字后留出 60-70px 空白。
 *   这是原生控件的固有行为，CSS 无法消除（宽度必须容纳所有选项）。
 *
 * 本组件的行为（老板要求：「按照名称自动显示长度，只要后面的间距固定」）：
 *   · 触发器是 inline-flex，宽度 = 当前文字宽度 + 固定内边距，**不设 max-width**
 *   · 文字与箭头之间是固定 gap，不随选项长度变化
 *   · 下拉面板宽度可超出触发器（面板按内容自适应，不与触发器同宽）
 *
 * 视觉沿用原来的 .input-model-select 样式变量，保证三处调用点一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

type FlatOption = { label: string; value: string }
type GroupOption = { type: 'group'; label: string; key: string; children: FlatOption[] }
type Option = FlatOption | GroupOption

const props = defineProps<{
  modelValue: string
  options: Option[]
  title?: string
  /** 无选中项时的占位文字 */
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const isGroup = (o: Option): o is GroupOption => 'type' in o

/** 当前选中项的文字（找不到则回退到 placeholder / 原值） */
const currentLabel = computed(() => {
  for (const opt of props.options) {
    if (isGroup(opt)) {
      const hit = opt.children.find((c) => c.value === props.modelValue)
      if (hit) return hit.label
    } else if (opt.value === props.modelValue) {
      return opt.label
    }
  }
  return props.placeholder || props.modelValue || ''
})

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

/** 面板定位：贴住触发器左下，宽度按内容自适应（min = 触发器宽度） */
async function syncPanelPosition() {
  await nextTick()
  const el = triggerRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // 下方空间不足则向上弹
  const spaceBelow = window.innerHeight - r.bottom
  const estHeight = Math.min(320, props.options.length * 32 + 16)
  const above = spaceBelow < estHeight + 12 && r.top > spaceBelow
  panelStyle.value = {
    left: `${Math.round(r.left)}px`,
    minWidth: `${Math.round(r.width)}px`,
    ...(above
      ? { bottom: `${Math.round(window.innerHeight - r.top + 6)}px` }
      : { top: `${Math.round(r.bottom + 6)}px` }),
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) syncPanelPosition()
}

function pick(v: string) {
  emit('update:modelValue', v)
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (!rootRef.value) return
  if (!rootRef.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
function onScrollOrResize() {
  if (open.value) syncPanelPosition()
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onScrollOrResize)
  window.addEventListener('scroll', onScrollOrResize, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onScrollOrResize)
  window.removeEventListener('scroll', onScrollOrResize, true)
})
</script>

<template>
  <div class="model-select" ref="rootRef">
    <button
      ref="triggerRef"
      type="button"
      class="ms-trigger"
      :title="title || currentLabel"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <span class="ms-label">{{ currentLabel }}</span>
      <svg class="ms-caret" width="9" height="9" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" class="ms-panel" :style="panelStyle" @click.stop>
        <template v-for="opt in options" :key="isGroup(opt) ? opt.key : opt.value">
          <div v-if="isGroup(opt)" class="ms-group-label">{{ opt.label }}</div>
          <template v-if="isGroup(opt)">
            <button
              v-for="c in opt.children"
              :key="c.value"
              type="button"
              class="ms-option"
              :class="{ active: c.value === modelValue }"
              @click="pick(c.value)"
            >{{ c.label }}</button>
          </template>
          <button
            v-else
            type="button"
            class="ms-option"
            :class="{ active: opt.value === modelValue }"
            @click="pick(opt.value)"
          >{{ opt.label }}</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.model-select {
  display: inline-flex;
  align-items: center;
}

/* 触发器：宽度由内容决定（inline-flex），右侧间距固定 */
.ms-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;                 /* 文字与箭头的固定间距，不随选项长度变化 */
  padding: 1px 2px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: inherit;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.4;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  max-width: none;          /* 关键：不限制宽度，由文字撑开 */
}
.ms-trigger:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.12)); }
.ms-label { display: inline-block; }
.ms-caret { flex: none; opacity: 0.55; }

/* 下拉面板：宽度按内容自适应，可超出触发器 */
.ms-panel {
  position: fixed;
  z-index: 3000;
  max-width: 360px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.ms-group-label {
  padding: 6px 10px 4px;
  font-size: 11px;
  color: var(--text-muted, #888);
  user-select: none;
}
.ms-option {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--text-primary, #fff);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.ms-option:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.14)); }
.ms-option.active { color: var(--accent, #4f8cff); font-weight: 600; }
</style>
