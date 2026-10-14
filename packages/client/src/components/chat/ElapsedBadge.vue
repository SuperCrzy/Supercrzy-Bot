<template>
  <span v-if="text" class="elapsed-badge">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
    {{ text }}
  </span>
</template>

<script setup lang="ts">
/**
 * 整轮耗时徽标（AI 回复头像/名字下方）。
 *
 * 两个刻意的设计：
 *
 * 1. **tick 对齐 wall-clock 整秒边界**，不是 setInterval(1000)。
 *    remaining = 1000 - elapsed % 1000，递归 setTimeout。
 *    好处：①显示的秒数与真实经过时间同步跳变，不会因定时器相位产生恒定偏差
 *    （旧实现用 setInterval + toFixed(1)，小数位其实是"相位"，无精度意义）；
 *    ②同屏多条消息的计时器在同一时刻跳动，视觉整齐。
 *
 * 2. **计时器只存在于本组件内部**，不再是页面级 ref。
 *    旧实现把 nowTs 放在 ChatView 顶层并在模板里引用 → 流式中每秒让**整个消息列表**
 *    重新求值（长会话每秒一次全量 diff）。现在每秒只重渲染这一个 badge。
 *
 * 格式化统一走 utils/tool-summary 的 formatDurationMs —— 与折叠条（MessageFlowRenderer）
 * 同一函数、同一文案前缀，杜绝"同一条回复两处显示不一致"。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatDurationMs } from '@/utils/tool-summary'
import { useSecondTick } from '@/composables/useSecondTick'

const props = defineProps<{
  /** 本轮开始时刻（毫秒时间戳）。缺失则运行态不显示，避免出现无意义的 0s。 */
  startedAt?: number
  /** 完成后的静态耗时（毫秒）。一旦有值即切换为完成态，停止计时。 */
  elapsedMs?: number
  /** 该轮是否仍在运行。false 时不启动计时器（不渲染、不空转）。 */
  running?: boolean
}>()

const { t } = useI18n({ useScope: 'global' })

/** 仅运行态需要秒针：完成态用静态 elapsedMs，没有起点也不计时 */
const ticking = () => !props.elapsedMs && !!props.running && !!props.startedAt
const now = useSecondTick(ticking, () => props.startedAt)

const isDone = computed(() => !!props.elapsedMs && props.elapsedMs > 0)

const text = computed(() => {
  if (isDone.value) return `${t('chat.turnCompleted')} ${formatDurationMs(props.elapsedMs)}`
  if (!ticking()) return ''
  const live = Math.max(0, now.value - (props.startedAt ?? now.value))
  // 最少按 1s 展示，避免出现 "0s"
  return t('chatui.timingInProgress', { n: formatDurationMs(Math.max(1000, live)) })
})
</script>

<style scoped>
.elapsed-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.12);
  color: #0f766e;
  font-size: 11px;
  font-weight: 500;
}
.elapsed-badge svg { color: #0f766e; }
</style>
