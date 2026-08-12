<template>
  <div class="task-item" :class="[task.status, { blocked: isBlocked }]">
    <!-- Checkbox -->
    <span class="task-checkbox" @click="handleToggle">
      <svg v-if="task.status === 'completed'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <svg v-else-if="task.status === 'in_progress'" class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 6v6l4 2"/>
      </svg>
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
      </svg>
    </span>

    <!-- Content -->
    <div class="task-content">
      <span class="task-subject" :class="{ completed: task.status === 'completed' }">
        <template v-if="task.status === 'in_progress' && task.activeForm">
          {{ task.activeForm }}
        </template>
        <template v-else>
          {{ task.subject }}
        </template>
      </span>
      <span v-if="isBlocked && task.blockedBy" class="task-blocked-badge" title="Waiting for dependencies">
        🔒 {{ task.blockedBy.length }} blocked
      </span>
    </div>

    <!-- Delete -->
    <button v-if="task.status === 'completed'" class="task-delete" @click.stop="handleDelete" title="Delete task">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Task } from '@/types'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'delete'): void }>()

const isBlocked = computed(() =>
  (props.task.blockedBy?.length || 0) > 0 &&
  props.task.status !== 'completed'
)

function handleToggle() {
  emit('toggle')
}

function handleDelete() {
  emit('delete')
}
</script>

<style scoped>
.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  transition: background var(--duration-fast);
  cursor: default;
}

.task-item:hover {
  background: var(--bg-hover);
}

.task-item.blocked {
  opacity: 0.45;
  pointer-events: none;
}

.task-checkbox {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
  padding: 2px;
}

.task-content {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.task-subject {
  font-size: 13px;
  color: var(--text-primary);
  transition: color var(--duration-fast);
}

.task-subject.completed {
  text-decoration: line-through;
  color: var(--text-muted);
}

.task-item.in_progress .task-subject {
  font-weight: 500;
}

.task-blocked-badge {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}

.task-delete {
  display: flex;
  align-items: center;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity var(--duration-fast);
}

.task-item:hover .task-delete {
  opacity: 1;
}

.task-delete:hover {
  color: var(--error);
  background: var(--error-muted);
}

.spin {
  animation: spin 1.5s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
