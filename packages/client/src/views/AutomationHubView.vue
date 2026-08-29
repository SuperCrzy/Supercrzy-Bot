<template>
  <div class="auto-hub">
    <div class="hub-tabs">
      <n-tabs v-model:value="activeTab" type="line" animated size="large">
        <n-tab-pane name="automations" tab="定时任务">
          <AutomationsView />
        </n-tab-pane>
        <n-tab-pane name="routines" tab="可复用流程">
          <RoutinesView />
        </n-tab-pane>
      </n-tabs>
    </div>
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
  height: 100%;
  display: flex;
  flex-direction: column;
}
.hub-tabs {
  flex: 1;
  min-height: 0;
  padding: 12px 0 0;
  display: flex;
  flex-direction: column;
}
.hub-tabs :deep(.n-tabs) {
  flex: 1;
  display: flex;
  flex-direction: column;
  --n-tab-gap: 24px;
}
.hub-tabs :deep(.n-tabs-nav) {
  padding: 0 20px;
  margin-bottom: 4px;
}
.hub-tabs :deep(.n-tab-pane) {
  padding-top: 0;
  overflow-y: auto;
  height: 100%;
  flex: 1;
}
</style>
