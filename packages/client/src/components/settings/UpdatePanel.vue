<template>
  <div class="update-panel">
    <div class="update-head">
      <div class="update-title">
        SUPERCRZY <span class="bot-badge">BOT</span>
      </div>

      <!--
        版本口径（2026-10-12 统一）：
        「应用版本」来自主进程 app.getVersion()（打包读 Info.plist / dev 读 desktop/package.json），
        是**唯一**能代表「你手上这个 App 是第几版」的数字；
        「引擎版本」是代码仓库版本（根/client/server 的 package.json），与 App 发布节奏无关。
        两者都不是对方的别名，所以分标签并排，不做合并。
      -->
      <div class="update-meta">
        <span v-if="isDesktop" class="update-meta-item">
          <span class="update-meta-label">{{ $t('nav.appVersionLabel') }}</span>
          <span class="update-meta-value">{{ appVersionLabel }}</span>
        </span>
        <span class="update-meta-item">
          <span class="update-meta-label">{{ $t('nav.engineVersionLabel') }}</span>
          <span class="update-meta-value">v{{ ENGINE_VERSION }}</span>
        </span>
        <span v-if="showSource && gitHead" class="update-meta-item">
          <span class="update-meta-label">{{ $t('nav.sourceLabel') }}</span>
          <span class="update-meta-value">{{ gitHead }}</span>
        </span>
      </div>

      <div v-if="statusPill" class="update-status-row">
        <span class="update-status" :class="statusPill.tone">
          <SvgIcon v-if="statusPill.tone === 'latest'" name="check" :size="12" />
          {{ statusPill.text }}
        </span>
      </div>
    </div>

    <div class="update-actions">
      <!--
        App 二进制更新的就地动作（2026-10-12 补）：
        此前卡片只说「发现新版本」却不给任何更新入口，用户必须去点顶部横幅；
        横幅一旦被「稍后」关掉就彻底没入口了。这里复用同一个 update 桥，不产生第二套逻辑。
      -->
      <n-button
        v-if="appAction"
        size="small"
        type="primary"
        :loading="appAction.busy"
        :disabled="appAction.busy"
        @click="runAppAction"
      >{{ appAction.label }}</n-button>
      <!-- 源码仓库更新：仅开发者形态可用，降为次要动作，不与 App 更新抢主按钮 -->
      <n-button
        v-if="canUpdateSource"
        size="small"
        :disabled="updating"
        @click="runUpdate"
      >{{ $t('nav.updateSource') }}</n-button>
      <n-button v-if="updating" size="small" loading disabled>{{ $t('nav.updating') }}</n-button>
      <!--
        手动检查更新（2026-10-16 新增）：
        此前只有"启动后 6 秒自动检查一次"，且有一次性闸门 —— 启动时网络不好就整个生命周期不再检查，
        用户毫无补救手段。这里给一个显式入口，且**失败会提示**（自动检查失败是静默的）。
      -->
      <n-button
        size="small"
        quaternary
        :loading="checking"
        :disabled="checking"
        @click="checkAppUpdate"
      >{{ checking ? $t('nav.checkingUpdate') : $t('nav.checkUpdate') }}</n-button>
      <n-button size="small" quaternary @click="showChangelog = true">{{ $t('nav.changelog') }}</n-button>
    </div>

    <div v-if="checkError" class="update-log">
      <div class="update-log-line err">{{ checkError }}</div>
    </div>

    <div v-if="updateLog.length" class="update-log">
      <div v-for="(line, i) in updateLog" :key="i" class="update-log-line" :class="{ err: line.ok === false }">
        {{ line.message }}
      </div>
    </div>

    <!-- 更新日志弹窗：引擎版本变更（历史见 CHANGELOG.md） -->
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ENGINE_VERSION, CHANGELOG } from '@/data/changelog'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const { locale, t } = useI18n({ useScope: 'global' })
const isZh = computed(() => locale.value.startsWith('zh'))

const CHANGELOG_SEEN_KEY = 'supercrzy:changelog_seen'
const showChangelog = ref(false)
const updating = ref(false)
/** 手动检查更新进行中（与"下载/安装"的 updating 分开：检查很快，不该显示"正在更新"） */
const checking = ref(false)
/** 手动检查失败提示；下次成功检查时清掉 */
const checkError = ref('')
const updateLog = ref<Array<{ message: string; ok: boolean | null }>>([])

