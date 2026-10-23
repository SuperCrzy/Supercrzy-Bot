<template>
  <div class="ac-card">
    <!-- meta 行：动作徽标 + 目标。折叠/展开由 ToolCallBlock 外壳负责 -->
    <div class="ac-meta">
      <span class="ac-badge" :class="{ err: failed }">{{ summary?.action || '?' }}</span>
      <span v-if="summary?.target" class="ac-target" :title="summary.target">{{ summary.target }}</span>
      <span v-if="summary?.extra" class="ac-extra" :title="summary.extra">→ {{ summary.extra }}</span>
      <span class="ac-spacer"></span>
      <span v-if="headline && !failed" class="ac-headline">{{ headline }}</span>
    </div>

    <div class="ac-body">
      <!-- 解析失败就老实显示原文 -->
      <pre v-if="!summary" class="ac-raw">{{ result || '?' }}</pre>
      <template v-else>
        <pre v-if="detailLines" class="ac-raw ac-detail">{{ result }}</pre>
        <div v-else-if="!result" class="ac-empty">{{ $t('chat.actionCardRunning') }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * browser / computer_use 共用动作卡（G4，2026-10-23）。
 *
 * 为什么不走 generic：这两类调用用户最关心的是"做了什么动作、对着什么目标、成没成"。
 * generic 卡把参数 JSON 一坨贴出来，`{"action":"navigate","url":"https://…"}` 里目标
 * 淹没在引号和括号里；动作卡把它拆成 徽标 + 目标 + 结论 三层。
 *
 * 解析在 `utils/action-tool.ts`（纯函数 + 测试）；解析失败回落原文。
 * 截图本身不内嵌（走右栏 tab 实时画面，那是既有通道），卡内只给文字事实。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseBrowserCall, parseComputerUseCall, firstLine } from '@/utils/action-tool'

const props = defineProps<{
  result?: string
  args?: string
  /** 'browser' | 'computer-use'，由 ToolCallBlock 按 rendererKey 传入 */
  kind?: 'browser' | 'computer-use'
}>()

const { t } = useI18n({ useScope: 'global' })

const summary = computed(() =>
  props.kind === 'computer-use'
    ? parseComputerUseCall(props.args)
    : parseBrowserCall(props.args),
)

const failed = computed(() => /^❌|⛔|失败/.test(firstLine(props.result)))

/** 首行有实际信息且不是错误时，meta 行给出结论（如"已打开 https://…"） */
const headline = computed(() => {
  const l = firstLine(props.result)
  if (!l || failed.value) return ''
  return l.length > 80 ? l.slice(0, 80) + '…' : l
})

/** 多行输出（look 的可交互元素清单等）在展开体里完整显示 */
const detailLines = computed(() => {
  const text = String(props.result || '')
  return text.includes('\n')
})
</script>

<style scoped>
.ac-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.ac-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-primary);
}
.ac-badge {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 1px 6px;
}
.ac-badge.err {
  color: var(--error, #e5484d);
  border-color: var(--error, #e5484d);
}
.ac-target {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46%;
}
.ac-extra { font-size: 11px; color: var(--text-muted); }
.ac-spacer { flex: 1; }
.ac-headline {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.ac-body { border-top: 1px solid var(--border-color); }
.ac-detail { max-height: 260px; }
.ac-empty { padding: 10px; font-size: 12px; color: var(--text-muted); }
.ac-raw {
  margin: 0;
  padding: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
</style>
