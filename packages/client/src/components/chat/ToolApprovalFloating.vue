<template>
  <!-- 授权浮层（对齐主流实现 InterceptCard + tool-approval-floating-portal）：
       待授权工具浮在对话区顶部，醒目但不推挤消息流；header 按钮同时保留 -->
  <div class="tool-approval-floating">
    <div class="taf-card" :class="`taf-risk-${riskLevel}`">
      <div class="taf-header">
        <span class="taf-title">{{ titleText }}</span>
        <span class="taf-risk" :class="`taf-risk-tag-${riskLevel}`">{{ riskLabel }}</span>
      </div>
      <div class="taf-command" :title="summaryText">{{ summaryText }}</div>
      <div class="taf-options">
        <button class="taf-option taf-opt-deny" @click="$emit('deny', tool)">
          <span class="taf-opt-index">1</span>{{ $t('chatui.deny') }}
        </button>
        <button class="taf-option taf-opt-session" @click="$emit('allow-session', tool)">
          <span class="taf-opt-index">2</span>{{ $t('chatui.allowSession') }}
        </button>
        <button class="taf-option taf-opt-allow" @click="$emit('allow', tool)">
          <span class="taf-opt-index">3</span>{{ $t('chatui.allow') }}
          <span v-if="countdown > 0" class="taf-countdown">{{ countdown }}s</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCallEvent } from '@/types'

const { t } = useI18n({ useScope: 'global' })

const props = withDefaults(defineProps<{
  tool: ToolCallEvent
  autoApproveSeconds?: number
}>(), { autoApproveSeconds: 0 })

defineEmits<{
  (e: 'allow', tool: ToolCallEvent): void
  (e: 'deny', tool: ToolCallEvent): void
  (e: 'allow-session', tool: ToolCallEvent): void
}>()

/** 风险等级：删除=高，写文件/命令=中（对齐主流实现 riskTag level） */
const riskLevel = computed<'high' | 'medium'>(() => (props.tool.name === 'file_delete' ? 'high' : 'medium'))

const riskLabel = computed(() =>
  riskLevel.value === 'high' ? (t('chatui.riskHigh') || '高风险') : (t('chatui.riskMedium') || '中风险'),
)

/** 标题：按工具类型给动作词（Run Command? / Delete file? / Write file? 同款） */
const titleText = computed(() => {
  switch (props.tool.name) {
    case 'file_delete':
      return t('chatui.approvalDelete') || '删除文件？'
    case 'file_write':
      return t('chatui.approvalWrite') || '写入文件？'
    default:
      return t('chatui.runCommandAsk') || '执行命令？'
  }
})

/** 摘要：命令/路径单行（超长 Tooltip） */
const summaryText = computed(() => {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(props.tool.arguments || '{}')
  } catch {
    return props.tool.arguments || ''
  }
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (Array.isArray(args.paths)) return args.paths.join(', ')
  return props.tool.arguments || props.tool.name
})

// 自动允许倒计时（对齐 ToolCallBlock countdown：pending 时 5s 递减，真正放行由后端超时策略决定）
const countdown = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.tool.status,
  (s) => {
    if (s === 'pending' && props.autoApproveSeconds > 0) {
      countdown.value = props.autoApproveSeconds
      if (!timer) {
        timer = setInterval(() => {
          countdown.value = Math.max(0, countdown.value - 1)
          if (countdown.value <= 0 && timer) {
            clearInterval(timer)
            timer = null
          }
        }, 1000)
      }
    } else if (timer) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
/* 浮层容器：absolute 定位在 chat-container（对话工作区，position:relative 不滚动）内，
   对话栏水平居中、底部锚在输入框上方，从底部向上滑（2026-08-27 重构：不再 fixed 全屏居中） */
.tool-approval-floating {
  position: absolute;
  bottom: 104px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  max-width: min(560px, calc(100% - 32px));
  animation: taf-slide-up 0.26s ease-out;
}
@keyframes taf-slide-up {
  from { opacity: 0; transform: translate(-50%, 26px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
.taf-card {
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  padding: 10px 14px;
  /* 脉冲提醒（2026-08-27 加）：上滑出现后，闪 2 下 → 停几秒 → 再闪 2 下 → 循环。delay 0.26s=等上滑播完 */
  animation: taf-pulse 4s ease-in-out 0.26s infinite;
}
/* 周期 4s：0-0.5s 闪2下 → 停到 2s → 再闪2下 → 停到 4s 循环 */
@keyframes taf-pulse {
  0%, 5%, 10% { box-shadow: 0 0 0 0 rgba(99,102,241,0); border-color: var(--border-color, rgba(128,128,128,0.3)); }
  2.5%, 12.5% { box-shadow: 0 0 0 6px rgba(99,102,241,0.35); border-color: rgba(99,102,241,0.7); }
  /* 首次两下在 0-0.5s；停到 50%(2s) 后开始第二轮 */
  50% { box-shadow: 0 0 0 0 rgba(99,102,241,0); border-color: var(--border-color, rgba(128,128,128,0.3)); }
  52.5%, 62.5% { box-shadow: 0 0 0 6px rgba(99,102,241,0.35); border-color: rgba(99,102,241,0.7); }
  100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); border-color: var(--border-color, rgba(128,128,128,0.3)); }
}
.taf-card.taf-risk-high { border-color: rgba(209, 36, 47, 0.55); }
.taf-card.taf-risk-medium { border-color: rgba(180, 83, 9, 0.45); }
.taf-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.taf-title {
  font-size: 13px;
  font-weight: 600;
}
.taf-risk {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 9px;
}
.taf-risk-tag-high { background: rgba(209, 36, 47, 0.12); color: #d1242f; }
.taf-risk-tag-medium { background: rgba(180, 83, 9, 0.12); color: #b45309; }
.taf-command {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--text-secondary, inherit);
  background: var(--bg-hover, rgba(128, 128, 128, 0.1));
  border-radius: 6px;
  padding: 5px 9px;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.taf-options {
  display: flex;
  gap: 6px;
}
.taf-option {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  background: transparent;
  color: var(--text-primary, inherit);
  cursor: pointer;
  transition: background 0.15s;
}
.taf-option:hover { background: var(--bg-hover, rgba(128, 128, 128, 0.12)); }
.taf-opt-index {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary, rgba(128, 128, 128, 0.8));
  border: 1px solid currentColor;
  border-radius: 50%;
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.taf-opt-deny { color: #d1242f; }
.taf-opt-session { color: var(--accent, #4f8cff); }
.taf-opt-allow { color: #2ea043; border-color: rgba(46, 160, 67, 0.45); background: rgba(46, 160, 67, 0.08); }
.taf-countdown {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.75;
}
</style>
