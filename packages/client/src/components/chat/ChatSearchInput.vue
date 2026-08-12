<template>
  <div class="chat-search-bar" v-if="visible">
    <div class="search-input-wrap">
      <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        ref="inputRef"
        v-model="keyword"
        type="text"
        :placeholder="$t('chatui.searchPlaceholder')"
        class="search-input"
        @input="onSearch"
        @keydown.escape="close"
        @keydown.enter="nextMatch"
        @keydown.up.prevent="prevMatch"
        @keydown.down.prevent="nextMatch"
      />
      <span v-if="keyword" class="match-count">{{ currentIdx + 1 }}/{{ totalMatches }}</span>
      <button class="search-nav-btn" @click="prevMatch" :title="$t('chatui.prev')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>
      </button>
      <button class="search-nav-btn" @click="nextMatch" :title="$t('chatui.next')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <button class="search-close-btn" @click="close" :title="$t('common.close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { applyHighlights, clearHighlights, updateCurrentMark } from '@/composables/useChatSearch'

const props = defineProps<{ visible: boolean; targetRef?: HTMLElement | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const keyword = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const currentIdx = ref(0)
const allMarks = ref<HTMLElement[]>([])
const totalMatches = ref(0)

watch(() => props.visible, (v) => {
  if (v) {
    nextTick(() => inputRef.value?.focus())
  } else {
    keyword.value = ''
    if (props.targetRef) clearHighlights(props.targetRef)
    allMarks.value = []
    currentIdx.value = 0
    totalMatches.value = 0
  }
})

function onSearch() {
  if (!props.targetRef) return
  if (!keyword.value) {
    clearHighlights(props.targetRef)
    allMarks.value = []
    totalMatches.value = 0
    return
  }
  allMarks.value = applyHighlights(props.targetRef, keyword.value)
  totalMatches.value = allMarks.value.length
  currentIdx.value = 0
  if (allMarks.value.length > 0) updateCurrentMark(allMarks.value, 0)
}

function nextMatch() {
  if (allMarks.value.length === 0) return
  currentIdx.value = (currentIdx.value + 1) % allMarks.value.length
  updateCurrentMark(allMarks.value, currentIdx.value)
}

function prevMatch() {
  if (allMarks.value.length === 0) return
  currentIdx.value = (currentIdx.value - 1 + allMarks.value.length) % allMarks.value.length
  updateCurrentMark(allMarks.value, currentIdx.value)
}

function close() {
  emit('close')
}
</script>

<style scoped>
.chat-search-bar {
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

.search-icon { color: var(--text-muted); flex-shrink: 0; }

.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  min-width: 0;
}

.match-count {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.search-nav-btn,
.search-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 3px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
}

.search-nav-btn:hover,
.search-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
