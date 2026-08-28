import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface PlanStep {
  id: string
  subject: string
  status: string
}
export interface PlanInfo {
  planId: string
  title: string
  steps: PlanStep[]
}

/**
 * 任务计划状态（create_plan 工具 → plan_update SSE 事件驱动）。
 * 独立 store：Web 端胶囊在 chat-header、App 端在顶部横栏，两处共享同一份计划进度。
 */
export const usePlanStore = defineStore('plan', () => {
  /** 当前进行中的计划（由本会话 plan_update 事件驱动） */
  const planProgress = ref<PlanInfo | null>(null)
  /** 历史计划（弹窗时间线） */
  const planHistory = ref<Array<PlanInfo & { finishedAt?: number }>>([])
  /**
   * 当前计划是否已随整个回复结束（done 事件）。
   * 区分"计划步骤全部完成"（AI 可能还在收尾轮：验证/汇总）与"回复真正结束"——
   * 步骤全 completed 但未 done → 胶囊显示"收尾中"，done 后才显示"全部完成"（对齐 AI 实际状态）
   */
  const planFinished = ref(false)

  /** 收到 plan_update 快照：planId 变化 → 旧计划归档进历史 */
  function setPlanUpdate(snap: PlanInfo) {
    if (planProgress.value && planProgress.value.planId !== snap.planId) {
      planHistory.value = [planProgress.value, ...planHistory.value.filter((p) => p.planId !== planProgress.value!.planId)]
      planFinished.value = false  // 新计划开始：结束标记复位
    }
    planProgress.value = snap
  }

  /** 回复 done：当前计划随回复结束（胶囊可显示"全部完成"） */
  function markPlanFinished() {
    planFinished.value = true
  }

  function setPlanHistory(list: Array<PlanInfo & { finishedAt?: number }>) {
    planHistory.value = list
  }

  /** 切会话：清空当前计划与历史（当前 plan 只由本会话的 plan_update 事件驱动） */
  function clearPlan() {
    planProgress.value = null
    planHistory.value = []
  }

  /** 新消息开始：重置当前进度（保留历史）——旧计划的"完成"态不再悬挂在胶囊上，等新 plan_update */
  function resetProgress() {
    planProgress.value = null
    planFinished.value = false
  }

  return { planProgress, planHistory, planFinished, setPlanUpdate, setPlanHistory, markPlanFinished, clearPlan, resetProgress }
})
