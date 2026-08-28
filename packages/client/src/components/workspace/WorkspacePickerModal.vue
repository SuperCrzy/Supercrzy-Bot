<template>
  <div v-if="show" class="fs-overlay" @click.self="close">
    <div class="fs-modal">
      <div class="fs-head">
        <span>{{ $t('chat.fsTitle') }}</span>
        <button class="fs-close" @click="close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <!-- 搜索 -->
      <input
        v-model="fsSearchQ"
        class="fs-search"
        :placeholder="$t('chat.fsSearchPlaceholder')"
        spellcheck="false"
        @input="onFsSearch"
      />
      <div v-if="fsResults.length > 0" class="fs-results">
        <div class="fs-section-label">{{ $t('chat.fsSearchResults') }}</div>
        <div v-for="r in fsResults" :key="r.path" class="fs-item" @click="select(r.path)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="fs-item-name">{{ r.name }}</span>
          <span class="fs-item-path">{{ r.path }}</span>
        </div>
      </div>
      <div v-else class="fs-browse">
        <div class="fs-section-label">{{ $t('chat.fsBrowse') }}</div>
        <!-- 当前路径 + 手动输入 -->
        <div class="fs-path-row">
          <button v-if="fsParent" class="fs-up" @click="browseTo(fsParent)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            {{ $t('chat.fsUp') }}
          </button>
          <input v-model="fsPathInput" class="fs-path-input" spellcheck="false" @keydown.enter.prevent="browseTo(fsPathInput)" />
          <button class="fs-go" @click="browseTo(fsPathInput)">{{ $t('chat.fsGo') }}</button>
        </div>
        <div class="fs-dirs">
          <div v-for="d in fsDirs" :key="d.path" class="fs-item" @click="browseTo(d.path)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span class="fs-item-name">{{ d.name }}</span>
          </div>
          <div v-if="fsDirs.length === 0" class="fs-empty">{{ $t('chat.fsEmpty') }}</div>
        </div>
      </div>
      <div class="fs-foot">
        <button class="fs-use" :disabled="!fsPathInput" @click="select(fsPathInput)">{{ $t('chat.fsUseThis') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  show: boolean
  /** 打开时初始定位的目录（默认 '/'） */
  initialPath?: string
}>()
const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'close'): void
}>()

const fsPathInput = ref('')
const fsDirs = ref<Array<{ name: string; path: string }>>([])
const fsParent = ref<string | null>(null)
const fsSearchQ = ref('')
const fsResults = ref<Array<{ name: string; path: string }>>([])
let fsSearchTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.show,
  (v) => {
    if (v) open()
  }
)

/** 打开：重置搜索态并定位到初始目录 */
async function open() {
  fsResults.value = []
  fsSearchQ.value = ''
  await browseTo(props.initialPath || '/')
}

/** 浏览指定路径的子目录 */
async function browseTo(path: string) {
  if (!path) return
  try {
    const r = await fetch(`/api/filesystem/dirs?path=${encodeURIComponent(path)}`)
    const d = await r.json()
    if (d.error) return
    fsPathInput.value = d.path
    fsDirs.value = d.dirs || []
    fsParent.value = d.parent || null
  } catch {}
}

/** 搜索目录（防抖 350ms） */
function onFsSearch() {
  if (fsSearchTimer) clearTimeout(fsSearchTimer)
  const q = fsSearchQ.value.trim()
  if (q.length < 2) {
    fsResults.value = []
    return
  }
  fsSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/filesystem/search?q=${encodeURIComponent(q)}`)
      const d = await r.json()
      fsResults.value = d.results || []
    } catch {
      fsResults.value = []
    }
  }, 350)
}

/** 选中目录 → 通知父组件并关闭 */
function select(path: string) {
  if (!path) return
  emit('select', path)
  close()
}

function close() {
  emit('close')
}
</script>

<style scoped>
.fs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fs-modal {
  width: min(520px, 92vw);
  max-height: 70vh;
  background: var(--bg-primary);
  border-radius: 16px;
  border: 0.5px solid var(--border-color);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}
.fs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
.fs-close {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fs-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.fs-search {
  width: 100%;
  border: 0.5px solid var(--border-color);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg-secondary);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
}
.fs-search:focus {
  border-color: var(--accent);
}
.fs-section-label {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.fs-results,
.fs-browse {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  max-height: 40vh;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 13px;
}
.fs-item:hover {
  background: var(--bg-hover);
}
.fs-item-name {
  font-weight: 500;
  flex-shrink: 0;
}
.fs-item-path {
  font-size: 11.5px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.fs-up,
.fs-go {
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  border: 0.5px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.fs-up:hover,
.fs-go:hover {
  background: var(--bg-hover);
}
.fs-path-input {
  flex: 1;
  min-width: 0;
  border: 0.5px solid var(--border-color);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  color: var(--text-primary);
  outline: none;
}
.fs-path-input:focus {
  border-color: var(--accent);
}
.fs-empty {
  padding: 20px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-muted);
}
.fs-foot {
  display: flex;
  justify-content: flex-end;
}
.fs-use {
  height: 32px;
  padding: 0 18px;
  border: none;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.fs-use:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
