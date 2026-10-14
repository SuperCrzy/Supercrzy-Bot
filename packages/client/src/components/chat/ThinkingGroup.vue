<template>
  <div class="thinking-group" :class="{ open }">
    <!-- header：深度思考标题（对齐 WorkBuddy ReasoningRenderer），点击展开/收起 -->
    <div class="tg-header" :class="{ clickable: hasReasoning }" @click="toggle">
      <span class="tg-indicator"></span>
      <span class="tg-label">{{ $t('chatui.deepThinking') }}<template v-if="turns.length > 1"> · {{ turns.length }} 轮</template></span>
      <svg v-if="hasReasoning" class="tg-arrow" :class="{ open }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div v-if="open && hasReasoning" class="tg-reasoning">
      <div v-for="(t, i) in turns" :key="'tg-' + i" class="tg-turn">
        <div v-if="turns.length > 1" class="tg-turn-label">Turn {{ t.turn }}</div>
        <!-- 思考完整展示（老板 2026-08-25：不截断，上下滑动看完整推理；仅剥离代码/SVG 草稿） -->
        <div class="tg-turn-text">{{ cleanReasoning(t.reasoning) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  turns: Array<{ turn?: number; reasoning?: string; completed?: boolean }>
}>()

const open = ref(false)
const hasReasoning = computed(() => props.turns.some((t) => t.reasoning))

/** 点击"深度思考"标题：展开/收起推理（对齐 WorkBuddy 点击 header 切换） */
function toggle() {
  if (hasReasoning.value) open.value = !open.value
}

/** 剥离推理内容中的代码草稿与 SVG 草稿（模型思考时常草拟代码/SVG——这些是过程草稿，不应裸露展示；统计行数提示用户） */
function cleanReasoning(text: string | undefined): string {
  if (!text) return ''
  let s = text
  // 代码块（python/js/svg 等任何 ``` 块）→ 折叠成占位（含行数）
  s = s.replace(/```[^\n]*[\s\S]*?```/g, (m) => {
    const lines = m.split('\n').length - 2
    return `\n[代码草稿 · ${lines} 行]\n`
  })
  // 裸 SVG（未包在代码块里）兜底
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '[SVG 图草稿]')
  return s
}
</script>

<style scoped>
.thinking-group {
  padding: 2px 0;
  margin: 2px 0;
  opacity: 0.6;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.tg-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tg-header.clickable {
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
  padding: 1px 4px 1px 2px;
  margin-left: -2px;
  transition: background var(--duration-fast);
}
.tg-header.clickable:hover {
  background: var(--bg-tertiary);
}

.tg-indicator {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}

.tg-label {
  font-size: 12px;
  font-weight: 500;
}

.tg-arrow {
  color: var(--text-muted);
  transition: transform var(--duration-fast);
  flex-shrink: 0;
}
.tg-arrow.open {
  transform: rotate(180deg);
}

.tg-reasoning {
  margin: 6px 0 10px;
  padding: 8px 10px;
  border-left: 2px solid var(--accent-muted);
  background: var(--bg-tertiary);
  border-radius: 0 6px 6px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 2026-09-24：300px → min(60vh, 520px)，对齐 ThinkingBlock 展开态限高（老板报"思考框被截断"） */
  max-height: min(60vh, 520px);
  overflow-y: auto;
}
.tg-turn-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 3px;
}
.tg-turn-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
