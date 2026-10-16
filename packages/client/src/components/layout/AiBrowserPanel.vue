<!--
  AI 浏览器面板（2026-09-24 从 DetailPanel.vue 抽离成独立组件）。

  抽离前后宿主不变 —— 它仍是 DetailPanel 右栏的一个 tab，只是**不再和文件树/产物/diff 挤在
  同一个 setup 作用域里**。契约只有三个入参（见下），ChatView 那侧一个字都不用改：它唯一与
  浏览器相关的代码是 AUTO_REVEAL_MAP 里 `browser: 'browser'` 这一个 tab key。

  为什么根节点用 v-show 而不是 v-if：状态（截图、日志、地址）住在本组件里，
  v-if 会让"切到产物再切回来"清空这些。v-show 保持与原实现一致 —— 切 tab 时 DOM 留着、
  只把长轮询与原生视图同步停掉（靠 `active` 入参的 watcher，逻辑在 useAiBrowser 里）。
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAiBrowser } from '@/composables/useAiBrowser'

// Internal status values stay as-is (the dot logic compares them); only display is translated.
const { t } = useI18n({ useScope: 'global' })
const STATUS_KEY: Record<string, string> = {
  '待机': 'aiBrowser.idle',
  '原生视图 · 人机共用': 'aiBrowser.nativeShared',
  '导航中': 'aiBrowser.navigating',
  '失败': 'aiBrowser.failed',
  '实时': 'aiBrowser.live',
  '断开': 'aiBrowser.disconnected',
  '刷新中': 'aiBrowser.refreshing',
  '动作失败': 'aiBrowser.actionFailed',
  '已释放': 'aiBrowser.released',
}
const statusText = (s: string) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : s)

const props = defineProps<{
  /** 当前会话 id：切会话要释放上一个会话的浏览器实例。store 里可能是 null（无会话）。 */
  sessionId?: string | null
  /** 面板可见 **且** 当前停在浏览器 tab */
  active: boolean
  /** 与 DetailPanel 共用的放大态（右栏加宽），由父组件持有 */
  maximized: boolean
}>()

const emit = defineEmits<{
  (e: 'update:maximized', v: boolean): void
}>()

const {
  browserStatus, browserFailHint, browserUrl, browserUrlInput,
  browserScreenshotBase64, browserLoading, browserLog,
  browserTypeText, browserClickText, browserNative, browserNativeReady,
  browserCanvasEl,
  goToUrl, refreshPage, browserGoBack, clickPage, onCanvasWheel,
  doType, doKey, doClickText, keyButtons,
} = useAiBrowser({
  sessionId: () => props.sessionId,
  active: () => props.active,
})
</script>

