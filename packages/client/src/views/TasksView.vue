<template>
  <div class="page-container"><header class="page-header"><h2>任务管理</h2><p class="page-desc">管理和监控自动化任务执行</p><n-button size="small" type="primary" @click="showCreate = true"><template #icon><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></template>新建任务</n-button></header>
    <div class="tasks-list"><n-card v-for="t in tasks" :key="t.id" size="small" class="task-card"><template #header><div class="task-header"><span class="task-name">{{ t.name }}</span><n-tag :type="t.status === 'running' ? 'success' : t.status === 'failed' ? 'error' : 'default'" size="tiny" :bordered="false">{{ t.status }}</n-tag></div></template>
      <p class="task-desc">{{ t.description }}</p><div class="task-meta"><span>上次执行: {{ t.lastRun || '--' }}</span><span v-if="t.schedule">计划: {{ t.schedule }}</span></div></n-card>
      <n-empty v-if="tasks.length === 0" description="暂无任务" class="empty-state" /></div>

    <n-modal v-model:show="showCreate" preset="card" title="新建任务" style="width:500px">
      <n-form label-placement="left" label-width="80"><n-form-item label="任务名称"><n-input v-model:value="newTask.name" placeholder="输入任务名称"/></n-form-item>
        <n-form-item label="描述"><n-input v-model:value="newTask.description" type="textarea" placeholder="任务描述"/></n-form-item>
        <n-form-item label="计划"><n-input v-model:value="newTask.schedule" placeholder="如: 每天 9:00"/></n-form-item>
        <n-button type="primary" block @click="createTask">创建</n-button></n-form></n-modal></div>
</template>
<script setup lang="ts">
import { ref, reactive } from 'vue'
const tasks = ref([{ id: '1', name: '每日日志轮转', description: '自动归档过期日志文件', status: 'running', lastRun: '今天 09:00', schedule: '每天 9:00' }, { id: '2', name: 'API 用量统计', description: '统计每日 API 调用量和费用', status: 'idle', lastRun: '今天 08:00', schedule: '每小时' }])
const showCreate = ref(false)
const newTask = reactive({ name: '', description: '', schedule: '' })
function createTask() { tasks.value.unshift({ id: String(Date.now()), name: newTask.name, description: newTask.description, status: 'idle', lastRun: '--', schedule: newTask.schedule }); showCreate.value = false; newTask.name = ''; newTask.description = ''; newTask.schedule = '' }
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.tasks-list { flex: 1; overflow-y: auto; padding: 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); align-content: start; }
.task-card { border: 1px solid var(--border-color); }
.task-header { display: flex; align-items: center; justify-content: space-between; }
.task-name { font-weight: 600; font-size: 14px; }
.task-desc { font-size: 13px; color: var(--text-secondary); margin: 0; }
.task-meta { display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); margin-top: 8px; }
.empty-state { grid-column: 1/-1; margin-top: 80px; }
</style>
