<template>
  <div class="images-settings">
    <div class="is-header">
      <h2 class="is-title">{{ $t('settings.manageImages') }}</h2>
      <p class="is-sub">{{ $t('settings.imagesManageDesc') }}</p>
    </div>

    <div class="is-card">
      <div class="is-group">
        <label class="is-label">{{ $t('settings.imageProvider') }}</label>
        <p class="is-desc">{{ $t('settings.imageProviderDesc') }}</p>
        <n-select v-model:value="form.imageProvider" :options="providerOptions" size="large" class="is-input" />
      </div>

      <div v-if="form.imageProvider !== 'pollinations'" class="is-group">
        <label class="is-label">{{ $t('settings.imageApiKey') }}</label>
        <p class="is-desc">{{ keyHint }}</p>
        <n-input
          v-model:value="form.imageApiKey"
          type="password"
          show-password-on="click"
          size="large"
          class="is-input"
          :placeholder="keyPlaceholder"
        />
        <button class="is-btn is-btn-line" @click="testKey">{{ $t('settings.testKey') }}</button>
      </div>

      <div v-if="form.imageProvider === 'doubao'" class="is-group">
        <label class="is-label">{{ $t('settings.doubaoModel') }}</label>
        <p class="is-desc">{{ $t('settings.doubaoModelDesc') }}</p>
        <n-input v-model:value="form.doubaoModel" size="large" class="is-input" />
      </div>

      <div v-if="form.imageProvider === 'gemini'" class="is-group">
        <label class="is-label">{{ $t('settings.geminiImageModel') }}</label>
        <p class="is-desc">{{ $t('settings.geminiImageModelDesc') }}</p>
        <n-input v-model:value="form.geminiImageModel" size="large" class="is-input" />
      </div>

      <div v-if="form.imageProvider === 'openai'" class="is-group">
        <label class="is-label">{{ $t('settings.openaiImageModel') }}</label>
        <p class="is-desc">{{ $t('settings.openaiImageModelDesc') }}</p>
        <n-input v-model:value="form.openaiImageModel" size="large" class="is-input" />
      </div>

      <div v-if="form.imageProvider === 'replicate'" class="is-group">
        <label class="is-label">{{ $t('settings.replicateModel') }}</label>
        <p class="is-desc">{{ $t('settings.replicateModelDesc') }}</p>
        <n-input v-model:value="form.replicateModel" size="large" class="is-input" />
      </div>

      <div class="is-group is-actions">
        <button class="is-btn is-btn-primary" @click="save" :disabled="saving">{{ saving ? $t('settings.saving') : $t('settings.saveImages') }}</button>
        <span v-if="saved" class="is-saved">{{ $t('settings.savedTip') }}</span>
        <span v-if="testResult" class="is-test-result" :class="{ ok: testOk }">{{ testResult }}</span>
      </div>
    </div>

    <div class="is-card is-hint">
      <h4 class="is-section">{{ $t('settings.imagesHintTitle') }}</h4>
      <p class="is-desc">{{ $t('settings.imagesHintBody') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })
const nMessage = useMessage()
const keyHint = computed(() => {
  switch (form.imageProvider) {
    case 'gemini': return t('settings.geminiKeyHint')
    case 'stability': return t('settings.stabilityKeyHint')
    case 'replicate': return t('settings.replicateKeyHint')
    case 'openai': return t('settings.openaiKeyHint')
    default: return t('settings.doubaoKeyHint') // doubao
  }
})
const keyPlaceholder = computed(() => {
  switch (form.imageProvider) {
    case 'gemini': return 'AIza…'
    case 'stability': return 'sk-…'
    case 'replicate': return 'r8_…'
    case 'openai': return 'sk-…'
    default: return 'ARK …'
  }
})
const saving = ref(false)
const saved = ref(false)
const testResult = ref('')
const testOk = ref(false)
const form = reactive({
  imageProvider: 'pollinations',
  imageApiKey: '',
  doubaoModel: 'doubao-seedream-5-0-260128',
  geminiImageModel: 'gemini-2.5-flash-image',
  openaiImageModel: 'gpt-image-1',
  replicateModel: 'black-forest-labs/flux-schnell',
})
const providerOptions = ref<Array<{ label: string; value: string }>>([
  { label: 'Pollinations（' + t('settings.badgeFree') + '）', value: 'pollinations' },
  { label: t('settings.doubaoName'), value: 'doubao' },
  { label: t('settings.geminiName'), value: 'gemini' },
  { label: 'Stability AI', value: 'stability' },
  { label: 'Replicate FLUX', value: 'replicate' },
  { label: 'OpenAI gpt-image-1', value: 'openai' },
])