// ---- 桌面桥（纯 Web 形态没有）----
type AppUpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'
interface AppUpdateState {
  status: AppUpdateStatus
  version?: string
  percent?: number
  message?: string
}
interface DesktopBridge {
  app?: { getInfo: () => Promise<{ version: string; packaged: boolean }> }
  update?: {
    getState: () => Promise<AppUpdateState>
    onState: (cb: (s: AppUpdateState) => void) => () => void
    /** 手动检查更新（2026-10-16）：用户主动 ⇒ 失败会返回 ok:false 且主进程推 error 状态 */
    check: () => Promise<{ ok: boolean; message?: string }>
    /** 触发下载（electron-updater）；进度由主进程经 onState 推回，不在此等待完成 */
    download: () => Promise<unknown>
    /** 退出并安装（quitAndInstall）；失败信息由主进程推 error 状态带回 */
    install: () => Promise<{ ok: boolean; message?: string }>
    /** 用户关闭更新提示（主进程把 status 归回 idle，横幅/胶囊一并消失） */
    dismiss: () => Promise<unknown>
  }
}
const desktop = (window as { supercrzyDesktop?: DesktopBridge }).supercrzyDesktop
const isDesktop = !!desktop?.update

const appVersion = ref('')
/** 打包形态 = 无源码仓库（.app 内没有 .git）：源码相关语境整体不适用 */
const packaged = ref(true)
const appUpdate = ref<AppUpdateState>({ status: 'idle' })
let offUpdate: (() => void) | null = null

/** 源码（git）语境：Web 形态始终适用；桌面形态仅未打包时适用 */
const showSource = computed(() => (isDesktop ? !packaged.value : true))

const gitHead = ref('')
const sourceStatus = ref<'idle' | 'checking' | 'available' | 'latest'>('idle')

const currentEntry = computed(() => CHANGELOG.find((e) => e.version === ENGINE_VERSION) || CHANGELOG[0])

const appVersionLabel = computed(() => (appVersion.value ? `v${appVersion.value}` : '—'))

/**
 * 状态胶囊：**只反映一个更新口径**，不再让两个体系并排给结论。
 * - 桌面形态 → App 二进制更新（electron-updater，与「应用版本」同体系）
 * - Web 形态  → 源码仓库更新（没有 App 二进制，这是唯一有意义的对象）
 */
const statusPill = computed<{ tone: string; text: string } | null>(() => {
  if (isDesktop) {
    const s = appUpdate.value
    switch (s.status) {
      case 'checking':
        return { tone: 'checking', text: t('nav.checkingUpdate') }
      case 'latest':
        return { tone: 'latest', text: t('nav.latestVersion') }
      case 'available':
        return { tone: 'available', text: `${t('nav.updateAvailable')}${s.version ? ' v' + s.version : ''}` }
      case 'downloading':
        return { tone: 'available', text: `${t('nav.downloadingShort')} ${Math.round(s.percent || 0)}%` }
      case 'downloaded':
        // 色板语义：绿=无需动作（已是最新），琥珀=有待处理的更新（下载中/待安装）
        return { tone: 'available', text: t('nav.updateReady') }
      case 'error':
        return { tone: 'error', text: t('nav.updateFailedShort') }
      default:
        // idle = 尚未检查 / 用户关掉了提示 → 不给结论，避免误导
        return null
    }
  }
  if (sourceStatus.value === 'checking') return { tone: 'checking', text: t('nav.checkingUpdate') }
  if (sourceStatus.value === 'available') return { tone: 'available', text: t('nav.sourceUpdateAvailable') }
  if (sourceStatus.value === 'latest') return { tone: 'latest', text: t('nav.latestVersion') }
  return null
})

const canUpdateSource = computed(() => showSource.value && sourceStatus.value === 'available' && !updating.value)

/**
 * App 二进制更新的就地动作按钮。
 * 与顶部横幅共用同一个 `update` 桥（主进程把同一份 lastUpdateState 推给两边），
 * 所以这里**不需要也不允许**另起一套下载/安装逻辑。
 */
const appAction = computed<{ kind: 'download' | 'install'; label: string; busy: boolean } | null>(() => {
  if (!isDesktop) return null
  const s = appUpdate.value
  switch (s.status) {
    case 'available':
      return { kind: 'download', label: t('appUpdate.updateNow'), busy: false }
    case 'downloading':
      return { kind: 'download', label: `${t('appUpdate.downloading')} ${Math.round(s.percent || 0)}%`, busy: true }
    case 'downloaded':
      return { kind: 'install', label: t('appUpdate.restartInstall'), busy: false }
    case 'error':
      // 安装失败（典型：dev 形态无签名）后允许重试下载；主进程会把新状态推回来
      return { kind: 'download', label: t('nav.retry'), busy: false }
    default:
      // idle（还没查 / 用户关掉了提示）与 latest（已是最新）都不给动作
      return null
  }
})

async function runAppAction() {
  const a = appAction.value
  const b = desktop?.update
  if (!a || a.busy || !b) return
  try {
    if (a.kind === 'install') await b.install()
    else await b.download()
  } catch { /* 失败由主进程推 error 状态带回界面 */ }
}

