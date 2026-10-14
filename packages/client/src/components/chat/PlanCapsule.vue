<template>
  <div class="plan-capsule-wrap">
    <!-- 任务进度胶囊：迷你进度；点击弹任务历史时间线 -->
    <div
      v-if="planStore.planProgress"
      class="plan-capsule"
      :class="{ allDone: allStepsDone && planStore.planFinished }"
      @click.stop="popoverOpen = !popoverOpen"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <transition name="cap-step" mode="out-in">
        <span :key="currentPlanStep?.id || 'done'" class="plan-cap-step">{{ planStepShort }}</span>
      </transition>
      <span class="plan-cap-count">{{ planDoneCount }}/{{ planStore.planProgress.steps.length }}</span>
      <div class="plan-cap-bar"><div class="plan-cap-fill" :style="{ width: planPercent + '%' }"></div></div>
    </div>
    <!-- 任务历史弹窗 -->
    <div v-if="popoverOpen" class="plan-popover" @click.stop="popoverOpen = false">
      <div class="plan-pop-head">
        <span>{{ $t('chat.planHistoryTitle') }}</span>
        <span class="plan-pop-hint">{{ $t('chat.planHistoryHint') }}</span>
      </div>
      <div class="plan-pop-list">
        <div v-if="planStore.planProgress" class="plan-pop-item" :class="{ current: true }">
          <div class="plan-pop-title">{{ planStore.planProgress.title }}</div>
          <div class="plan-pop-steps">
            <div v-for="(s, i) in planStore.planProgress.steps" :key="s.id" class="plan-pop-step" :class="{ done: s.status === 'completed', active: s.status === 'in_progress' }">
              <span class="plan-pop-dot"></span>
              <span class="plan-pop-subject">{{ i + 1 }}. {{ s.subject }}</span>
            </div>
          </div>
        </div>
        <div v-for="(p, pi) in planStore.planHistory" :key="p.planId" class="plan-pop-item">
          <div class="plan-pop-title">{{ p.title }}</div>
          <div class="plan-pop-steps">
            <div v-for="(s, i) in p.steps" :key="s.id" class="plan-pop-step" :class="{ done: s.status === 'completed', active: s.status === 'in_progress' }">
              <span class="plan-pop-dot"></span>
              <span class="plan-pop-subject">{{ i + 1 }}. {{ s.subject }}</span>
            </div>
          </div>
        </div>
        <div v-if="!planStore.planProgress && planStore.planHistory.length === 0" class="plan-pop-empty">{{ $t('chat.planHistoryEmpty') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlanStore, type PlanStep } from '@/stores/plan'
import { useChatStore } from '@/stores/chat'

const { t } = useI18n({ useScope: 'global' })
const planStore = usePlanStore()
const chatStore = useChatStore()
const popoverOpen = ref(false)

/** 当前活跃步骤（in_progress） */
const currentPlanStep = computed(() => planStore.planProgress?.steps.find((s) => s.status === 'in_progress'))
/** 已完成数 */
const planDoneCount = computed(() => planStore.planProgress?.steps.filter((s) => s.status === 'completed').length || 0)
/** 步骤是否全部完成（AI 可能仍在收尾轮：验证/汇总——不代表回复结束） */
const allStepsDone = computed(() => !!planStore.planProgress && planStore.planProgress.steps.length > 0 && planDoneCount.value === planStore.planProgress.steps.length)
/** 进度百分比 */
const planPercent = computed(() => {
  if (!planStore.planProgress || !planStore.planProgress.steps.length) return 0
  return Math.round((planDoneCount.value / planStore.planProgress.steps.length) * 100)
})
/** 当前步骤短名（~10 字截断）：
 *  - 有 in_progress 步骤 → 该步骤名
 *  - 步骤全完成但回复未 done（AI 收尾中）→ "收尾中"
 *  - 步骤全完成且已 done → "全部完成" */
const planStepShort = computed(() => {
  const name = currentPlanStep.value?.subject
  if (name) return name.length > 10 ? name.slice(0, 10) + '…' : name
  if (allStepsDone.value && !planStore.planFinished) return t('chat.planFinalizing')
  return allStepsDone.value ? t('chat.planAllDone') : ''
})

/** 拉取会话历史任务（tasks 表根任务 + 各自子步骤），供弹窗时间线 */
async function loadPlanHistory() {
  const sid = chatStore.currentSessionId
  if (!sid) { planStore.setPlanHistory([]); return }
  try {
    const r = await fetch(`/api/tasks?session_id=${sid}&parent_id=`)
    const roots: any[] = await r.json()
    const withSteps = await Promise.all(
      roots.map(async (root) => {
        let steps: PlanStep[] = []
        try {
          const c = await fetch(`/api/tasks/${root.id}/children`)
          steps = await c.json()
        } catch {}
        return {
          planId: root.id,
          title: root.subject || root.title || '',
          steps: steps.map((s: any) => ({ id: s.id, subject: s.subject, status: s.status })),
          finishedAt: root.updated_at || undefined,
        }
      }),
    )
    planStore.setPlanHistory(withSteps.filter((p) => p.steps.length > 0))

    // ---- 恢复胶囊（bug 修复 2026-09-26：刷新/切会话后胶囊消失）----
    // 胶囊主显示吃 planProgress（原只由 SSE plan_update 写入，刷新即空）。
    // 这里从任务历史里找 status='in_progress' 的根任务回填——进行中的计划恢复显示，
    // 已完成的计划不回填（只在弹窗时间线），避免完成态悬挂。
    // 注意：恢复的就是模型 task_update 声明的真实状态（进度已智能化，无轮次盲推）。
    const activeRoot = roots.find((root: any) => root.status === 'in_progress')
    if (activeRoot) {
      const match = withSteps.find((p) => p.planId === activeRoot.id)
      if (match && match.steps.length > 0) {
        planStore.setPlanUpdate({ planId: match.planId, title: match.title, steps: match.steps })
      }
    } else {
      planStore.clearPlan()
    }
  } catch {
    planStore.setPlanHistory([])
  }
}

// 切会话：关闭弹窗并重新拉取该会话的任务历史。
// immediate: 首次挂载（刷新页面）也执行——否则刷新后胶囊和历史都不恢复（bug 2026-09-26）
watch(() => chatStore.currentSessionId, () => {
  popoverOpen.value = false
  loadPlanHistory()
}, { immediate: true })
</script>

<style scoped>
.plan-capsule-wrap {
  display: inline-flex;
  align-items: center;
}

/* ===== 任务进度胶囊 ===== */
.plan-capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.plan-capsule:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.plan-capsule.allDone {
  border-color: var(--success);
  color: var(--success);
}
.plan-cap-step {
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plan-cap-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.plan-cap-bar {
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}
.plan-cap-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.4s var(--ease-out);
}
.plan-capsule.allDone .plan-cap-fill {
  background: var(--success);
}
/* 步骤切换动画：旧文字划线删除淡出，新文字旋转进入 */
.cap-step-enter-active,
.cap-step-leave-active {
  transition: all 0.35s var(--ease-out);
}
.cap-step-leave-to {
  opacity: 0;
  transform: rotateX(-90deg);
  text-decoration: line-through;
  text-decoration-color: var(--success);
}
.cap-step-enter-from {
  opacity: 0;
  transform: rotateX(90deg);
}
.cap-step-enter-to {
  opacity: 1;
  transform: rotateX(0);
}

/* ===== 任务历史弹窗 ===== */
.plan-popover {
  position: fixed;
  top: 52px;
  right: 16px;
  width: 320px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
  z-index: 90;
  padding: 12px;
}
.plan-pop-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.plan-pop-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
}
.plan-pop-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.plan-pop-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg-tertiary);
}
.plan-pop-item.current {
  border-color: var(--accent);
}
.plan-pop-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}
.plan-pop-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.plan-pop-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.plan-pop-step.done {
  color: var(--success);
}
.plan-pop-step.active {
  color: var(--accent);
}
.plan-pop-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.plan-pop-step.done .plan-pop-dot {
  background: var(--success);
}
.plan-pop-step.active .plan-pop-dot {
  background: var(--accent);
}
.plan-pop-empty {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 12px 0;
}
</style>
