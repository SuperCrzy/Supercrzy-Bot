<template>
  <div class="thinking-block">
    <div class="thinking-header">
      <span class="thinking-icon">🧠</span>
      <span class="thinking-text">{{ message }}</span>
      <span class="thinking-dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  message: string
  turn?: number
}>()
</script>

<style scoped>
.thinking-block {
  padding: 6px 12px;
  margin: 4px 0;
  border-radius: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-secondary);
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.thinking-icon {
  font-size: 14px;
}

.thinking-text {
  flex: 1;
}

.thinking-dots {
  display: flex;
  gap: 3px;
}

.thinking-dots .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: dot-pulse 1.4s infinite ease-in-out;
}

.thinking-dots .dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes dot-pulse {
  0%, 60%, 100% { transform: scale(1); opacity: 0.4; }
  30% { transform: scale(1.5); opacity: 1; }
}
</style>
