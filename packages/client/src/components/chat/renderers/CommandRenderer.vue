<template>
  <div class="command-renderer">
    <!-- 命令卡片展开态：bash 标题 + 命令行 + 输出（对齐 WorkBuddy content-title "bash" + command-line + output） -->
    <div class="cmd-head">
      <span class="cmd-bash-title">bash</span>
      <span class="cmd-prompt">$</span>
      <code class="cmd-line">{{ commandText }}</code>
    </div>
    <div v-if="resultDisplay" class="tool-section">
      <div class="tool-result cmd-output">{{ truncatedOutput }}</div>
    </div>
    <!-- 完成后空输出：显示成功提示（WorkBuddy run successfully ✓ 同款） -->
    <div v-else-if="status === 'done'" class="tool-section">
      <div class="tool-result cmd-success">{{ $t('chatui.runSuccessfully') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * 命令执行渲染器（shell_exec 专属，WorkBuddy ExecuteCommandRenderer 同款）。
 * header（状态/风险标签/授权）由 ToolCallBlock 外壳负责，这里只渲染命令正文与输出。
 */
const props = withDefaults(defineProps<{
  args?: string
  result?: string
  status?: string
}>(), { args: '', result: '', status: 'done' })

/** 从 args 提取命令文本 */
const commandText = computed(() => {
  if (!props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    return typeof obj.command === 'string' ? obj.command : ''
  } catch {
    return props.args.slice(0, 200)
  }
})

const resultDisplay = computed(() => !!(props.result || '').trim())

/** stdout 截断：保留尾部 500 行（学 WorkBuddy truncateByLines tail） */
const truncatedOutput = computed(() => {
  const out = props.result || ''
  const lines = out.split('\n')
  if (lines.length <= 500) return out
  return '...（省略前 ' + (lines.length - 500) + ' 行）\n' + lines.slice(-500).join('\n')
})
</script>

<style scoped>
.cmd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-primary);
  border-radius: var(--radius-xs, 6px);
  padding: 6px 10px;
  margin-bottom: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
/* bash 语言标题（对齐 WorkBuddy execute-command-compact__content-title） */
.cmd-bash-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, rgba(128, 128, 128, 0.8));
  text-transform: none;
  background: var(--bg-hover, rgba(128, 128, 128, 0.12));
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.cmd-prompt {
  color: var(--success, #0f766e);
  font-weight: 600;
  flex-shrink: 0;
}
.cmd-line {
  font-size: 11px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}
.tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tool-result {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-primary);
  padding: 8px;
  border-radius: var(--radius-xs, 6px);
  max-height: 200px;
  overflow-y: auto;
}
.cmd-output {
  max-height: 320px;
}
/* 完成后空输出成功提示（WorkBuddy run successfully ✓ 同款） */
.cmd-success {
  color: var(--success, #2ea043);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.cmd-success::before {
  content: '✓';
  font-weight: 700;
}
</style>
