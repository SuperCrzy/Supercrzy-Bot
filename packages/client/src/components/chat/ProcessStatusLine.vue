<template>
  <!-- 单行「过程状态行」（I13）：一次只渲染一个动作，动作变化时旧文案左滑出 + 新文案右滑入 + 扫光。
       视觉刻意与 .process-collapse-bar 同构（同边框/同圆角/同字号/同高），
       使"流式状态行 → 收尾折叠条"的切换几乎无跳变（老板定稿：收尾折叠保持现状）。 -->
  <div
    class="psl"
    :class="{
      'psl--done': !active.running && !active.pending && !active.failed && !active.cancelled,
      'psl--pending': active.pending,
      'psl--error': active.failed,
      'psl--cancelled': active.cancelled,
    }"
    role="button"
    tabindex="0"
    :title="t('chat.procDetailTip')"
    @click="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <!-- 左：状态图标（待确认 clock / 执行中 loader 旋转 / 已完成 check / 失败 ✕ / 已取消 中性减号） -->
    <span class="psl-icon">
      <SvgIcon v-if="active.pending" name="clock" :size="13" />
      <SvgIcon v-else-if="active.running" name="loader" :size="13" class="psl-spin" />
      <svg v-else-if="active.failed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
      <svg v-else-if="active.cancelled" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>
      <SvgIcon v-else name="check" :size="13" />
    </span>

    <!-- 进度痕迹：本段动作的小圆点（已完成实心、未完成空心）；>6 个退化成 done/total -->
    <span v-if="trail.show" class="psl-trail" :title="t('chat.procTrailTip', { n: trail.done })">
      <template v-if="trail.dots">
        <i
          v-for="i in trail.dots"
          :key="i"
          class="psl-dot"
          :class="{ 'psl-dot--on': i <= trail.done }"
        ></i>
      </template>
      <span v-else class="psl-trail-frac">{{ trail.fraction }}</span>
    </span>

    <!-- 中：当前动作（:key 变化即重建 DOM ⇒ 自动重放入场滑入 + 扫光）。
         mode="out-in"：先出后进不重叠 ⇒ action 无需 absolute，fit-content 才能算出内容宽（否则 pill 塌成 42px）。
         2026-09-26 智能化⑤：上一个动作驻留 <800ms（快动作）→ 本次切换免动画（走马灯→稳感） -->
    <span class="psl-viewport">
      <Transition :name="animateSwap ? 'psl-swap' : undefined" mode="out-in">
        <span :key="active.key" class="psl-action" :class="{ 'psl-action--still': !animateSwap }">
          <span class="psl-label">{{ active.label }}<template v-if="thinkSecs"> · {{ thinkSecs }}s</template></span>
          <span v-if="active.target" class="psl-object" :title="active.target">{{ active.target }}</span>
        </span>
      </Transition>
    </span>

    <!-- 右：实时数字（±行数 / 写入进度 / 编辑处数）——数据源 = 结构化 tool_progress -->
    <span v-if="counter.show" class="psl-counter">
      <span v-if="counter.added" class="psl-add">+{{ counter.added }}</span>
      <span v-if="counter.deleted" class="psl-del">−{{ counter.deleted }}</span>
      <span v-if="counter.frac" class="psl-frac">{{ counter.frac }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import {
  resolveActiveAction,
  resolveTrail,
  resolveCounter,
  type ProcessNodeLike,
} from '@/utils/process-view'

const props = defineProps<{
  /** 本过程段节点（thinking / thinking-group / tool），顺序同 flow */
  nodes: ProcessNodeLike[]
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()

const { t } = useI18n({ useScope: 'global' })
const tt = computed(() => t as unknown as (key: string, params?: Record<string, unknown>) => string)

const active = computed(() => resolveActiveAction(props.nodes || [], tt.value))
const trail = computed(() => resolveTrail(props.nodes || []))
/** 当前动作对应的工具节点（实时数字的数据源） */
const activeToolNode = computed<ProcessNodeLike | null>(() => {
  const nodes = props.nodes || []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind !== 'tool' || !n.tool) continue
    if (active.value.key === `tool:${n.tool.id || i}`) return n
  }
  return null
})
const counter = computed(() => resolveCounter(activeToolNode.value?.tool?.progress, tt.value))

// ============ 智能化③：思考时长实时跳动 ============
// thinking 节点没有时间戳（flow 数据模型里只有 completed），组件本地计时：
// 进入 thinking 动作记起点，每秒跳一次；离开清零停表。
const thinkStart = ref(0)
const nowTick = ref(Date.now())
let thinkTimer: ReturnType<typeof setInterval> | undefined
watch(
  () => active.value,
  (a) => {
    if (a && a.key.startsWith('think:') && a.running) {
      if (!thinkStart.value) thinkStart.value = Date.now()
    } else {
      thinkStart.value = 0
    }
  },
  { immediate: true },
)
watch(thinkStart, (v) => {
  if (v && !thinkTimer) thinkTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
  if (!v && thinkTimer) {
    clearInterval(thinkTimer)
    thinkTimer = undefined
  }
})
onBeforeUnmount(() => thinkTimer && clearInterval(thinkTimer))
const thinkSecs = computed(() =>
  thinkStart.value ? Math.max(1, Math.round((nowTick.value - thinkStart.value) / 1000)) : 0,
)

