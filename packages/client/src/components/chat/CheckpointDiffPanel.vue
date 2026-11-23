<script setup lang="ts">
/**
 * Per-file diff for a checkpoint, with single-file rollback.
 *
 * The panel answers the question a checkpoint used to leave open: "it says five
 * files changed — which five, and what happened inside them?" Rollback is per file
 * on purpose: after reviewing a batch you usually want to keep most of it and undo
 * one wrong edit, not throw the whole turn away.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'

const props = defineProps<{ checkpointId: string | null; visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n({ useScope: 'global' })
const message = useMessage()

interface DiffLine { type: 'keep' | 'add' | 'del'; line: string }
interface DiffFile {
  path: string
  metadataOnly: boolean
  diffUnavailable?: boolean
  existed: boolean
  sizeBefore: number
  sizeAfter: number
  added?: number
  deleted?: number
  lines?: DiffLine[]
  truncated?: boolean
}

const files = ref<DiffFile[]>([])
const loading = ref(false)
const error = ref('')
const restoring = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

async function load() {
  if (!props.checkpointId) return
  loading.value = true
  error.value = ''
  files.value = []
  try {
    const r = await fetch(`/api/checkpoints/${encodeURIComponent(props.checkpointId)}/diff`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    files.value = data.files || []
    // Open the first file with actual changes: that is almost always the one the
    // user came to look at.
    const first = files.value.find((f) => !f.metadataOnly && ((f.added || 0) + (f.deleted || 0)) > 0)
    if (first) expanded.value = new Set([first.path])
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

function toggle(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

async function restoreOne(f: DiffFile) {
  if (!props.checkpointId) return
  restoring.value = f.path
  try {
    const r = await fetch(`/api/checkpoints/${encodeURIComponent(props.checkpointId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [f.path] }),
    })
    const data = await r.json()
    const result = (data.results || []).find((x: any) => x.path === f.path)
    if (result?.ok) {
      message.success(result.action === 'deleted' ? t('checkpointDiff.restoreDeleted') : t('checkpointDiff.restoreOk'))
      await load()
    } else {
      message.error(result?.message || data.error || t('checkpointDiff.restoreFail'))
    }
  } catch (e: any) {
    message.error(e?.message || t('checkpointDiff.restoreFail'))
  } finally {
    restoring.value = null
  }
}

const totalChanged = computed(() => files.value.filter((f) => !f.metadataOnly).length)

watch(() => [props.visible, props.checkpointId], ([v, id]) => {
  if (v && id) void load()
}, { immediate: true })
</script>

<template>
  <div v-if="visible" class="diff-panel">
    <div class="dp-head">
      <span class="dp-title">{{ t('checkpointDiff.title') }}</span>
      <span v-if="totalChanged" class="dp-count">{{ t('checkpointDiff.fileCount', { n: totalChanged }) }}</span>
      <button class="dp-close" type="button" @click="emit('close')">×</button>
    </div>

    <div v-if="loading" class="dp-hint">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="dp-hint err">{{ error }}</div>
    <div v-else-if="files.length === 0" class="dp-hint">{{ t('checkpointDiff.empty') }}</div>

    <div v-else class="dp-list">
      <div v-for="f in files" :key="f.path" class="dp-file">
        <button class="dp-file-head" type="button" @click="toggle(f.path)">
          <span class="dp-file-name" :title="f.path">{{ basename(f.path) }}</span>
          <span v-if="f.metadataOnly" class="dp-badge">{{ t('checkpointDiff.metadataOnly') }}</span>
          <span v-else-if="f.diffUnavailable" class="dp-badge">{{ t('checkpointDiff.diffUnavailable') }}</span>
          <span v-else class="dp-stat"><b class="add">+{{ f.added || 0 }}</b> <b class="del">-{{ f.deleted || 0 }}</b></span>
          <n-button
            size="tiny"
            quaternary
            :loading="restoring === f.path"
            :disabled="f.metadataOnly"
            @click.stop="restoreOne(f)"
          >{{ t('checkpointDiff.rollback') }}</n-button>
        </button>
        <div v-if="expanded.has(f.path) && f.lines?.length" class="dp-lines">
          <div v-for="(l, i) in f.lines" :key="i" class="dp-line" :class="l.type">
            <span class="dp-gutter">{{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }}</span>
            <span class="dp-text">{{ l.line }}</span>
          </div>
          <div v-if="f.truncated" class="dp-hint">{{ t('checkpointDiff.truncated') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-panel {
  position: absolute; inset: 0; z-index: 120;
  background: var(--bg-sidebar);
  display: flex; flex-direction: column;
  border-left: 1px solid var(--border-color);
}
.dp-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--border-color);
  font-size: 12px;
}
.dp-title { font-weight: 600; color: var(--text-primary); }
.dp-count { color: var(--text-tertiary); font-size: 11px; }
.dp-close {
  margin-left: auto; border: none; background: transparent;
  color: var(--text-tertiary); font-size: 16px; cursor: pointer; line-height: 1;
}
.dp-hint { padding: 16px 12px; color: var(--text-tertiary); font-size: 12px; }
.dp-hint.err { color: var(--error); }
.dp-list { overflow: auto; flex: 1; }
.dp-file { border-bottom: 1px solid var(--border-color); }
.dp-file-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; background: transparent;
  cursor: pointer; text-align: left; font-size: 12px; color: var(--text-primary);
}
.dp-file-head:hover { background: var(--bg-hover, rgba(0,0,0,.05)); }
.dp-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-stat { font-family: var(--font-mono, monospace); font-size: 11px; }
.dp-stat .add { color: #1a7f37; }
.dp-stat .del { color: #cf222e; }
.dp-badge { font-size: 10px; color: var(--text-tertiary); }
.dp-lines {
  margin: 0; padding: 4px 0; background: var(--bg-code, rgba(0,0,0,.03));
  font-family: var(--font-mono, monospace); font-size: 11px;
  max-height: 320px; overflow: auto;
}
.dp-line { display: flex; gap: 6px; padding: 0 10px; white-space: pre-wrap; word-break: break-word; }
.dp-line.add { background: rgba(26,127,55,.10); }
.dp-line.del { background: rgba(207,34,46,.10); }
.dp-gutter { flex: 0 0 8px; color: var(--text-tertiary); user-select: none; }
.dp-text { flex: 1; }
</style>
