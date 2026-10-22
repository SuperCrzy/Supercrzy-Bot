<template>
  <span v-if="text" class="elapsed-badge" :class="{ 'elapsed-badge--aborted': aborted }">
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
 * 三个刻意的设计：
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
 * 3. **状态判定下沉到 utils/elapsed-state.ts**（2026-10-22，A3）。
 *    原先只有"运行中 / 已完成"两态：点停止后徽标**整块消失**，刷新后又被反算出的
 *    elapsedMs 渲染成「已完成」——把被中断的轮次说成跑完了。第三态「已取消」的判据
 *    （aborted > done > running > hidden）只由输入决定，抽成纯函数后可直接断言。
 *
 * 格式化统一走 utils/tool-summary 的 formatDurationMs —— 与折叠条（MessageFlowRenderer）
 * 同一函数、同一文案前缀，杜绝"同一条回复两处显示不一致"。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatDurationMs } from '@/utils/tool-summary'
import { useSecondTick } from '@/composables/useSecondTick'
import { resolveElapsedView } from '@/utils/elapsed-state'

const props = defineProps<{
  /** 本轮开始时刻（毫秒时间戳）。缺失则运行态不显示，避免出现无意义的 0s。 */
  startedAt?: number
  /** 完成后的静态耗时（毫秒）。一旦有值即切换为完成态，停止计时。 */
  elapsedMs?: number
  /** 该轮是否仍在运行。false 时不启动计时器（不渲染、不空转）。 */
  running?: boolean
  /** 该轮是否被用户停止（取消态优先于完成态） */
  aborted?: boolean
}>()

const { t } = useI18n({ useScope: 'global' })

/** 仅运行态需要秒针：定格/取消态用静态耗时，没有起点也不计时 */
const ticking = () => !props.elapsedMs && !props.aborted && !!props.running && !!props.startedAt
const now = useSecondTick(ticking, () => props.startedAt)

const view = computed(() =>
  resolveElapsedView({
    aborted: props.aborted,
    elapsedMs: props.elapsedMs,
    running: props.running,
    startedAt: props.startedAt,
    nowMs: now.value,
  }),
)

const text = computed(() => {
  const { state, ms } = view.value
  if (state === 'hidden') return ''
  if (state === 'aborted') return `${t('chat.taskCancelled')} ${formatDurationMs(ms)}`
  if (state === 'done') return `${t('chat.turnCompleted')} ${formatDurationMs(ms)}`
  return t('chatui.timingInProgress', { n: formatDurationMs(ms) })
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
/* 取消态：中性灰（不是失败红——用户主动停止不是错误），与"已完成"的绿明确区分 */
.elapsed-badge--aborted {
  background: rgba(136, 135, 128, 0.14);
  color: var(--text-secondary, #5f5e5a);
}
.elapsed-badge--aborted svg { color: var(--text-muted, #888780); }
</style>