<template>
  <div v-show="active" class="tab-content browser-tab">
    <div class="browser-live">
      <span class="browser-live-dot" :class="{ active: browserStatus === '导航中' }" />
      <span class="browser-live-text">{{ statusText(browserStatus) }}</span>
    </div>
    <div class="browser-url-row">
      <input
        v-model="browserUrlInput"
        class="browser-url-input"
        :placeholder="t('aiBrowser.phUrl')"
        @keyup.enter="goToUrl"
      />
      <button class="browser-ico" @click="goToUrl" :title="t('aiBrowser.open')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
      <button class="browser-ico" @click="refreshPage" :title="t('aiBrowser.refresh')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <button class="browser-ico" @click="browserGoBack" :title="t('aiBrowser.back')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      </button>
      <button class="browser-maxbtn" @click="emit('update:maximized', !maximized)" :title="maximized ? t('aiBrowser.restorePanel') : t('aiBrowser.maximize')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
    </div>
    <div class="browser-view">
      <div class="browser-chrome-bar">
        <span class="bc-dot" style="background:#ef4444" /><span class="bc-dot" style="background:#f59e0b" /><span class="bc-dot" style="background:#22c55e" />
        <span class="bc-url">{{ browserUrl || 'about:blank' }}</span>
      </div>
      <div class="browser-canvas" :class="{ native: browserNative }" ref="browserCanvasEl">
        <!-- 原生视图模式（桌面形态 + 后端 attach）：真正的网页是主进程的一层原生视图
             （WebContentsView），盖在这个 div 的位置上。所以这里**不放 img、不接点击** ——
             人直接在真网页里打字点击，AI 那边天生看得到（同一份 DOM）。
             这个 div 的唯一职责是"把矩形量出来"。 -->
        <div v-if="browserNative" class="browser-native-slot">
          <span class="browser-placeholder" :class="{ loading: !browserNativeReady }">
            {{ browserNativeReady ? '' : t('aiBrowser.mounting') }}
          </span>
        </div>
        <template v-else>
          <div v-if="browserScreenshotBase64" class="browser-shot-wrap">
            <img
              :src="'data:image/jpeg;base64,' + browserScreenshotBase64"
              class="browser-shot clickable"
              @click="clickPage"
              @wheel.prevent="onCanvasWheel"
              :alt="t('aiBrowser.altView')"
            />
            <div class="browser-hit-hint" v-if="browserScreenshotBase64">{{ t('aiBrowser.hitHint') }}</div>
          </div>
          <span v-else class="browser-placeholder" :class="{ loading: browserLoading }">
            {{ browserLoading ? t('aiBrowser.navigatingHint') : t('aiBrowser.ready') }}
          </span>
        </template>
        <p class="browser-fail" v-if="browserFailHint">{{ browserFailHint }}</p>
      </div>
      <!-- 人工操作台（2026-09-23）：后端 6 个动作本就齐备，之前前端只接了 2 个 →
           人在右栏能点、不能打字/滚动/回车，「自己接管一下」根本做不到。
           原生视图模式下这一整块**不需要**：那是真网页，人用真键盘鼠标即可。 -->
      <div class="browser-native-note" v-if="browserNative">
        {{ t('aiBrowser.liveHint') }}
      </div>
      <div class="browser-cmd" v-else>
        <div class="bc-row">
          <input
            v-model="browserTypeText"
            class="bc-input"
            :placeholder="t('aiBrowser.phType')"
            @keyup.enter="doType(true)"
          />
          <button class="bc-btn primary" @click="doType(true)" :title="t('aiBrowser.typeEnterTitle')">{{ t('aiBrowser.typeEnter') }}</button>
          <button class="bc-btn" @click="doType(false)" :title="t('aiBrowser.typeOnlyTitle')">{{ t('aiBrowser.typeOnly') }}</button>
        </div>
        <div class="bc-row">
          <button
            v-for="k in keyButtons"
            :key="k.key"
            class="bc-btn key"
            :title="t(k.titleKey)"
            @click="doKey(k.key)"
          >{{ k.key === 'Enter' ? t('aiBrowser.keyEnter') : k.label }}</button>
        </div>
        <div class="bc-row">
          <input
            v-model="browserClickText"
            class="bc-input"
            :placeholder="t('aiBrowser.phClick')"
            @keyup.enter="doClickText"
          />
          <button class="bc-btn" @click="doClickText" :title="t('aiBrowser.clickTextTitle')">{{ t('aiBrowser.clickText') }}</button>
        </div>
      </div>
    </div>
    <div class="browser-console">
      <div v-for="(l, i) in browserLog" :key="i" class="browser-log-line">&gt; {{ l }}</div>
      <div v-if="browserLog.length === 0" class="browser-log-line muted">{{ t('aiBrowser.noLog') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* ---- AI 浏览器 Tab（Playwright 实接）---- */
.browser-live { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
.browser-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; }
.browser-live-dot.active { background: #22c55e; animation: bdot 1s infinite; }
@keyframes bdot { 0%,100%{opacity:1} 50%{opacity:.35} }
.browser-url-row { display: flex; gap: 4px; align-items: center; }
.browser-url-input { flex: 0 0 65%; width: 65%; max-width: 65%; min-width: 0; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 6px 9px; font-size: 12.5px; background: var(--bg-tertiary); color: var(--text-primary); caret-color: var(--text-primary); }
.browser-url-input::placeholder { color: var(--text-tertiary); }
.browser-go, .browser-refresh { border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); font-size: 11px; padding: 3px 8px; cursor: pointer; color: var(--text-secondary); }
.browser-ico { border: none; background: transparent; cursor: pointer; color: var(--text-secondary); width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); flex-shrink: 0; }
.browser-ico:hover { color: var(--text-primary); background: var(--bg-hover); }
.browser-maxbtn { border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); cursor: pointer; color: var(--text-secondary); display: inline-flex; align-items: center; justify-content: center; height: 20px; margin-left: 2px; padding: 0 5px; }
.browser-maxbtn:hover { border-color: var(--border-strong); color: var(--text-primary); }
.browser-view { border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.browser-chrome-bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: #0f172a; }
.bc-dot { width: 7px; height: 7px; border-radius: 50%; }
.bc-url { margin-left: auto; font-size: 10px; color: #64748b; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-canvas { min-height: 140px; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); }
/* 原生视图模式：没有 <img> 撑着，得给个高度来源，否则视图只有 min-height 一条缝。
   aspect-ratio 让它随面板宽度自己长高（只影响观感；对不对齐由量出来的矩形决定，见 syncNativeBounds）。 */
.browser-canvas.native { width: 100%; aspect-ratio: 16 / 10; min-height: 240px; }
.browser-native-slot { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.browser-native-note {
  font-size: 11px; line-height: 1.6; color: var(--text-tertiary);
  padding: 6px 8px; border-left: 2px solid var(--border-color);
}
.browser-shot-wrap { width: 100%; overflow-x: auto; }
.browser-shot { display: block; width: 100%; height: auto; }
.browser-shot.clickable { cursor: crosshair; }
.browser-hit-hint { font-size: 10px; color: var(--text-tertiary); text-align: center; padding: 2px 0; }
.browser-fail { font-size: 12px; color: var(--danger, #e24b4a); text-align: center; padding: 6px 10px; line-height: 1.5; }
.browser-placeholder { font-size: 11px; color: var(--text-muted); padding: 10px; text-align: center; line-height: 1.5; }
.browser-placeholder.loading { color: var(--text-secondary); }
.browser-console { background: #0f172a; border-radius: var(--radius-sm); padding: 6px 8px; font-family: var(--font-mono, monospace); font-size: 10px; color: #6ee7a0; max-height: 90px; overflow-y: auto; }
.browser-log-line { margin: 2px 0; }
.browser-log-line.muted { color: #64748b; }

/* AI 浏览器人工操作台（2026-09-23）：打字 / 按键 / 按文字点击。
   滚动不在这里 —— 滚轮直接作用在画面上（@wheel），少一层认知负担。 */
.browser-cmd { display: flex; flex-direction: column; gap: 4px; padding: 6px 0 2px; }
.bc-row { display: flex; gap: 4px; align-items: center; }
.bc-input { flex: 1 1 auto; min-width: 0; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 5px 8px; font-size: 12px; background: var(--bg-tertiary); color: var(--text-primary); caret-color: var(--text-primary); }
.bc-input::placeholder { color: var(--text-tertiary); }
.bc-btn { flex-shrink: 0; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-secondary); font-size: 11px; padding: 4px 8px; cursor: pointer; white-space: nowrap; }
.bc-btn:hover { border-color: var(--border-strong); color: var(--text-primary); background: var(--bg-hover); }
.bc-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.bc-btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
.bc-btn.key { min-width: 34px; text-align: center; font-family: var(--font-mono, monospace); }
</style>
