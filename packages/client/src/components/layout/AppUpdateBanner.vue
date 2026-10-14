<template>
  <!--
    2026-10-12 新建：App 自身自动更新横幅。
    背景：旧实现里 download-progress 只写 console.log，「发现新版本」又走 electron.dialog（系统原生窗，
    不在窗口内），渲染进程也从未订阅 preload 的 onAppUpdate ⇒ 用户点完「立即更新」后窗口内毫无反馈。
    现在主进程把 electron-updater 状态经 'app-update-state' 推到这里，本横幅是唯一的更新 UI。
    只在 available / downloading / downloaded / error 出现；checking 与 idle 静默（启动自动检查不该打扰）。
  -->
  <div v-if="visible" class="app-update-banner" :class="`st-${state.status}`" role="status" aria-live="polite">
    <span class="aub-icon" aria-hidden="true">
      <svg v-if="state.status === 'downloading'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <svg v-else-if="state.status === 'downloaded'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <svg v-else-if="state.status === 'error'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12" />
        <polyline points="7 10 12 15 17 10" />
        <path d="M5 21h14" />
      </svg>
    </span>

    <div class="aub-body">
      <div class="aub-line">
        <span class="aub-title">{{ title }}</span>
        <span v-if="detail" class="aub-detail">{{ detail }}</span>
      </div>
      <div v-if="state.status === 'downloading'" class="aub-track">
        <div class="aub-fill" :style="{ width: pct + '%' }"></div>
      </div>
    </div>

    <div class="aub-actions">
      <button v-if="state.status === 'available'" class="aub-btn aub-btn-primary" @click="onDownload">
        {{ $t('appUpdate.updateNow') }}
      </button>
      <button v-if="state.status === 'downloaded'" class="aub-btn aub-btn-primary" @click="onInstall">
        {{ $t('appUpdate.restartInstall') }}
      </button>
      <button class="aub-btn aub-btn-ghost" @click="onDismiss">{{ dismissLabel }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

// idle = 尚未检查 / 用户关掉提示；latest = 已检查且确认无新版（两者都不显示横幅）
type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'

interface UpdateState {
  status: UpdateStatus
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  message?: string
}

interface UpdateBridge {
  getState: () => Promise<UpdateState>
  onState: (cb: (s: UpdateState) => void) => () => void
  download: () => Promise<unknown>
  install: () => Promise<{ ok: boolean; message?: string }>
  dismiss: () => Promise<unknown>
}

const state = ref<UpdateState>({ status: 'idle' })

/** 纯 Web 形态没有这个桥 ⇒ 横幅自然不出现 */
const bridge = () => (window as { supercrzyDesktop?: { update?: UpdateBridge } }).supercrzyDesktop?.update

let off: (() => void) | null = null

onMounted(async () => {
  const b = bridge()
  if (!b) return
  // 事件可能早于订阅（主进程启动 6s 后即检查），先补拉一次当前状态
  try {
    const s = await b.getState()
    if (s) state.value = s
  } catch { /* 桥不可用 */ }
  try {
    off = b.onState((s) => {
      if (s) state.value = s
    })
  } catch { /* 订阅失败 */ }
})

onBeforeUnmount(() => {
  try {
    off && off()
  } catch { /* 忽略 */ }
})

const visible = computed(() => ['available', 'downloading', 'downloaded', 'error'].includes(state.value.status))

const pct = computed(() => Math.max(0, Math.min(100, Math.round(state.value.percent ?? 0))))

const title = computed(() => {
  const s = state.value
  const v = s.version || ''
  switch (s.status) {
    case 'available':
      return t('appUpdate.available', { version: v })
    case 'downloading':
      return `${t('appUpdate.downloading')} ${pct.value}%`
    case 'downloaded':
      return t('appUpdate.downloaded', { version: v })
    case 'error':
      return t('appUpdate.failed')
    default:
      return ''
  }
})

const detail = computed(() => {
  const s = state.value
  if (s.status === 'available') return t('appUpdate.availableHint')
  if (s.status === 'downloaded') return t('appUpdate.downloadedHint')
  if (s.status === 'error') return s.message || ''
  if (s.status === 'downloading') {
    const mb = (n?: number) => (typeof n === 'number' ? (n / 1048576).toFixed(1) : '')
    const speed = typeof s.bytesPerSecond === 'number' ? ` · ${(s.bytesPerSecond / 1048576).toFixed(1)} MB/s` : ''
    return s.total ? `${mb(s.transferred)} / ${mb(s.total)} MB${speed}` : ''
  }
  return ''
})

const dismissLabel = computed(() =>
  state.value.status === 'available' || state.value.status === 'downloaded'
    ? t('appUpdate.later')
    : t('appUpdate.dismiss'),
)

async function onDownload() {
  try {
    await bridge()?.download()
  } catch { /* 失败会由主进程的 error 状态带回来 */ }
}

async function onInstall() {
  const b = bridge()
  if (!b) return
  try {
    // quitAndInstall 失败时（典型：adhoc 签名被 Squirrel.Mac 拒绝）主进程已推 error 状态；
    // 成功时应用会自行退出重启，这里无需额外处理。
    await b.install()
  } catch { /* 忽略 */ }
}

async function onDismiss() {
  try {
    await bridge()?.dismiss()
  } catch { /* 忽略 */ }
}
</script>

<style scoped>
.app-update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: var(--text-sm);
  animation: aub-in var(--duration-normal) var(--ease-out);
}
@keyframes aub-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.aub-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent);
}
.st-downloaded .aub-icon { color: var(--success); }
.st-error .aub-icon { color: var(--error); }

.aub-body {
  flex: 1;
  min-width: 0;
}
.aub-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.aub-title {
  font-weight: 500;
  white-space: nowrap;
}
.aub-detail {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-error .aub-detail { color: var(--error); }

.aub-track {
  margin-top: 6px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent-subtle);
  overflow: hidden;
}
.aub-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width var(--duration-normal) var(--ease-out);
}

.aub-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.aub-btn {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 3px 10px;
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast);
}
.aub-btn-primary {
  background: var(--accent);
  color: var(--text-inverse);
}
.aub-btn-primary:hover { background: var(--accent-hover); }
.aub-btn-ghost {
  background: transparent;
  border-color: var(--border-color);
  color: var(--text-secondary);
}
.aub-btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
