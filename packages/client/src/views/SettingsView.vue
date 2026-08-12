<template>
  <div class="settings-page">
    <header class="settings-header">
      <h2>{{ $t('settings.title') }}</h2>
    </header>

    <div class="settings-body">
      <!-- ======== 设置标签页 ======== -->
      <n-card size="small" class="tabs-card" content-style="padding:0">
        <n-tabs v-model:value="activeTab" type="line" animated>
          <!-- Tab 1: 账户 -->
          <n-tab-pane name="account" :tab="$t('settings.tabAccount')">
            <div class="tab-content">
              <p class="tab-desc">{{ $t('settings.accountDesc') }}</p>
              <div class="form-group">
                <label>{{ $t('settings.passwordLoginStatus') }}</label>
                <div class="status-row">
                  <n-tag type="warning" size="small">{{ $t('settings.passwordNotConfigured') }}</n-tag>
                  <n-button size="small" type="primary" ghost>{{ $t('settings.setupPassword') }}</n-button>
                </div>
              </div>
              <div class="form-group">
                <label>{{ $t('settings.accessToken') }}</label>
                <div class="token-row">
                  <n-input :value="tokenDisplay" readonly size="large" style="flex:1" />
                  <n-button size="large" @click="showToken = !showToken">
                    {{ showToken ? $t('settings.hideToken') : $t('settings.showToken') }}
                  </n-button>
                </div>
                <p class="form-hint">{{ $t('settings.tokenHint') }}</p>
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 2: 显示 -->
          <n-tab-pane name="display" :tab="$t('settings.tabDisplay')">
            <div class="tab-content">
              <div class="setting-row">
                <div class="setting-info">
                  <span class="setting-label">{{ $t('settings.theme') }}</span>
                </div>
                <n-select v-model:value="form.theme" :options="themeOptions" size="small" style="width:140px" />
              </div>
              <div class="setting-row">
                <div class="setting-info">
                  <span class="setting-label">{{ $t('settings.language') }}</span>
                </div>
                <n-select v-model:value="form.language" :options="langOptions" size="small" style="width:140px" @update:value="onLangChange" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.streamingEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.streamingDesc') }}</span>
                <n-switch v-model:value="form.streamingEnabled" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.compactMode') }}</span>
                <span class="setting-desc">{{ $t('settings.compactModeDesc') }}</span>
                <n-switch v-model:value="form.compactMode" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.showReasoning') }}</span>
                <span class="setting-desc">{{ $t('settings.showReasoningDesc') }}</span>
                <n-switch v-model:value="form.showReasoning" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.showCost') }}</span>
                <span class="setting-desc">{{ $t('settings.showCostDesc') }}</span>
                <n-switch v-model:value="form.showCost" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.inlineDiff') }}</span>
                <span class="setting-desc">{{ $t('settings.inlineDiffDesc') }}</span>
                <n-switch v-model:value="form.inlineDiff" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.completionSound') }}</span>
                <span class="setting-desc">{{ $t('settings.completionSoundDesc') }}</span>
                <n-switch v-model:value="form.completionSound" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.busyInputMode') }}</span>
                <span class="setting-desc">{{ $t('settings.busyInputModeDesc') }}</span>
                <n-switch v-model:value="form.busyInputMode" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 3: 代理 -->
          <n-tab-pane name="agent" :tab="$t('settings.tabAgent')">
            <div class="tab-content">
              <div class="form-group">
                <label>{{ $t('settings.maxTurns') }}</label>
                <p class="input-desc">{{ $t('settings.maxTurnsDesc') }}</p>
                <n-input-number v-model:value="form.maxTurns" :min="1" :max="200" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.gatewayTimeout') }}</label>
                <p class="input-desc">{{ $t('settings.gatewayTimeoutDesc') }}</p>
                <n-input-number v-model:value="form.gatewayTimeout" :min="30" :max="600" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.drainTimeout') }}</label>
                <p class="input-desc">{{ $t('settings.drainTimeoutDesc') }}</p>
                <n-input-number v-model:value="form.drainTimeout" :min="5" :max="300" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.toolStrategy') }}</label>
                <p class="input-desc">{{ $t('settings.toolStrategyDesc') }}</p>
                <n-select v-model:value="form.toolStrategy" :options="toolStrategyOptions" size="large" style="width:200px" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 4: 记忆 -->
          <n-tab-pane name="memory" :tab="$t('settings.tabMemory')">
            <div class="tab-content">
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.memoryEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.memoryEnabledDesc') }}</span>
                <n-switch v-model:value="form.memoryEnabled" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.userProfileEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.userProfileEnabledDesc') }}</span>
                <n-switch v-model:value="form.userProfileEnabled" size="small" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.memoryCharLimit') }}</label>
                <p class="input-desc">{{ $t('settings.memoryCharLimitDesc') }}</p>
                <n-input-number v-model:value="form.memoryCharLimit" :min="1000" :max="100000" :step="1000" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.userProfileCharLimit') }}</label>
                <p class="input-desc">{{ $t('settings.userProfileCharLimitDesc') }}</p>
                <n-input-number v-model:value="form.userProfileCharLimit" :min="500" :max="50000" :step="500" size="large" style="width:200px" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 5: 会话 -->
          <n-tab-pane name="session" :tab="$t('settings.tabSession')">
            <div class="tab-content">
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.sessionAuthEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.sessionAuthEnabledDesc') }}</span>
                <n-switch v-model:value="form.sessionAuthEnabled" size="small" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.resetMode') }}</label>
                <p class="input-desc">{{ $t('settings.resetModeDesc') }}</p>
                <n-select v-model:value="form.resetMode" :options="resetModeOptions" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.idleTimeout') }}</label>
                <p class="input-desc">{{ $t('settings.idleTimeoutDesc') }}</p>
                <n-input-number v-model:value="form.idleTimeout" :min="1" :max="1440" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.scheduledResetHour') }}</label>
                <p class="input-desc">{{ $t('settings.scheduledResetHourDesc') }}</p>
                <n-input-number v-model:value="form.scheduledResetHour" :min="0" :max="23" size="large" style="width:200px" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.liveMonitorHumanOnly') }}</span>
                <span class="setting-desc">{{ $t('settings.liveMonitorHumanOnlyDesc') }}</span>
                <n-switch v-model:value="form.liveMonitorHumanOnly" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 6: 隐私 -->
          <n-tab-pane name="privacy" :tab="$t('settings.tabPrivacy')">
            <div class="tab-content">
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.piiMaskingEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.piiMaskingEnabledDesc') }}</span>
                <n-switch v-model:value="form.piiMaskingEnabled" size="small" />
              </div>
            </div>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <!-- 保存按钮 -->
      <div class="settings-actions">
        <n-button type="primary" size="large" @click="saveSettings" :loading="saving">
          {{ $t('common.save') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, computed } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { getModelSelectOptions } from '@/data/models'

const appStore = useAppStore()
const nMessage = useMessage()
const { locale, t } = useI18n({ useScope: 'global' })

const activeTab = ref('account')
const saving = ref(false)

const showToken = ref(false)

const themeOptions = [
  { label: t('settings.themeLight'), value: 'light' },
  { label: t('settings.themeDark'), value: 'dark' },
]

const langOptions = computed(() => [
  { label: t('settings.langZh'), value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
])

const toolStrategyOptions = [
  { label: t('settings.auto'), value: 'auto' },
  { label: t('settings.manual'), value: 'manual' },
]

const resetModeOptions = [
  { label: t('settings.idleOnly'), value: 'idle' },
  { label: t('settings.scheduledOnly'), value: 'scheduled' },
  { label: t('settings.idleScheduled'), value: 'idle_scheduled' },
]

interface SettingsForm {
  apiKey: string
  apiKeyMasked: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  theme: string
  language: string
  // Display
  streamingEnabled: boolean
  compactMode: boolean
  showReasoning: boolean
  showCost: boolean
  inlineDiff: boolean
  completionSound: boolean
  busyInputMode: boolean
  // Agent
  maxTurns: number
  gatewayTimeout: number
  drainTimeout: number
  toolStrategy: string
  // Memory
  memoryEnabled: boolean
  userProfileEnabled: boolean
  memoryCharLimit: number
  userProfileCharLimit: number
  // Session
  sessionAuthEnabled: boolean
  resetMode: string
  idleTimeout: number
  scheduledResetHour: number
  liveMonitorHumanOnly: boolean
  // Privacy
  piiMaskingEnabled: boolean
}

const form = reactive<SettingsForm>({
  apiKey: '',
  apiKeyMasked: '',
  temperature: 0.7,
  maxTokens: 8192,
  systemPrompt: '',
  theme: 'light',
  language: 'zh-CN',
  streamingEnabled: true,
  compactMode: false,
  showReasoning: true,
  showCost: false,
  inlineDiff: true,
  completionSound: false,
  busyInputMode: true,
  maxTurns: 10,
  gatewayTimeout: 120,
  drainTimeout: 30,
  toolStrategy: 'auto',
  memoryEnabled: true,
  userProfileEnabled: true,
  memoryCharLimit: 50000,
  userProfileCharLimit: 10000,
  sessionAuthEnabled: false,
  resetMode: 'idle_scheduled',
  idleTimeout: 30,
  scheduledResetHour: 3,
  liveMonitorHumanOnly: true,
  piiMaskingEnabled: false,
})

const tokenDisplay = computed(() => {
  if (showToken.value && form.apiKey) return form.apiKey
  if (form.apiKeyMasked) return form.apiKeyMasked
  return '••••••••'
})


onMounted(async () => {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('Failed to fetch')
    const data = await res.json()
    Object.assign(form, data)
    if (data.language) {
      locale.value = data.language
      // 同步 localStorage，避免刷新后 i18n 初始化读到旧值
      localStorage.setItem('supercrzy-lang', data.language)
    }
    if (data.theme) {
      appStore.darkMode = data.theme === 'dark'
    }
    // 同步 completionSound 到 localStorage
    if (data.completionSound !== undefined) {
      localStorage.setItem('supercrzy:completionSound', String(data.completionSound))
    }
  } catch (err) {
    console.error('[SettingsView] Failed to load settings:', err)
  }
})

/** 语言下拉切换即时生效（无需点保存），同时写入 localStorage 保证刷新后一致 */
function onLangChange(v: string) {
  locale.value = v
  localStorage.setItem('supercrzy-lang', v)
}

async function saveSettings() {
  saving.value = true
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form }),
    })
    if (!res.ok) throw new Error('Save failed')
    // 实时切换 i18n 语言
    locale.value = form.language
    localStorage.setItem('supercrzy-lang', form.language)
    // 实时切换主题
    appStore.darkMode = form.theme === 'dark'
    // 同步 completionSound 到 localStorage
    localStorage.setItem('supercrzy:completionSound', String(form.completionSound))
    nMessage.success(t('settings.saved'))
  } catch (err: any) {
    console.error('[SettingsView] Save error:', err)
    nMessage.error(t('settings.saveFail') + ': ' + err.message)
  } finally {
    saving.value = false
  }
}

