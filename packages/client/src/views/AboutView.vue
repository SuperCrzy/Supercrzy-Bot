<!--
  About SUPERCRZY — a native second-level page modelled on the WorkBuddy reference:
  grouped legal/utility rows, then a version row with the release-channel check, and a
  copyright footer. Version rows here must never call the /check-update git diff — that
  answers "is this checkout behind", not "is my installed app stale".
-->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { APP_VERSION } from '@/data/changelog'

const { t } = useI18n({ useScope: 'global' })

const latest = ref<string | null>(null)
const hasUpdate = ref(false)
const checked = ref(false)
const downloadUrl = 'https://supercrzy.com/bot'

function open(url: string) {
  window.open(url, '_blank', 'noopener')
}

onMounted(async () => {
  try {
    const res = await fetch(`/api/system/app-update?version=${encodeURIComponent(APP_VERSION)}`)
    const d = await res.json()
    latest.value = d?.latest || null
    hasUpdate.value = !!d?.hasUpdate
  } catch { /* offline → no badge, no noise */ } finally {
    checked.value = true
  }
})
</script>

<template>
  <div class="about-page">
    <header class="about-head">
      <h2>{{ t('about.title') }}</h2>
    </header>

    <div class="about-body">
      <div class="settings-group">
        <button class="settings-row" @click="open('https://supercrzy.com')">
          <span class="settings-row-icon"><SvgIcon name="globe" :size="16" /></span>
          <span class="settings-row-text">{{ t('about.website') }}</span>
          <SvgIcon name="chevron-right" :size="16" />
        </button>
        <button class="settings-row" @click="open('https://supercrzy.com/about')">
          <span class="settings-row-icon"><SvgIcon name="mail" :size="16" /></span>
          <span class="settings-row-text">{{ t('about.feedback') }}</span>
          <SvgIcon name="chevron-right" :size="16" />
        </button>
      </div>

      <div class="settings-group">
        <button class="settings-row" @click="open('https://supercrzy.com/terms')">
          <span class="settings-row-icon"><SvgIcon name="file-text" :size="16" /></span>
          <span class="settings-row-text">{{ t('about.terms') }}</span>
          <SvgIcon name="chevron-right" :size="16" />
        </button>
        <button class="settings-row" @click="open('https://supercrzy.com/privacy')">
          <span class="settings-row-icon"><SvgIcon name="lock" :size="16" /></span>
          <span class="settings-row-text">{{ t('about.privacy') }}</span>
          <SvgIcon name="chevron-right" :size="16" />
        </button>
      </div>

      <div class="settings-group">
        <button class="settings-row" @click="open(downloadUrl)">
          <span class="settings-row-icon"><SvgIcon name="download" :size="16" /></span>
          <span class="settings-row-text">
            <strong>{{ t('about.version') }} {{ APP_VERSION }}</strong>
            <em v-if="hasUpdate">{{ t('about.newVersion', { v: latest }) }}</em>
            <em v-else-if="checked">{{ t('about.upToDate') }}</em>
          </span>
          <SvgIcon name="chevron-right" :size="16" />
        </button>
      </div>

      <p class="about-copyright">© 2026 SUPERCRZY. All Rights Reserved.</p>
    </div>
  </div>
</template>

<style scoped>
.about-page { height: 100%; display: flex; flex-direction: column; background: var(--bg-secondary); }
.about-head {
  position: relative;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
  text-align: center;
}
.about-head h2 { font-size: 16px; font-weight: 600; margin: 0; }
.about-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.settings-group {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
}
.settings-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary);
}
.settings-group .settings-row + .settings-row { border-top: 1px solid var(--border-color); }
.settings-row:active { background: var(--bg-hover, rgba(127,127,127,.08)); }
.settings-row-icon {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
.settings-row-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.settings-row-text strong { font-size: 14px; font-weight: 600; }
.settings-row-text em { font-size: 11.5px; font-style: normal; color: var(--text-tertiary); }
.about-copyright { margin: 6px 0 12px; text-align: center; font-size: 11px; color: var(--text-tertiary); }
</style>
