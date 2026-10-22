<template>
  <!-- 流式痕迹行（B1，2026-10-22）：跑完的动作**留痕**，不再被下一个动作顶掉。
       只显示**已终态**的工具动作（非终态由下方状态行承担），最多留最近 4 条：
       再多就变成第二条消息正文，收尾时又会被折叠条收走 —— 4 条足够看出"它在干什么"。 -->
  <div v-if="rows.length" class="action-trail">
    <div
      v-for="r in rows"
      :key="r.key"
      class="at-row"
      :class="{ 'at-row--failed': r.failed, 'at-row--muted': r.cancelled }"
    >
      <ToolTypeIcon :type="r.icon" :size="12" class="at-icon" />
      <span class="at-label">{{ r.label }}</span>
      <span v-if="r.target" class="at-target" :title="r.target">{{ r.target }}</span>
      <span v-if="r.duration" class="at-duration">{{ r.duration }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveActiveAction, type ProcessNodeLike } from '@/utils/process-view'
import { resolveTrailRows } from '@/utils/action-trail'
import ToolTypeIcon from './ToolTypeIcon.vue'

const props = defineProps<{
  /** 本过程段节点（thinking / thinking-group / tool），顺序同 flow */
  nodes: ProcessNodeLike[]
  /** 最多保留几条痕迹（默认 4） */
  max?: number
}>()

const { t } = useI18n({ useScope: 'global' })
const tt = computed(() => t as unknown as (key: string, params?: Record<string, unknown>) => string)

/** 状态行当前动作：同一条不能既在状态行又在痕迹行（否则同一动作出现两次） */
const activeKey = computed(() => resolveActiveAction(props.nodes || [], tt.value).key)
const rows = computed(() =>
  resolveTrailRows(props.nodes || [], tt.value, {
    activeKey: activeKey.value,
    max: props.max && props.max > 0 ? props.max * 3 : 12,
  }).slice(-(props.max && props.max > 0 ? props.max : 4)),
)
</script>

<style scoped>
.action-trail {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 0 4px 1px;
  max-width: 100%;
}
.at-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 20px;
  font-size: 12px;
  line-height: 20px;
  color: var(--text-secondary, #5f5e5a);
}
.at-icon { flex: 0 0 auto; color: var(--text-muted, #888780); }
.at-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.at-target {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted, #888780);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.at-duration {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 6px;
  color: var(--text-muted, #888780);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.at-row--failed .at-label { color: var(--danger, #dc2626); }
.at-row--failed .at-icon { color: var(--danger, #dc2626); }
.at-row--muted { opacity: 0.72; }
</style>
