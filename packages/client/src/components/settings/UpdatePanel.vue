<template>
  <div class="update-panel">
    <div class="update-head">
      <div class="update-info">
        <div class="update-version">
          SUPERCRZY <span class="bot-badge">BOT</span> <span class="update-ver">v{{ APP_VERSION }}</span>
        </div>
        <div v-if="gitHead" class="update-git">· {{ gitHead }}</div>
        <div class="update-status-row">
          <span v-if="updateStatus === 'checking'" class="update-status checking">{{ $t('nav.checkingUpdate') }}</span>
          <span v-else-if="updateStatus === 'latest'" class="update-status latest">
            <SvgIcon name="check" :size="12" /> {{ $t('nav.latestVersion') }}
          </span>
          <span v-else-if="updateStatus === 'available'" class="update-status available">{{ $t('nav.updateAvailable') }}</span>
        </div>
      </div>
      <div class="update-actions">
        <n-button v-if="updateStatus === 'available' && !updating" size="small" type="primary" @click="runUpdate">{{ $t('nav.updateNow') }}</n-button>
        <n-button v-if="updating" size="small" type="primary" loading disabled>{{ $t('nav.updating') }}</n-button>
        <n-button size="small" quaternary @click="showChangelog = true">{{ $t('nav.changelog') }}</n-button>
      </div>
    </div>

    <div v-if="updateLog.length" class="update-log">
      <div v-for="(line, i) in updateLog" :key="i" class="update-log-line" :class="{ err: line.ok === false }">
        {{ line.message }}
      </div>
    </div>

    <!-- 更新日志弹窗：仅当前版本（历史见 CHANGELOG.md） -->
    <n-modal v-model:show="showChangelog" preset="card" :title="$t('nav.changelogTitle')" style="max-width:560px" @update:show="onChangelogShow">
      <div class="changelog-list">
        <div class="changelog-entry">
          <div class="changelog-header">
            <span class="changelog-version">v{{ currentEntry.version }}</span>
            <span class="changelog-date">{{ currentEntry.date }}</span>
            <span class="changelog-title">{{ isZh ? currentEntry.title : currentEntry.titleEn }}</span>
          </div>
          <ul v-if="(isZh ? currentEntry.features : currentEntry.featuresEn).length" class="changelog-items">
            <li v-for="(f, i) in (isZh ? currentEntry.features : currentEntry.featuresEn)" :key="'f' + i" class="changelog-feature">{{ f }}</li>
          </ul>
          <ul v-if="(isZh ? currentEntry.fixes : currentEntry.fixesEn).length" class="changelog-items">
            <li v-for="(f, i) in (isZh ? currentEntry.fixes : currentEntry.fixesEn)" :key="'x' + i" class="changelog-fix">{{ f }}</li>
          </ul>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { APP_VERSION, CHANGELOG } from '@/data/changelog'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const { locale, t } = useI18n({ useScope: 'global' })
const isZh = computed(() => locale.value.startsWith('zh'))

const CHANGELOG_SEEN_KEY = 'supercrzy:changelog_seen'
const showChangelog = ref(false)
const updating = ref(false)
const updateLog = ref<Array<{ message: string; ok: boolean | null }>>([])
const gitHead = ref('')
const updateStatus = ref<'checking' | 'latest' | 'available' | 'error'>('checking')

const currentEntry = computed(() => CHANGELOG.find((e) => e.version === APP_VERSION) || CHANGELOG[0])

// 弹窗打开时检查更新；关闭时记录已读
function onChangelogShow(v: boolean) {
  if (v) {
    checkForUpdate()
  } else {
    dismissChangelog()
  }
}

/** 检查是否有新版本；8s 超时兜底视为最新（不误导） */
async function checkForUpdate() {
  updateStatus.value = 'checking'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const check = await (await fetch('/api/system/check-update', { signal: ctrl.signal })).json()
    clearTimeout(timer)
    updateStatus.value = check.hasUpdate === true ? 'available' : 'latest'
  } catch {
    updateStatus.value = 'latest'
  }
}

/** 一键更新：仅在有更新时调用，SSE 流式接收进度 */
async function runUpdate() {
  if (updating.value || updateStatus.value !== 'available') return
  updating.value = true
  updateLog.value = []
  updateStatus.value = 'checking'
  try {
    const res = await fetch('/api/system/update', { method: 'POST' })
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6))
            if (d.step && d.message) {
              updateLog.value.push({ message: `${d.step}${d.ok === false ? ' ✗' : d.ok === true ? ' ✓' : '...'}: ${d.message}`, ok: d.ok })
            }
          } catch {}
        }
      }
    }
  } catch (err: any) {
    updateLog.value.push({ message: `${t('settings.updateFailed')}: ${err.message}`, ok: false })
  } finally {
    updating.value = false
    loadVersion()
    checkForUpdate()
  }
}

/** 拉取后端版本信息（git head） */
async function loadVersion() {
  try {
    const r = await fetch('/api/system/version')
    const d = await r.json()
    gitHead.value = d.gitHead || ''
  } catch {}
}

function dismissChangelog(remember = true) {
  showChangelog.value = false
  if (remember) {
    try { localStorage.setItem(CHANGELOG_SEEN_KEY, APP_VERSION) } catch {}
  }
}

onMounted(() => {
  loadVersion()
  checkForUpdate()
  // 自动版本提示：已读版本 ≠ 当前版本 → 自动弹出更新日志
  try {
    const seen = localStorage.getItem(CHANGELOG_SEEN_KEY)
    if (seen !== APP_VERSION) {
      setTimeout(() => { showChangelog.value = true }, 600)
    }
  } catch { /* localStorage 不可用时静默 */ }
})
</script>

<style scoped>
.update-panel { width: 100%; }
/* 关于卡片（右侧栏窄容器）：纵向分层 版本 → git → 状态 → 按钮 */
.update-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.update-version {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.update-ver { color: var(--text-secondary); font-weight: 600; }
.update-git { font-size: 11px; color: var(--text-muted); font-weight: 400; margin-top: -4px; }
.update-status-row { margin-top: 2px; }
.update-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 999px;
}
.update-status.checking { color: var(--text-muted); background: var(--bg-hover); }
.update-status.latest { color: var(--success, #10B981); background: rgba(16, 185, 129, 0.12); }
.update-status.available { color: var(--warning, #F59E0B); background: rgba(245, 158, 11, 0.12); }
.update-actions { display: flex; gap: 8px; width: 100%; flex-wrap: wrap; }
.update-actions .n-button { flex: 1; }

.update-log { margin-top: 10px; max-height: 140px; overflow-y: auto; }
.update-log-line { font-size: 12px; padding: 3px 0; color: var(--text-secondary); }
.update-log-line.err { color: var(--error); }

.changelog-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}
.changelog-entry {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  border-left: 3px solid var(--accent);
}
.changelog-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.changelog-version { font-weight: 700; font-size: 14px; color: var(--accent); }
.changelog-date { font-size: 11px; color: var(--text-muted); }
.changelog-title { font-size: 13px; color: var(--text-secondary); }
.changelog-items { list-style: none; margin: 4px 0 0; padding: 0; }
.changelog-feature, .changelog-fix {
  position: relative;
  padding-left: 16px;
  margin: 6px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.changelog-feature::before {
  content: '';
  position: absolute;
  left: 0; top: 8px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.changelog-fix::before {
  content: '';
  position: absolute;
  left: 0; top: 8px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--warning);
}
</style>
