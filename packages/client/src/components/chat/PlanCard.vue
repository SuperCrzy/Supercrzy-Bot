<template>
  <div class="plan-card" v-if="progress">
    <!-- 头部：标题 + 进度 -->
    <div class="pc-head">
      <span class="pc-title">{{ planTitleText }}</span>
      <span class="pc-count">{{ planDoneCount }}/{{ progress.steps.length }}</span>
      <span class="pc-percent">{{ planPercent }}%</span>
    </div>
    <!-- 进度条 -->
    <div class="pc-bar">
      <div class="pc-fill" :style="{ width: planPercent + '%' }"></div>
    </div>
    <!-- 步骤列表：每条 #N 标序 + 状态图标 -->
    <div class="pc-steps">
      <div
        v-for="(s, i) in progress.steps"
        :key="s.id"
        class="pc-step"
        :class="{ done: s.status === 'completed', active: s.status === 'in_progress' }"
      >
        <svg v-if="s.status === 'completed'" class="pc-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else-if="s.status === 'in_progress'" class="pc-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <span v-else class="pc-ico pc-idle"></span>
        <span class="pc-num">#{{ i + 1 }}</span>
        <span class="pc-subject">{{ s.subject }}</span>
        <span v-if="s.status === 'in_progress'" class="pc-current">{{ t('chat.planStepRunning') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlanStore } from '@/stores/plan'

/**
 * 内联任务列表卡（2026-08-27 加，对齐 WorkBuddy todo 卡）：
 * 挂在 create_plan / plan 工具卡处，实时显示当前计划进度（#N 标序 + 完成/进行中/待办）。
 * 数据源＝ planStore.planProgress（与横栏 PlanCapsule 同源），plan_update 事件自动刷新，后端零改动。
 */
const { t } = useI18n({ useScope: 'global' })
const planStore = usePlanStore()

const progress = computed(() => planStore.planProgress)
const planDoneCount = computed(() => progress.value?.steps.filter((s) => s.status === 'completed').length || 0)
const planPercent = computed(() => {
  if (!progress.value?.steps.length) return 0
  return Math.round((planDoneCount.value / progress.value.steps.length) * 100)
})
const planTitleText = computed(() => progress.value?.title || t('chat.planTitleDefault'))
</script>

<style scoped>
.plan-card {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg-secondary, rgba(128, 128, 128, 0.04));
  margin: 6px 0;
}
.pc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.pc-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-count {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  background: var(--bg-primary, #fff);
  padding: 1px 7px;
  border-radius: 10px;
}
.pc-percent {
  font-size: 11px;
  color: var(--accent, #6366f1);
  font-weight: 500;
  min-width: 34px;
  text-align: right;
}
.pc-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--border-color, rgba(128,128,128,0.2));
  margin-bottom: 8px;
  overflow: hidden;
}
.pc-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #6366f1);
  transition: width 0.3s ease;
}
.pc-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pc-step {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12.5px;
}
.pc-step.done {
  background: color-mix(in srgb, #16a34a 9%, transparent);
  color: var(--text-primary);
}
.pc-step.done .pc-ico { color: #16a34a; }
.pc-step.done .pc-subject { color: color-mix(in srgb, var(--text-primary) 55%, transparent); text-decoration: line-through; }
.pc-step.active {
  background: color-mix(in srgb, var(--accent, #6366f1) 10%, transparent);
}
.pc-step.active .pc-ico { color: var(--accent, #6366f1); }
.pc-step.active .pc-subject { color: var(--text-primary); font-weight: 500; }
.pc-ico { flex-shrink: 0; }
.pc-ico.pc-idle {
  width: 15px; height: 15px;
  border: 1.5px solid var(--border-color, rgba(128,128,128,0.5));
  border-radius: 50%;
  box-sizing: border-box;
}
.pc-num {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  min-width: 20px;
}
.pc-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.pc-current {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--accent, #6366f1);
  background: color-mix(in srgb, var(--accent, #6366f1) 12%, transparent);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
</style>
