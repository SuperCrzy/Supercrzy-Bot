<template>
  <!-- 问题浮层（对齐主流实现 QuestionFloating：对话区顶部 portal，醒目不推挤消息流） -->
  <div class="question-floating">
    <div class="qf-card">
      <div class="qf-head">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span class="qf-title">{{ $t('chat.askQuestionTitle') }}</span>
      </div>
      <div class="qf-text">{{ question.question }}</div>
      <div v-if="questionOptions.length" class="qf-options">
        <button
          v-for="(opt, i) in questionOptions"
          :key="i"
          class="qf-opt"
          :class="{ selected: i === 0 }"
          @click="$emit('answer', question, opt)"
        >{{ opt }}</button>
      </div>
      <div v-else class="qf-input-row">
        <n-input
          :value="input"
          :placeholder="$t('chat.askQuestionPlaceholder')"
          size="small"
          @update:value="(v: string) => (input = v)"
          @keydown.enter.exact.prevent="submitInput"
        />
        <n-button size="small" type="primary" @click="submitInput">{{ $t('chat.submit') }}</n-button>
      </div>
      <button class="qf-skip" @click="$emit('skip', question)">{{ $t('chat.skipQuestion') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  question: { id: string; question: string; options: string[] }
}>()

const emit = defineEmits<{
  (e: 'answer', question: { id: string; question: string; options: string[] }, answer: string): void
  (e: 'skip', question: { id: string; question: string; options: string[] }): void
}>()

/** 选项兜底归一化（2026-08-27 加：模型/Emit 可能传对象数组，无论后端是否已归一，这里渲染前再转字符串，杜绝 [object Object]） */
const questionOptions = computed<string[]>(() => {
  const raw = props.question?.options
  if (!Array.isArray(raw)) return raw ? [String(raw)] : []
  return raw.map((o: any) => {
    if (typeof o === 'string') return o
    if (o == null) return ''
    if (typeof o === 'object') return String(o.text ?? o.label ?? o.value ?? JSON.stringify(o))
    return String(o)
  }).filter(Boolean)
})

const input = ref('')

function submitInput() {
  if (!input.value.trim()) return
  emit('answer', props.question, input.value.trim())
  input.value = ''
}
</script>

<style scoped>
/* 提问浮层：absolute 定位在 chat-container（对话工作区）内，对话栏水平居中、底部锚输入框上方、
   从底部向上滑（2026-08-27 重构：与授权框一致，不再 fixed 全屏居中） */
.question-floating {
  position: absolute;
  bottom: 104px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  max-width: min(560px, calc(100% - 32px));
  animation: qf-slide-up 0.26s ease-out;
}
@keyframes qf-slide-up {
  from { opacity: 0; transform: translate(-50%, 26px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
.qf-card {
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--warning);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  padding: 12px 14px;
  /* 脉冲提醒（2026-08-27 加，老板选青色）：上滑后闪 2 下 → 停 → 再闪 2 下，循环引导点确认 */
  animation: qf-pulse 4s ease-in-out 0.26s infinite;
}
@keyframes qf-pulse {
  0%, 5%, 10% { box-shadow: 0 0 0 0 rgba(45, 212, 191, 0); border-color: rgba(180, 83, 9, 0.45); }
  2.5%, 12.5% { box-shadow: 0 0 0 6px rgba(45, 212, 191, 0.42); border-color: rgba(45, 212, 191, 0.85); }
  50% { box-shadow: 0 0 0 0 rgba(45, 212, 191, 0); border-color: rgba(180, 83, 9, 0.45); }
  52.5%, 62.5% { box-shadow: 0 0 0 6px rgba(45, 212, 191, 0.42); border-color: rgba(45, 212, 191, 0.85); }
  100% { box-shadow: 0 0 0 0 rgba(45, 212, 191, 0); border-color: rgba(180, 83, 9, 0.45); }
}
.qf-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--warning, #b45309);
  margin-bottom: 6px;
}
.qf-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.qf-text {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 10px;
  line-height: 1.5;
}
.qf-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.qf-opt {
  font-size: 12.5px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.qf-opt:hover {
  border-color: var(--accent, #4f8cff);
  background: rgba(79, 140, 255, 0.08);
}
.qf-opt.selected {
  border-color: var(--accent, #4f8cff);
  background: rgba(79, 140, 255, 0.1);
}
.qf-input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.qf-skip {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-tertiary, rgba(128, 128, 128, 0.8));
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
}
.qf-skip:hover {
  color: var(--text-secondary);
  text-decoration: underline;
}
</style>
