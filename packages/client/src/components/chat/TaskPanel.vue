<template>
  <div class="task-panel" v-if="tasks.length > 0 || showEmpty">
    <!-- 进度条 -->
    <div class="task-progress" v-if="tasks.length > 0">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <span class="progress-text">{{ completedCount }}/{{ tasks.length }} tasks</span>
    </div>

    <!-- 任务列表 -->
    <div class="task-list">
      <TaskItem
        v-for="task in tasks"
        :key="task.id"
        :task="task"
        @toggle="onToggle(task)"
        @delete="onDelete(task)"
      />
    </div>

    <!-- 空状态 -->
    <div v-if="tasks.length === 0 && showEmpty" class="task-empty">
      No tasks yet
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Task } from '@/types'
import TaskItem from './TaskItem.vue'

const props = withDefaults(defineProps<{
  tasks?: Task[]
  showEmpty?: boolean
}>(), {
  tasks: () => [],
  showEmpty: false,
})

const emit = defineEmits<{
  (e: 'toggle', task: Task): void
  (e: 'delete', task: Task): void
}>()

const completedCount = computed(() => props.tasks.filter(t => t.status === 'completed').length)
const progressPercent = computed(() =>
  props.tasks.length > 0 ? Math.round((completedCount.value / props.tasks.length) * 100) : 0
)

function onToggle(task: Task) {
  emit('toggle', task)
}

function onDelete(task: Task) {
  emit('delete', task)
}
</script>

<style scoped>
.task-panel {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.task-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.progress-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s var(--ease-out);
}

.progress-text {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  font-family: var(--font-mono);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-empty {
  text-align: center;
  padding: 16px;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
