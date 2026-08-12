<template>
  <div class="question-card">
    <div class="question-header">
      <span class="question-badge" v-if="header">{{ header }}</span>
      <span class="question-text">{{ question }}</span>
    </div>
    <div class="question-options">
      <label
        v-for="(opt, idx) in options"
        :key="idx"
        class="question-option"
        :class="{ selected: selectedIdx === idx }"
        @click="select(idx)"
      >
        <span class="option-radio">
          <svg v-if="selectedIdx === idx" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2.5">
            <circle cx="12" cy="12" r="5"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
          </svg>
        </span>
        <div class="option-content">
          <span class="option-label">{{ opt.label }}</span>
          <span class="option-desc" v-if="opt.description">{{ opt.description }}</span>
        </div>
      </label>
    </div>
    <div class="question-actions">
      <button class="question-submit" :disabled="selectedIdx < 0" @click="submit">
        {{ $t('chatui.submitChoice') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}>()

const emit = defineEmits<{ (e: 'answer', value: string): void }>()

const selectedIdx = ref(-1)

function select(idx: number) {
  selectedIdx.value = idx
}

function submit() {
  if (selectedIdx.value < 0) return
  const opt = props.options[selectedIdx.value]
  emit('answer', opt.label)
}
</script>

<style scoped>
.question-card {
  margin: 8px 0;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent);
  background: var(--bg-secondary);
  overflow: hidden;
  animation: slideIn 0.25s var(--ease-out);
}

@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

.question-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.question-badge {
  font-size: 10px;
  font-weight: 600;
  background: rgba(79,70,229,0.1);
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  white-space: nowrap;
}

.question-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
}

.question-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--duration-fast);
}

.question-option:hover {
  background: var(--bg-hover);
}

.question-option.selected {
  background: rgba(79,70,229,0.06);
}

.option-radio {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding-top: 2px;
  color: var(--text-muted);
}

.option-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-label {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

.option-desc {
  font-size: 11px;
  color: var(--text-muted);
}

.question-actions {
  padding: 8px 14px 12px;
  display: flex;
  justify-content: flex-end;
}

.question-submit {
  padding: 6px 16px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  background: var(--accent);
  color: white;
  border: none;
  cursor: pointer;
  transition: opacity var(--duration-fast);
}

.question-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.question-submit:not(:disabled):hover {
  filter: brightness(1.1);
}
</style>
