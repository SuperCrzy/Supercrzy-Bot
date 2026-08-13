<template>
  <span class="provider-badge" :style="{ width: size + 'px', height: size + 'px' }">
    <img
      v-if="logo"
      :src="logo"
      :width="size"
      :height="size"
      class="brand-logo-img"
      :alt="provider"
      draggable="false"
    />
    <span
      v-else
      class="brand-fallback"
      :style="{ background: brandColor, color: '#fff', width: size + 'px', height: size + 'px' }"
    >
      {{ abbr }}
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import openaiLogo from '@/assets/logos/openai.svg'
import anthropicLogo from '@/assets/logos/anthropic.svg'
import xaiLogo from '@/assets/logos/xai.png'
import mistralLogo from '@/assets/logos/mistral.png'
import geminiLogo from '@/assets/logos/gemini.png'
import deepseekLogo from '@/assets/logos/deepseek.png'
import openrouterLogo from '@/assets/logos/openrouter.png'
import ollamaLogo from '@/assets/logos/ollama.png'
import zhipuLogo from '@/assets/logos/zhipu.png'
import kimiLogo from '@/assets/logos/kimi.png'
import mimoLogo from '@/assets/logos/mimo.png'

const props = withDefaults(defineProps<{
  provider: string
  size?: number
}>(), {
  size: 22,
})

/**
 * 官方品牌 LOGO —— 均取自厂商官方渠道:
 * openai/anthropic: OpenRouter 官方收录的官方 SVG
 * xai: docs.x.ai 官方 favicon
 * mistral/kimi/mimo: 官方 GitHub 组织头像
 * gemini: gemini.google.com 官方 favicon
 * deepseek/zhipu/ollama/openrouter: 各自官网官方 favicon
 */
const LOGOS: Record<string, string> = {
  openai: openaiLogo,
  anthropic: anthropicLogo,
  xai: xaiLogo,
  grok: xaiLogo,
  mistral: mistralLogo,
  gemini: geminiLogo,
  deepseek: deepseekLogo,
  openrouter: openrouterLogo,
  ollama: ollamaLogo,
  zhipu: zhipuLogo,
  kimi: kimiLogo,
  mimo: mimoLogo,
}

/** 兜底(无官方图渠道):品牌色 + 缩写 */
const BRAND: Record<string, { color: string; abbr: string }> = {
  zhipu:  { color: '#2b6ff3', abbr: 'GL' },
  kimi:   { color: '#374151', abbr: 'KM' },
  mimo:   { color: '#3b82f6', abbr: 'MM' },
}

const logo = computed(() => LOGOS[props.provider] || '')
const fallback = computed(() => BRAND[props.provider] || { color: '#64748b', abbr: 'AI' })
const brandColor = computed(() => fallback.value.color)
const abbr = computed(() => fallback.value.abbr)
</script>

<style scoped>
.provider-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  flex-shrink: 0;
  user-select: none;
  overflow: hidden;
}
.brand-logo-img {
  display: block;
  object-fit: contain;
}
.brand-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
</style>