/**
 * 手动检查更新（2026-10-16 新增）。
 *
 * 与启动时自动检查的差别：**失败要明确告知**（自动检查失败是静默的）。
 * 更新源在海外，本机需要代理才连得上 —— 失败提示里直接点出这一点，省掉一轮排查。
 */
async function checkAppUpdate() {
  const b = desktop?.update
  if (checking.value || !b?.check) return
  checking.value = true
  checkError.value = ''
  updateLog.value = []
  try {
    const r = await b.check()
    if (r && r.ok === false) {
      checkError.value = t('nav.checkFailed')
      updateLog.value.push({ message: r.message || String(r), ok: false })
    }
  } catch (e) {
    checkError.value = t('nav.checkFailed')
    updateLog.value.push({ message: String(e), ok: false })
  } finally {
    checking.value = false
  }
}

/** 弹窗打开时检查源码更新；关闭时记录已读 */
function onChangelogShow(v: boolean) {
  if (v) {
    checkSourceUpdate()
  } else {
    dismissChangelog()
  }
}

/** 源码仓库更新检查（仅在有 .git 的形态下调用）；8s 超时兜底视为最新（不误导） */
async function checkSourceUpdate() {
  if (!showSource.value) {
    sourceStatus.value = 'idle'
    return
  }
  sourceStatus.value = 'checking'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const check = await (await fetch('/api/system/check-update', { signal: ctrl.signal })).json()
    clearTimeout(timer)
    sourceStatus.value = check.hasUpdate === true ? 'available' : 'latest'
  } catch {
    sourceStatus.value = 'latest'
  }
}

/** 一键更新源码：仅在有更新时调用，SSE 流式接收进度 */
async function runUpdate() {
  if (updating.value || !canUpdateSource.value) return
  updating.value = true
  updateLog.value = []
  sourceStatus.value = 'checking'
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
    checkSourceUpdate()
  }
}

/** 拉取源码版本信息（git head）—— 仅源码语境下调用 */
async function loadVersion() {
  if (!showSource.value) {
    gitHead.value = ''
    return
  }
  try {
    const r = await fetch('/api/system/version')
    const d = await r.json()
    gitHead.value = d.gitHead || ''
  } catch {}
}

function dismissChangelog(remember = true) {
  showChangelog.value = false
  if (remember) {
    try { localStorage.setItem(CHANGELOG_SEEN_KEY, ENGINE_VERSION) } catch {}
  }
}

onMounted(async () => {
  // 1) 应用版本 + App 更新状态（桌面形态）
  if (desktop?.app) {
    try {
      const info = await desktop.app.getInfo()
      appVersion.value = info?.version || ''
      packaged.value = info?.packaged !== false
    } catch { /* 桥不可用 → 保持「打包形态」保守默认，不显示源码语境 */ }
  }
  if (desktop?.update) {
    // 事件可能早于订阅（主进程启动 6s 后即检查），先补拉一次当前状态
    try {
      const s = await desktop.update.getState()
      if (s) appUpdate.value = s
    } catch { /* 桥不可用 */ }
    try {
      offUpdate = desktop.update.onState((s) => {
        if (s) appUpdate.value = s
      })
    } catch { /* 订阅失败 */ }
  }

  // 2) 源码语境（Web 形态，或桌面未打包形态）
  if (showSource.value) {
    loadVersion()
    checkSourceUpdate()
  }

  // 3) 引擎版本更新提示：已读版本 ≠ 当前引擎版本 → 自动弹出更新日志
  try {
    const seen = localStorage.getItem(CHANGELOG_SEEN_KEY)
    if (seen !== ENGINE_VERSION) {
      setTimeout(() => { showChangelog.value = true }, 600)
    }
  } catch { /* localStorage 不可用时静默 */ }
})

onBeforeUnmount(() => {
  try {
    offUpdate && offUpdate()
  } catch { /* 忽略 */ }
})
</script>

<style scoped>
.update-panel { width: 100%; }
/* 关于卡片（右侧栏窄容器）：版本分层 → 状态 → 按钮 */
.update-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.update-title {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.update-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11px;
  line-height: 1.5;
}
.update-meta-item { display: inline-flex; align-items: baseline; gap: 5px; }
.update-meta-label { color: var(--text-muted); }
.update-meta-value { color: var(--text-secondary); font-weight: 600; font-variant-numeric: tabular-nums; }
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
.update-status.error { color: var(--error); background: rgba(226, 75, 74, 0.12); }
.update-actions { display: flex; gap: 8px; width: 100%; flex-wrap: wrap; margin-top: 10px; }
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