onMounted(async () => {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return
    const data = await res.json()
    if (data.imageProvider) form.imageProvider = data.imageProvider
    form.imageApiKey = data.imageApiKey || ''
    if (data.doubaoModel) form.doubaoModel = data.doubaoModel
    if (data.geminiImageModel) form.geminiImageModel = data.geminiImageModel
    if (data.openaiImageModel) form.openaiImageModel = data.openaiImageModel
    if (data.replicateModel) form.replicateModel = data.replicateModel
  } catch {}
})

async function save() {
  saving.value = true
  saved.value = false
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageProvider: form.imageProvider,
        imageApiKey: form.imageApiKey,
        doubaoModel: form.doubaoModel,
        geminiImageModel: form.geminiImageModel,
        openaiImageModel: form.openaiImageModel,
        replicateModel: form.replicateModel,
      }),
    })
    if (!res.ok) throw new Error('save failed')
    nMessage.success(t('settings.savedTip'))
    saved.value = true
  } catch (e: any) {
    nMessage.error(t('settings.saveFail') + (e.message || ''))
  } finally {
    saving.value = false
    setTimeout(() => (saved.value = false), 2500)
  }
}

async function testKey() {
  testResult.value = ''
  nMessage.loading(t('settings.testingKey'), { duration: 0 })
  try {
    const p = form.imageProvider
    const key = form.imageApiKey
    let endpoint = ''
    let method = 'POST'
    const headers: Record<string, any> = {}
    let body: any = ''
    if (p === 'gemini') {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${form.geminiImageModel}:generateContent`
      headers['x-goog-api-key'] = key; headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ contents: [{ parts: [{ text: 'a red dot' }] }], generationConfig: { responseModalities: ['IMAGE'] } })
    } else if (p === 'doubao') {
      endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
      headers.Authorization = `Bearer ${key}`; headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ model: form.doubaoModel, prompt: 'a red dot', size: '1K', response_format: 'url', watermark: false })
    } else if (p === 'stability') {
      endpoint = 'https://api.stability.ai/v2beta/stable-image/generate/core'
      headers.Authorization = `Bearer ${key}`; headers.Accept = 'image/*'
      const fd = new FormData(); fd.append('prompt', 'a red dot'); fd.append('output_format', 'png')
      body = fd
    } else if (p === 'replicate') {
      endpoint = 'https://api.replicate.com/v1/predictions'
      headers.Authorization = `Bearer ${key}`; headers['Content-Type'] = 'application/json'; headers.Prefer = 'wait'
      body = JSON.stringify({ version: form.replicateModel, input: { prompt: 'a red dot' } })
    } else if (p === 'openai') {
      endpoint = 'https://api.openai.com/v1/images/generations'
      headers.Authorization = `Bearer ${key}`; headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ model: form.openaiImageModel, prompt: 'a red dot', size: '1024x1024', response_format: 'b64_json' })
    }
    if (!endpoint) { testResult.value = t('settings.keyFail'); testOk.value = false; nMessage.destroyAll(); return }
    const res = await fetch(endpoint, { method, headers, body })
    if (res.ok) { testOk.value = true; testResult.value = t('settings.keyOk') }
    else { testOk.value = false; testResult.value = `${t('settings.keyFail')} (${res.status})` }
  } catch (e: any) {
    testOk.value = false
    testResult.value = t('settings.keyFail') + ': ' + e.message
  } finally {
    nMessage.destroyAll()
  }
}
</script>

<style scoped>
.images-settings { padding: 24px 28px; max-width: 720px; }
.is-header { margin-bottom: 18px; }
.is-title { font-size: 18px; font-weight: 600; margin: 0 0 4px; color: var(--text-primary); }
.is-sub { margin: 0; font-size: 13px; color: var(--text-secondary); }
.is-card { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
.is-group { margin-bottom: 18px; }
.is-group:last-child { margin-bottom: 0; }
.is-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary); }
.is-desc { margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
.is-input { width: 100%; max-width: 380px; }
.is-btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); }
.is-btn-line { margin-top: 8px; background: transparent; }
.is-btn-primary { background: var(--accent, #6366f1); color: #fff; border-color: transparent; }
.is-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.is-actions { display: flex; align-items: center; gap: 12px; }
.is-saved { color: var(--success, #3fb950); font-size: 12px; }
.is-test-result { font-size: 12px; }
.is-test-result.ok { color: var(--success, #3fb950); }
.is-hint { background: var(--bg-secondary); }
.is-section { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
</style>