// testConnection moved to ModelsView
</script>

<style scoped>
.settings-page { height: 100vh; display: flex; flex-direction: column; background: var(--bg-secondary); }
.settings-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary); flex-shrink: 0; }
.settings-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.settings-body { flex: 1; overflow-y: auto; padding: 24px; max-width: 720px; }
.settings-card { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; }
.section-title { font-size: 14px; font-weight: 600; margin: 0 0 16px; color: var(--text-primary); }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-primary); }
.form-hint { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; }
.input-desc { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
.input-row { display: flex; gap: 10px; }
.form-row-inline { display: flex; gap: 16px; }
.flex-1 { flex: 1; min-width: 0; }
.full-width { width: 100%; }

.tabs-card { border: 1px solid var(--border-color); border-radius: 12px; overflow: hidden; }
.tabs-card :deep(.n-tabs-nav) { padding: 0 16px; background: var(--bg-primary); }
.tab-content { padding: 20px 24px; }
.tab-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 20px; line-height: 1.6; }

/* Toggle rows */
.setting-row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border-color); gap: 16px; }
.setting-row:last-child { border-bottom: none; }
.setting-label { font-size: 13px; font-weight: 500; color: var(--text-primary); white-space: nowrap; }
.setting-desc { font-size: 12px; color: var(--text-muted); flex: 1; text-align: right; }
.setting-info { display: flex; align-items: center; gap: 8px; }

/* Token row */
.token-row { display: flex; gap: 10px; }
.status-row { display: flex; align-items: center; gap: 12px; }

/* Actions */
.settings-actions { padding: 0 0 40px; }
.settings-actions .n-button { min-width: 120px; }


</style>
