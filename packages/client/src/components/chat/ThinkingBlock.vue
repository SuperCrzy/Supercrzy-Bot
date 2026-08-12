<template>
  <div class="thinking-block" :class="{ completed: isCompleted }">
    <div class="thinking-indicator">
      <div class="thinking-pulse" :class="{ active: !isCompleted }"></div>
    </div>
    <div class="thinking-content">
      <div class="thinking-header">
        <span class="thinking-turn">Turn {{ turn }}</span>
        <span class="thinking-message">{{ message }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  message: string
  turn?: number
  completed?: boolean
}>(), {
  turn: 1,
  completed: false,
})

const isCompleted = computed(() => props.completed)
</script>

<style scoped>
.thinking-block {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  margin: 2px 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  transition: opacity var(--duration-fast) var(--ease-out);
}

.thinking-block.completed {
  opacity: 0.5;
}

/* Pulse indicator */
.thinking-indicator {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 4px;
  position: relative;
}

.thinking-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  position: relative;
}

.thinking-pulse.active::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.3;
  animation: pulse-ring 1.5s ease-out infinite;
}

.thinking-pulse.active::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.1;
  animation: pulse-ring 1.5s ease-out infinite 0.3s;
}

@keyframes pulse-ring {
  0% { transform: scale(0.8); opacity: 0.4; }
  100% { transform: scale(2); opacity: 0; }
}

.thinking-block.completed .thinking-pulse {
  background: var(--text-muted);
}

/* Content */
.thinking-content {
  flex: 1;
  min-width: 0;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-turn {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-muted);
  color: var(--accent);
  flex-shrink: 0;
}

.dark .thinking-turn {
  background: rgba(129, 140, 248, 0.15);
  color: var(--accent);
}

.thinking-block.completed .thinking-turn {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.thinking-message {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
</style>
