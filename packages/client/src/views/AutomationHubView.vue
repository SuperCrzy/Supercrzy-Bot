<template>
  <div class="auto-hub">
    <div class="hub-header">
      <div>
        <h2 class="hub-title">自动执行</h2>
        <p class="hub-desc">定时任务 + 可复用流程，组合出"到了点自动跑固定流程"</p>
      </div>
    </div>
    <n-card size="small" class="hub-tabs" content-style="padding:0">
      <n-tabs v-model:value="activeTab" type="line" animated>
        <n-tab-pane name="automations" tab="定时任务">
          <AutomationsView />
        </n-tab-pane>
        <n-tab-pane name="routines" tab="可复用流程">
          <RoutinesView />
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AutomationsView from './AutomationsView.vue'
import RoutinesView from './RoutinesView.vue'

const activeTab = ref('automations')
</script>

<style scoped>
.auto-hub {
  padding: 16px 20px;
  height: 100%;
  overflow-y: auto;
}
.hub-header {
  margin-bottom: 16px;
}
.hub-title {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
}
.hub-desc {
  margin: 6px 0 0;
  color: var(--color-text-tertiary, #888);
  font-size: 13px;
}
</style>
