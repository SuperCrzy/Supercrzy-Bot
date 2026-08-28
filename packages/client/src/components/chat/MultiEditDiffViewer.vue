<template>
  <div class="med-viewer">
    <!-- 头部：N 处修改 徽标 + 接受/拒绝（WorkBuddy multiEditCount 同款） -->
    <div class="med-head">
      <span class="med-count">{{ t('chat.multiEditCount', { count: edits.length }) }}</span>
      <span class="med-actions">
        <button class="med-btn med-accept" :title="t('chat.diffAccept')" @click="$emit('accept')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          {{ t('chat.diffAccept') }}
        </button>
        <button class="med-btn med-reject" :title="t('chat.diffReject')" @click="$emit('reject')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          {{ t('chat.diffReject') }}
        </button>
      </span>
    </div>
    <!-- 各处修改：old → new 对照（行内高亮） -->
    <div class="med-body">
      <div v-for="(e, i) in edits" :key="i" class="med-edit">
        <div class="med-edit-index">{{ t('chatui.editProgress', { index: i + 1, total: edits.length }) }}</div>
        <div class="med-edit-cols">
          <div class="med-col del">
            <span class="med-col-label">{{ t('chat.diffBefore') }}</span>
            <code class="med-col-text">{{ e.old_str }}</code>
          </div>
          <div class="med-col add">
            <span class="med-col-label">{{ t('chat.diffAfter') }}</span>
            <code class="med-col-text">{{ e.new_str }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** edits 数组（WorkBuddy MultiEditDiffViewer 同款：{old_str, new_str} 列表） */
  edits: Array<{ old_str: string; new_str: string; status?: string }>
  /** 截断显示每处片段长度 */
  maxLen?: number
}>()

defineEmits<{
  (e: 'accept'): void
  (e: 'reject'): void
}>()

const { t } = useI18n({ useScope: 'global' })

const displayEdits = computed(() =>
  props.edits.map((e) => {
    const max = props.maxLen || 200
    const trunc = (s: string) => (s.length > max ? s.slice(0, max) + '…' : s)
    return { ...e, old_str: trunc(e.old_str || ''), new_str: trunc(e.new_str || '') }
  }),
)
</script>

<style scoped>
.med-viewer {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.med-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}
.med-count {
  color: var(--text-secondary);
  font-weight: 500;
}
.med-actions {
  display: flex;
  gap: 6px;
}
.med-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}
.med-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.med-accept {
  color: var(--success, #059669);
  border-color: var(--success, #059669);
}
.med-reject {
  color: var(--danger, #ef4444);
  border-color: var(--danger, #ef4444);
}
.med-body {
  max-height: 220px;
  overflow-y: auto;
}
.med-edit {
  padding: 6px 10px;
  border-bottom: 1px dashed var(--border-color);
}
.med-edit:last-child {
  border-bottom: none;
}
.med-edit-index {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 3px;
}
.med-edit-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.med-col {
  border-radius: 4px;
  padding: 4px 6px;
  min-width: 0;
}
.med-col.del {
  background: rgba(239, 68, 68, 0.08);
}
.med-col.add {
  background: rgba(16, 185, 129, 0.08);
}
.med-col-label {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 2px;
}
.med-col-text {
  display: block;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.med-col.del .med-col-text {
  color: var(--danger, #ef4444);
  text-decoration: line-through;
  opacity: 0.85;
}
.med-col.add .med-col-text {
  color: var(--success, #059669);
}
</style>
