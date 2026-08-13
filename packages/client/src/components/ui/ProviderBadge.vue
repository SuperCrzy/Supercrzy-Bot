<template>
  <span class="provider-badge" :style="{ background: color, color: fg }">{{ abbr }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  provider: string
  size?: number
}>(), {
  size: 22,
})

/** 品牌色 + 缩写标记(替代 emoji,保持原创) */
const BRAND: Record<string, { color: string; fg: string; abbr: string }> = {
  deepseek:   { color: '#4d6bfe', fg: '#fff', abbr: 'DS' },
  openai:     { color: '#0d0d0d', fg: '#fff', abbr: 'OA' },
  openrouter: { color: '#7c3aed', fg: '#fff', abbr: 'OR' },
  anthropic:  { color: '#d97757', fg: '#fff', abbr: 'AC' },
  grok:       { color: '#111111', fg: '#fff', abbr: 'XA' },
  gemini:     { color: '#4285f4', fg: '#fff', abbr: 'GM' },
  mistral:    { color: '#ff7000', fg: '#fff', abbr: 'MS' },
  zhipu:      { color: '#2b6ff3', fg: '#fff', abbr: 'GL' },
  kimi:       { color: '#374151', fg: '#fff', abbr: 'KM' },
  mimo:       { color: '#3b82f6', fg: '#fff', abbr: 'MM' },
}

const brand = computed(() => BRAND[props.provider] || { color: '#64748b', fg: '#fff', abbr: 'AI' })
const abbr = computed(() => brand.value.abbr)
const color = computed(() => brand.value.color)
const fg = computed(() => brand.value.fg)
</script>

<style scoped>
.provider-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: v-bind(size + 'px');
  height: v-bind(size + 'px');
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  user-select: none;
}
</style>