// ============ 智能化⑤：快动作免动画 ============
// 动作已完成才知时长 → 反向判定：下一次切换时，若上一个动作驻留 <800ms，则本次不重放
// 滑出滑入/扫光（Transition name 置空 + 动画类禁用），连续快动作从"走马灯"变"稳定换字"。
const animateSwap = ref(true)
const lastSwapAt = ref(0)
watch(
  () => active.value.key,
  () => {
    const now = Date.now()
    animateSwap.value = now - lastSwapAt.value >= 800
    lastSwapAt.value = now
  },
)
</script>

<style scoped>
/* 固定行高：状态行在动作演进/数字跳动/圆点增减时**高度恒定**（不推挤下方内容，避免整段抖动） */
.psl {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  box-sizing: border-box;
  margin: 2px 0 6px;
  padding: 0 10px;
  /* 2026-09-25 修：父 .message-body 被改为 width:100% 后此条被拉满全宽 ⇒ "框的末端没充满"（老板报）。
     pill 应包住内容：fit-content + max-width 兜底（长文案时限宽不溢出）。 */
  width: fit-content;
  max-width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11.5px;
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  transition: border-color var(--duration-fast, 0.15s), color var(--duration-fast, 0.15s), background var(--duration-fast, 0.15s);
}
.psl:hover {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--bg-hover);
}
.psl--pending {
  border-color: var(--warning-border, #f59e0b);
  background: var(--bg-warning, var(--bg-tertiary));
}
.psl:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.psl-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--accent, #6366f1);
}
.psl--done .psl-icon { color: #059669; }
.psl--pending .psl-icon { color: var(--warning, #f59e0b); }
.psl--error { border-color: var(--color-danger-border, #f09595); }
.psl--error .psl-icon { color: #A32D2D; }
.psl--cancelled .psl-icon { color: var(--text-muted, #888780); }
.psl-spin { animation: psl-rotate 1.1s linear infinite; }
@keyframes psl-rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 进度痕迹小圆点 */
.psl-trail {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.psl-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  border: 1px solid var(--border-color);
  background: transparent;
  box-sizing: border-box;
}
.psl-dot--on {
  background: var(--accent, #6366f1);
  border-color: var(--accent, #6366f1);
}
.psl-trail-frac {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--text-muted, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}

/* 单行视口：离开/进入两个元素**同时存在**（Transition 默认模式），必须绝对定位才不会互相顶开。
   2026-09-26 修：视口 28px 高但子元素贴顶（inline 撑行 19.5px）→ 文字偏上 ~4px 与居中的
   spinner 错位（老板："旋转的那个框框内文字上下布局"）。flex 垂直居中对齐。 */
.psl-viewport {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
.psl-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  /* 扫光：随 :key 重建 DOM 自动重放（无需 JS 计时），线性渐变横向掠过动作文案。
     2026-09-26 修（老板："正在思考的第一个框显示不完整"）：动画播完 fill:none 跳回 0% 0%，
     240% 底图下 0% 的可见窗=渐变 0~41.7%，而渐变 38% 起有色 → 文字右端**恒定残留一条淡紫竖带**。
     双保险：渐变起点挪到 45%（静止窗全透明）+ fill-mode:forwards（停稳在 -120% 的无色区）。 */
  background-image: linear-gradient(
    100deg,
    transparent 45%,
    color-mix(in srgb, var(--accent, #6366f1) 22%, transparent) 50%,
    transparent 62%
  );
  background-size: 240% 100%;
  background-repeat: no-repeat;
  animation: psl-sweep 0.5s ease-out forwards;
}
@keyframes psl-sweep {
  from { background-position: 180% 0; }
  to { background-position: -120% 0; }
}
.psl-swap-enter-active { transition: transform 0.26s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.26s ease-out; }
.psl-swap-leave-active { transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1), opacity 0.22s ease-in; }
.psl-swap-enter-from { transform: translateX(14px); opacity: 0; }
.psl-swap-leave-to { transform: translateX(-14px); opacity: 0; }
/* 智能化⑤：快动作切换——无过渡类（name=undefined）+ 禁扫光，直接换字 */
.psl-action--still { animation: none; }

.psl-label {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}
.psl-object {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}

/* 实时数字 */
.psl-counter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.psl-add { color: #059669; font-weight: 600; }
.psl-del { color: #dc2626; font-weight: 600; }
.psl-frac { color: var(--text-muted, var(--text-secondary)); }
</style>
