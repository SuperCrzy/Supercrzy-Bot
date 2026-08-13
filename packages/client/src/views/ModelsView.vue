<template>
  <div class="page-container">
    <div v-if="!pageReady" class="loading-state">
      <span>{{ $t('common.loading') }}</span>
    </div>
    <template v-else>
    <header class="page-header">
      <h2>{{ $t('models.title') }}</h2>
      <p class="page-desc">{{ $t('models.desc') }}</p>
    </header>

    <!-- ===== 1. 当前模型 ===== -->
    <div class="current-model-bar">
      <div class="cmb-left">
        <span class="cmb-icon">🔮</span>
        <div class="cmb-info">
          <span class="cmb-label">{{ $t('models.currentModel') }}</span>
          <n-select
            v-model:value="currentModel"
            :options="allModelOptions"
            size="small"
            class="cmb-select"
          />
        </div>
      </div>
      <div class="cmb-right">
        <span v-if="currentProvider.baseUrl" class="cmb-url">{{ currentProvider.baseUrl }}</span>
        <n-button size="tiny" @click="testCurrentModel" :loading="testing">
          {{ testing ? $t('models.testing') : $t('models.testConnection') }}
        </n-button>
      </div>
      <div v-if="testResult" class="cmb-test-result" :class="testResult.ok ? 'ok' : 'fail'">
        {{ testResult.msg }}
      </div>
    </div>

    <!-- ===== 2. API 提供商 ===== -->
    <div class="provider-section">
      <h3 class="section-title">{{ $t('models.providers') }}</h3>
      <p class="section-desc">{{ $t('models.providerHint') }}</p>
      <div class="provider-chips">
        <button
          v-for="p in presetProviders"
          :key="p.id"
          class="provider-chip"
          :class="{ active: currentProvider.id === p.id, configured: p.configured }"
          @click="openProviderConfig(p)"
        >
          <ProviderBadge :provider="p.id" :size="22" />
          <span class="chip-name">{{ p.label }}</span>
          <span v-if="p.configured" class="chip-check">✓</span>
          <span v-if="currentProvider.id === p.id" class="chip-current">{{ $t('models.current') }}</span>
        </button>
      </div>
    </div>

    <!-- ===== Provider Config Modal ===== -->
    <n-modal v-model:show="showProviderModal" :title="$t('models.configProvider')" preset="dialog" style="width:460px">
      <n-form label-placement="top">
        <n-form-item :label="$t('models.provider')">
          <n-input :value="editingProvider.label" disabled />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="editingProvider.apiKey" type="password" show-password-on="click" :placeholder="$t('models.apiKeyPlaceholder')" />
        </n-form-item>
        <div class="discover-row">
          <n-button size="small" type="primary" :disabled="!editingProvider.apiKey" :loading="discovering" @click="discoverModels">
            {{ discoveredModels.length > 0 ? $t('models.redetect') : $t('models.detectModels') }}
          </n-button>
          <span v-if="discoverError" class="discover-error">{{ discoverError }}</span>
          <span v-else-if="discoveredModels.length > 0" class="discover-count">{{ $t('models.detectedCount', { n: discoveredModels.length }) }}</span>
        </div>
        <n-form-item v-if="discoveredModels.length > 0" :label="$t('models.pickModel')">
          <n-select
            v-model:value="editingProvider.defaultModel"
            :options="discoveredModels.map((m) => ({ label: m, value: m }))"
            filterable
            size="small"
            :placeholder="$t('models.selectModel')"
          />
        </n-form-item>
        <n-form-item label="Base URL">
          <n-input v-model:value="editingProvider.baseUrl" placeholder="https://api.example.com/v1">
            <template #suffix>
              <n-button size="tiny" @click="editingProvider.baseUrl = editingProvider.defaultBaseUrl" secondary>{{ $t('models.resetDefault') }}</n-button>
            </template>
          </n-input>
        </n-form-item>
        <n-form-item :label="$t('models.defaultModel')">
          <n-input v-model:value="editingProvider.defaultModel" placeholder="e.g. deepseek-v4-pro" />
        </n-form-item>
        <div v-if="discoveredModels.length > 0" class="discover-list">
          <span
            v-for="m in discoveredModels.slice(0, 12)"
            :key="m"
            class="discover-chip"
            :class="{ active: editingProvider.defaultModel === m }"
            @click="editingProvider.defaultModel = m"
          >{{ m }}</span>
          <span v-if="discoveredModels.length > 12" class="discover-more">{{ $t('models.moreModels', { n: discoveredModels.length - 12 }) }}</span>
        </div>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showProviderModal = false">{{ $t('common.cancel') }}</n-button>
          <n-button type="primary" @click="saveProvider" :loading="savingProvider">{{ $t('models.saveAndSwitch') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ===== 3. 已配置模型列表 ===== -->
    <div class="configured-models">
      <div class="models-header">
        <h3 class="section-title">{{ $t('models.configuredModels') }}</h3>
        <n-button size="small" type="primary" @click="showAddModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ $t('models.addModel') }}
        </n-button>
      </div>

      <div v-if="displayModels.length === 0" class="empty-hint">
        {{ $t('models.noModels') }}
      </div>

      <div v-else class="models-table">
        <div class="table-header">
          <span class="col-name">{{ $t('models.colModel') }}</span>
          <span class="col-provider">{{ $t('models.colProvider') }}</span>
          <span class="col-key">API Key</span>
          <span class="col-status">{{ $t('models.colStatus') }}</span>
          <span class="col-actions">{{ $t('models.colActions') }}</span>
        </div>
        <div v-for="model in displayModels" :key="model.id" class="table-row" :class="{ 'is-current': model.id === currentModel || model.modelId === currentModel, 'is-auto': model.isAutoDerived }">
          <span class="col-name">
            {{ model.displayName || model.modelId }}
            <n-tag v-if="model.id === currentModel || model.modelId === currentModel" size="tiny" :bordered="false" type="success" style="margin-left:6px">{{ $t('models.current') }}</n-tag>
            <n-tag v-if="model.isAutoDerived" size="tiny" :bordered="false" type="info" style="margin-left:4px">{{ $t('models.autoDerivedTag') }}</n-tag>
          </span>
          <span class="col-provider">{{ model.providerName }}</span>
          <span class="col-key">{{ model.hasApiKey ? $t('models.configured') : $t('models.notConfigured') }}</span>
          <span class="col-status">
            <n-switch :value="model.enabled" :disabled="model.isAutoDerived" @update:value="(v:boolean) => toggleCustomModel(model.id, v)" size="small" />
          </span>
          <span class="col-actions">
            <n-button v-if="!model.isAutoDerived" text size="tiny" type="primary" @click="editCustomModel(model)" style="margin-right:4px">{{ $t('common.edit') }}</n-button>
            <n-button v-if="!model.isAutoDerived" text size="tiny" type="error" @click="confirmDelete(model)">{{ $t('common.delete') }}</n-button>
            <span v-else class="col-actions-hint" :title="$t('models.autoDerived')">由提供商配置派生</span>
          </span>
        </div>
      </div>
    </div>

    <!-- ===== Add Model Modal ===== -->
    <n-modal v-model:show="showAddModal" :title="$t('models.addModelTitle')" preset="dialog" style="width:480px">
      <n-form ref="formRef" :model="addForm" :rules="addRules" label-placement="top">
        <n-form-item :label="$t('models.provider')" path="providerId">
          <n-select v-model:value="addForm.providerId" :options="providerOptions" :placeholder="$t('models.providerPlaceholder')" @update:value="onProviderChange" />
        </n-form-item>
        <n-form-item :label="$t('models.modelId')" path="modelId">
          <n-input v-model:value="addForm.modelId" placeholder="e.g. gpt-4o" />
        </n-form-item>
        <n-form-item :label="$t('models.displayName')">
          <n-input v-model:value="addForm.displayName" :placeholder="$t('models.displayNamePlaceholder')" />
        </n-form-item>
        <n-form-item :label="$t('models.baseUrl')">
          <n-input v-model:value="addForm.baseUrl" placeholder="https://api.example.com/v1" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="addForm.apiKey" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <n-form-item :label="$t('models.capabilities')">
          <n-checkbox-group v-model:value="addForm.capabilities">
            <n-checkbox value="chat" :label="$t('models.capChat')" />
            <n-checkbox value="reasoning" :label="$t('models.capReasoning')" />
            <n-checkbox value="tool-calling" :label="$t('models.capTools')" />
            <n-checkbox value="vision" :label="$t('models.capVision')" />
          </n-checkbox-group>
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showAddModal = false">{{ $t('common.cancel') }}</n-button>
          <n-button type="primary" @click="handleAddModel" :loading="adding">{{ $t('common.create') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ===== Delete Confirm ===== -->
    <n-modal v-model:show="showDeleteModal" :title="$t('models.confirmDeleteTitle')" preset="dialog" type="warning">
      <p>{{ $t('models.confirmDeleteMsg') }} <strong>{{ deletingModel?.displayName || deletingModel?.modelId }}</strong>?</p>
      <template #action>
        <n-space>
          <n-button @click="showDeleteModal = false">{{ $t('common.cancel') }}</n-button>
          <n-button type="error" @click="handleDelete">{{ $t('common.delete') }}</n-button>
        </n-space>
      </template>
    </n-modal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { NButton, NInput, NSelect, NTag, NModal, NForm, NFormItem, NSwitch, NCheckbox, NCheckboxGroup, NSpace, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import ProviderBadge from '@/components/ui/ProviderBadge.vue'
import { getModelShortName } from '@/data/models'
import type { CustomModel, AddModelForm } from '@/types'

const appStore = useAppStore()
const { t } = useI18n({ useScope: 'global' })
const message = useMessage()

// ===== Providers =====
interface ProviderDef {
  id: string; icon: string; label: string; baseUrl: string; defaultModel: string
}
interface ProviderConfig { apiKey: string; baseUrl: string; defaultModel: string; models?: string[] }

const PREDEFINED: ProviderDef[] = [
  { id: 'ollama',       icon: 'OL', label: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1',          defaultModel: 'llama3.1' },
  { id: 'deepseek',     icon: 'DS', label: 'DeepSeek',     baseUrl: 'https://api.deepseek.com/v1',          defaultModel: 'deepseek-v4-pro' },
  { id: 'openai',       icon: 'OA', label: 'OpenAI',       baseUrl: 'https://api.openai.com/v1',             defaultModel: 'gpt-4o' },
  { id: 'openrouter',   icon: 'OR', label: 'OpenRouter',   baseUrl: 'https://openrouter.ai/api/v1',          defaultModel: 'anthropic/claude-sonnet-4-20250514' },
  { id: 'anthropic',    icon: 'AC', label: 'Anthropic',    baseUrl: 'https://api.anthropic.com/v1',          defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'grok',         icon: 'XA', label: 'xAI Grok',     baseUrl: 'https://api.x.ai/v1',                   defaultModel: 'grok-4' },
  { id: 'gemini',       icon: 'GM', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-pro' },
  { id: 'mistral',      icon: 'MS', label: 'Mistral',      baseUrl: 'https://api.mistral.ai/v1',             defaultModel: 'mistral-large-latest' },
  { id: 'zhipu',        icon: 'GL', label: '智谱 GLM',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.7' },
  { id: 'kimi',         icon: 'KM', label: 'Kimi',         baseUrl: 'https://api.moonshot.cn/v1',            defaultModel: 'moonshot-v1-8k' },
  { id: 'mimo',         icon: 'MM', label: '小米 MiMo',    baseUrl: 'https://api.xiaomimimo.com/v1',         defaultModel: 'mimo-v2.5-pro' },
]

const LS_PREFIX = 'supercrzy:provider:'

/** 从 localStorage 加载 per-provider 配置 */
function loadLSConfigs(): Record<string, ProviderConfig> {
  const cfg: Record<string, ProviderConfig> = {}
  for (const p of PREDEFINED) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + p.id)
      if (raw) {
        const parsed = JSON.parse(raw)
        cfg[p.id] = {
          apiKey: parsed.apiKey || '',
          baseUrl: parsed.baseUrl || p.baseUrl,
          defaultModel: parsed.defaultModel || p.defaultModel,
        }
      }
    } catch { /* ignore corrupt data */ }
  }
  return cfg
}

/** 保存单个 provider 配置到 localStorage */
function saveLSConfig(id: string, config: ProviderConfig) {
  localStorage.setItem(LS_PREFIX + id, JSON.stringify(config))
}

/** 删除单个 provider 的 localStorage 配置 */
function removeLSConfig(id: string) {
  localStorage.removeItem(LS_PREFIX + id)
}

// providerConfigs 用 reactive 而非 ref，确保深层变更触发视图更新
const providerConfigs = reactive<Record<string, ProviderConfig>>(loadLSConfigs())

/** 全局 settings 表里是否已配置 API Key（脱敏后接口只返回 hasApiKey，不返回明文） */
const hasGlobalKey = ref(false)

/** 从 /api/settings 加载全局 DeepSeek 作为 fallback */
async function loadGlobalSettings() {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) { console.log('[Models] settings fetch failed:', res.status); return }
    const data = await res.json()
    console.log('[Models] settings loaded, hasApiKey:', !!data.hasApiKey, 'model:', data.model)
    hasGlobalKey.value = !!data.hasApiKey || !!data.apiKeyMasked
    // 仅当 DeepSeek 还没在 localStorage 配置时，用全局设置填充
    const ds = providerConfigs.deepseek
    const hasLS = !!(ds && ds.apiKey)
    console.log('[Models] deepseek config:', { hasLS, hasApiKey: hasGlobalKey.value, hasMasked: !!data.apiKeyMasked })
    if (!hasLS && hasGlobalKey.value) {
      const cfg: ProviderConfig = {
        apiKey: '',
        baseUrl: data.baseUrl || PREDEFINED[0].baseUrl,
        defaultModel: data.model || PREDEFINED[0].defaultModel,
      }
      providerConfigs.deepseek = cfg
      saveLSConfig('deepseek', cfg)
      console.log('[Models] deepseek provider configured:', cfg.defaultModel)
    }
    // 如果有 thirdPartyProviders，也合并进去
    if (Array.isArray(data.thirdPartyProviders)) {
      for (const tp of data.thirdPartyProviders) {
        const preset = PREDEFINED.find(p => p.label.toLowerCase() === (tp.label || '').toLowerCase())
        if (preset && tp.enabled && tp.apiKey && !providerConfigs[preset.id]?.apiKey) {
          const cfg: ProviderConfig = {
            apiKey: tp.apiKey,
            baseUrl: tp.baseUrl || preset.baseUrl,
            defaultModel: tp.model || preset.defaultModel,
          }
          providerConfigs[preset.id] = cfg
          saveLSConfig(preset.id, cfg)
        }
      }
    }
  } catch { /* ignore */ }
}

// ===== Current model & provider =====
/** 当前模型 — 双向绑定到 appStore，侧边栏切换也会同步 */
const currentModel = computed({
  get: () => appStore.currentModel,
  set: (v: string) => {
    appStore.currentModel = v
    message.success(t('models.switchedTo', { model: v }))
  },
})
const testing = ref(false)
const testResult = ref<{ ok: boolean; msg: string } | null>(null)
const pageReady = ref(false) // loading state

/** 当前使用的 provider（根据 currentModel 反查） */
const currentProvider = computed(() => {
  const model = currentModel.value
  const cfg = providerConfigs as Record<string, ProviderConfig>

  // 1. 优先匹配：哪个 provider 的 defaultModel 就是当前 model
  for (const p of PREDEFINED) {
    if (cfg[p.id]?.defaultModel === model) {
      return { id: p.id, baseUrl: cfg[p.id].baseUrl || p.baseUrl }
    }
  }
  // 2. 检查自定义模型
  const custom = customModels.value.find(m => m.modelId === model)
  if (custom) {
    return { id: custom.providerId || 'custom', baseUrl: custom.baseUrl || '' }
  }
  // 3. 回退到 DeepSeek
  return { id: 'deepseek', baseUrl: cfg.deepseek?.baseUrl || PREDEFINED[0].baseUrl }
})

/** provider chips 数据（含 configured 状态） */
const presetProviders = computed(() =>
  PREDEFINED.map(p => ({
    ...p,
    configured: !!(providerConfigs[p.id]?.apiKey) || (p.id === 'deepseek' && hasGlobalKey.value),
  }))
)

/** 当前模型选择器选项 — 只显示已配置的模型，和侧边栏保持一致 */
const allModelOptions = computed(() => {
  const seen = new Set<string>()
  const result: Array<{ label: string; value: string } | { type: 'group'; label: string; key: string; children: Array<{ label: string; value: string }> }> = []

  // 1. 已配置的 provider 默认模型（从 providerConfigs 读取）
  for (const p of PREDEFINED) {
    const cfg = providerConfigs[p.id]
    const isConfigured = !!cfg?.apiKey || (p.id === 'deepseek' && hasGlobalKey.value)
    if (isConfigured && cfg?.defaultModel && !seen.has(cfg.defaultModel)) {
      seen.add(cfg.defaultModel)
      const short = getModelShortName(cfg.defaultModel)
      const label = short !== cfg.defaultModel ? `${short} (${p.label})` : `${cfg.defaultModel} (${p.label})`
      result.push({ label, value: cfg.defaultModel })
    }
  }

  // 2. 自定义模型
  const customOpts = customModels.value
    .filter(m => m.enabled && !seen.has(m.modelId))
    .map(m => {
      seen.add(m.modelId)
      return { label: `${m.displayName || m.modelId} (${m.providerName})`, value: m.modelId }
    })

  // 3. 组装
  if (result.length > 0 && customOpts.length > 0) {
    return [
      ...result,
      { type: 'group' as const, label: t('models.customModels'), key: 'custom', children: customOpts },
    ]
  }
  return [...result, ...customOpts]
})

async function testCurrentModel() {
  testing.value = true
  testResult.value = null
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentModel.value, messages: [{ role: 'user', content: 'ping' }], max_tokens: 10, temperature: 0 }),
    })
    if (res.ok) {
      testResult.value = { ok: true, msg: t('models.connOk', { model: currentModel.value }) }
    } else {
      const e = await res.json().catch(() => ({}))
      testResult.value = { ok: false, msg: t('models.connFail', { err: (e as any).error?.message || res.statusText }) }
    }
  } catch {
    testResult.value = { ok: false, msg: t('models.networkErr') }
  } finally {
    testing.value = false
  }
}

// ===== Provider Config Modal =====
const showProviderModal = ref(false)
const savingProvider = ref(false)
const editingProvider = reactive({ id: '', label: '', apiKey: '', baseUrl: '', defaultBaseUrl: '', defaultModel: '' })
const discovering = ref(false)
const discoveredModels = ref<string[]>([])
const discoverError = ref('')

/** 用当前填写的 API Key 拉取该渠道可用模型列表 */
async function discoverModels() {
  if (!editingProvider.apiKey || discovering.value) return
  discovering.value = true
  discoverError.value = ''
  try {
    const res = await fetch('/api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: editingProvider.id,
        apiKey: editingProvider.apiKey,
        baseUrl: editingProvider.baseUrl,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      discoverError.value = data.error || `HTTP ${res.status}`
      discoveredModels.value = []
      return
    }
    discoveredModels.value = data.models || []
    if (discoveredModels.value.length > 0) {
      // 当前默认模型不在列表时,自动选中第一个
      if (!discoveredModels.value.includes(editingProvider.defaultModel)) {
        editingProvider.defaultModel = discoveredModels.value[0]
      }
    } else if (data.error) {
      discoverError.value = data.error
    }
  } catch {
    discoverError.value = t('models.detectFail')
  } finally {
    discovering.value = false
  }
}

function openProviderConfig(p: typeof presetProviders.value[0]) {
  Object.assign(editingProvider, {
    id: p.id, label: p.label,
    apiKey: providerConfigs[p.id]?.apiKey || '',
    baseUrl: providerConfigs[p.id]?.baseUrl || p.baseUrl,
    defaultBaseUrl: p.baseUrl,
    defaultModel: providerConfigs[p.id]?.defaultModel || p.defaultModel,
  })
  discoveredModels.value = providerConfigs[p.id]?.models || []
  discoverError.value = ''
  showProviderModal.value = true
}

/** 从已配置模型表格点编辑 → 打开对应提供商的配置弹窗 */
function editCustomModel(model: CustomModel) {
  const preset = presetProviders.value.find(
    p => p.id === model.providerId || model.providerKey === p.id
  )
  if (preset) {
    openProviderConfig(preset)
  }
}

async function saveProvider() {
  savingProvider.value = true
  try {
    const pid = editingProvider.id
    const cfg: ProviderConfig = {
      apiKey: editingProvider.apiKey,
      baseUrl: editingProvider.baseUrl,
      defaultModel: editingProvider.defaultModel,
      models: discoveredModels.value.length > 0 ? discoveredModels.value : undefined,
    }

    if (cfg.apiKey) {
      // 持久化到 localStorage
      saveLSConfig(pid, cfg)
      // 同步更新 reactive
      providerConfigs[pid] = cfg

      // 保存 API Key 到后端 provider 表（所有 provider 通用）
      fetch(`/api/models/providers/${pid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, models: cfg.models || [], enabled: true }),
      }).catch(() => { /* 非关键，provider 可能在 DB 中不存在 */ })

      // 对于 DeepSeek，额外同步到 /api/settings（保持兼容）
      if (pid === 'deepseek') {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: cfg.apiKey, model: cfg.defaultModel, baseUrl: cfg.baseUrl }),
        }).catch(() => { /* non-critical */ })
      }

      // 尝试在后端创建 custom_models 记录（非关键，失败不影响）
      const providerName = PREDEFINED.find(p => p.id === pid)?.label || ''
      const exists = customModels.value.find(
        m => m.providerName?.toLowerCase() === providerName.toLowerCase()
          && m.modelId === cfg.defaultModel
      )
      if (!exists) {
        try {
          const res = await fetch('/api/models/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: pid,
              modelId: cfg.defaultModel,
              displayName: cfg.defaultModel,
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              capabilities: ['chat', 'reasoning'],
            }),
          })
          if (res.ok) await fetchCustomModels()
        } catch { /* provider 可能不在 custom_providers 表，忽略 */ }
      }
    } else {
      // 清空 API Key = 移除配置
      removeLSConfig(pid)
      providerConfigs[pid] = { apiKey: '', baseUrl: editingProvider.defaultBaseUrl, defaultModel: editingProvider.defaultModel }
    }

    // 切换到该 provider 的默认模型
    appStore.currentModel = editingProvider.defaultModel
    showProviderModal.value = false
    message.success(cfg.apiKey ? t('models.saved') : t('models.removed'))
    appStore.notifyProvidersChanged()
  } catch (err: any) {
    message.error(err.message || t('models.saveFail'))
  } finally {
    savingProvider.value = false
  }
}

// ===== Custom Models =====
const customModels = ref<CustomModel[]>([])

/** 从已配置 API Key 的 provider 派生虚拟模型条目 */
const derivedModels = computed(() => {
  const models: CustomModel[] = []
  for (const p of PREDEFINED) {
    const cfg = providerConfigs[p.id]
    if (cfg?.apiKey) {
      console.log('[Models] derived check:', p.id, 'apiKey:', cfg.apiKey.slice(0,8)+'...', 'model:', cfg.defaultModel)
      const exists = customModels.value.some(
        m => (m.providerName || '').toLowerCase() === p.label.toLowerCase()
          && m.modelId === (cfg.defaultModel || p.defaultModel)
      )
      console.log('[Models] derived exists?', p.id, exists, 'customModels count:', customModels.value.length)
      if (!exists) {
        models.push({
          id: `auto-${p.id}`,
          providerId: p.id,
          providerName: p.label,
          providerKey: p.id,
          modelId: cfg.defaultModel || p.defaultModel,
          displayName: cfg.defaultModel || p.defaultModel,
          baseUrl: cfg.baseUrl,
          hasApiKey: true,
          enabled: true,
          isDefault: false,
          isAutoDerived: true,
          createdAt: '',
          updatedAt: '',
        } as CustomModel)
      }
    }
  }
  console.log('[Models] derivedModels result:', models.length, 'entries:', models.map(m => m.providerName))
  return models
})

/** 合并显示：派生模型 + 自定义模型 */
const displayModels = computed(() => {
  const d = derivedModels.value
  const c = customModels.value
  console.log('[Models] displayModels: derived=', d.length, 'custom=', c.length)
  return [...d, ...c]
})

const showAddModal = ref(false)
const adding = ref(false)
const formRef = ref<any>(null)
const addForm = ref<AddModelForm & { baseUrl?: string; apiKey?: string; capabilities?: string[] }>({
  providerId: '', modelId: '', displayName: '', baseUrl: '', apiKey: '', capabilities: ['chat'],
})

const addRules = {
  providerId: [{ required: true, message: t('models.requireProvider'), trigger: 'blur' }],
  modelId: [{ required: true, message: t('models.requireModelId'), trigger: 'blur' }],
}

const providerOptions = computed(() => [
  ...PREDEFINED.map(p => ({ label: p.icon + ' ' + p.label, value: p.id })),
  { label: t('models.custom'), value: 'custom' },
])

const showDeleteModal = ref(false)
const deletingModel = ref<CustomModel | null>(null)

async function fetchCustomModels() {
  try {
    const res = await fetch('/api/models/custom')
    if (res.ok) customModels.value = await res.json()
  } catch { /* ignore */ }
}

function onProviderChange() {
  addForm.value.modelId = ''
  const p = PREDEFINED.find(pr => pr.id === addForm.value.providerId)
  if (p) {
    addForm.value.baseUrl = providerConfigs[p.id]?.baseUrl || p.baseUrl
    addForm.value.capabilities = ['chat']
  }
}

async function handleAddModel() {
  try { await formRef.value?.validate() } catch { return }
  adding.value = true
  try {
    const res = await fetch('/api/models/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm.value),
    })
    const data = await res.json()
    if (!res.ok) { message.error(data.error || t('models.addFail')); return }
    message.success(t('models.added'))
    showAddModal.value = false
    addForm.value = { providerId: '', modelId: '', displayName: '', baseUrl: '', apiKey: '', capabilities: ['chat'] }
    await fetchCustomModels()
  } catch (err: any) { message.error(err.message || t('models.addFail')) } finally { adding.value = false }
}

async function toggleCustomModel(id: string, enabled: boolean) {
  if (id.startsWith('auto-')) return // 自动派生模型不可切换
  try {
    const res = await fetch(`/api/models/custom/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); message.error((d as any).error || t('models.opFail')); return }
    const m = customModels.value.find(mod => mod.id === id)
    if (m) m.enabled = enabled
    message.success(enabled ? t('common.enabled') : t('common.disabled'))
  } catch (err: any) { message.error(err.message || t('models.opFail')) }
}

function confirmDelete(model: CustomModel) {
  deletingModel.value = model
  showDeleteModal.value = true
}

async function handleDelete() {
  if (!deletingModel.value) return
  try {
    const res = await fetch(`/api/models/custom/${deletingModel.value.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); message.error((d as any).error || t('models.deleteFail')); return }
    message.success(t('models.deleted'))
    showDeleteModal.value = false
    deletingModel.value = null
    await fetchCustomModels()
  } catch (err: any) { message.error(err.message || t('models.deleteFail')) }
}

onMounted(async () => {
  await Promise.all([
    loadGlobalSettings(),
    fetchCustomModels(),
    appStore.fetchCustomModels?.(),
  ].filter(Boolean))
  pageReady.value = true
})
</script>

<style scoped>
/* Loading */
.loading-state { display:flex;align-items:center;justify-content:center;padding:60px 20px;font-size:14px;color:var(--text-muted,#888) }

/* Current Model Bar */
.current-model-bar { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;margin-bottom:16px;background:var(--bg-secondary,#1e1e2e);border-radius:10px;border:1px solid var(--border-color,#2a2a3e);flex-wrap:wrap }
.cmb-left { display:flex;align-items:center;gap:10px }
.cmb-icon { font-size:22px }
.cmb-label { font-size:11px;color:var(--text-muted,#888);display:block;margin-bottom:2px }
.cmb-select { width:200px }
.cmb-right { display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted,#888) }
.cmb-url { font-size:11px;opacity:.6;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.cmb-test-result { width:100%;font-size:12px;padding:4px 8px;border-radius:6px;margin-top:8px }
.cmb-test-result.ok { color:#22c55e;background:rgba(34,197,94,.08) }
.cmb-test-result.fail { color:#ef4444;background:rgba(239,68,68,.08) }

/* Provider Section */
.provider-section { margin-bottom:20px }
.section-title { font-size:15px;font-weight:600;margin:0 0 4px }
.section-desc { font-size:12px;color:var(--text-muted,#888);margin:0 0 12px }
.provider-chips { display:flex;gap:8px;flex-wrap:wrap }
.provider-chip { display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:1px solid var(--border-color,#2a2a3e);background:var(--bg-primary,#16161e);cursor:pointer;font-size:13px;color:var(--text-primary);transition:all .15s;position:relative }
.provider-chip:hover { border-color:#4F46E5 }
.provider-chip.active { border-color:#4F46E5;background:rgba(79,70,229,.08);font-weight:600 }
.provider-chip.configured { border-color:#22c55e }
.chip-icon { font-size:16px }

.discover-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.discover-error { color: #e5484d; font-size: 12px; }
.discover-count { color: #68738d; font-size: 12px; }
.discover-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.discover-chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 12px;
  border: 1px solid rgba(127,127,127,0.3);
  color: #68738d;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.discover-chip:hover { border-color: var(--accent, #4f7cff); color: var(--accent, #4f7cff); }
.discover-chip.active { background: var(--accent, #4f7cff); border-color: var(--accent, #4f7cff); color: #fff; }
.discover-more { font-size: 11px; color: #98a2b3; align-self: center; }

.chip-check { color:#22c55e;font-weight:700;font-size:11px }
.chip-current { position:absolute;top:-6px;right:-6px;font-size:9px;padding:1px 5px;border-radius:6px;background:#4F46E5;color:#fff;font-weight:600 }

/* Configured Models Table */
.configured-models { margin-top:20px }
.models-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:12px }
.models-header .section-title { margin:0 }
.empty-hint { text-align:center;padding:24px;color:var(--text-muted,#888);font-size:13px }
.models-table { border:1px solid var(--border-color,#2a2a3e);border-radius:10px;overflow:hidden }
.table-header { display:grid;grid-template-columns:2fr 1fr 80px 80px 80px;gap:8px;padding:10px 14px;background:var(--bg-secondary,#1e1e2e);font-size:12px;font-weight:600;color:var(--text-muted,#888) }
.table-row { display:grid;grid-template-columns:2fr 1fr 80px 80px 80px;gap:8px;padding:10px 14px;align-items:center;border-top:1px solid var(--border-color,#2a2a3e);font-size:13px;transition:background .1s }
.table-row:hover { background:var(--bg-secondary,#1e1e2e) }
.table-row.is-current { background:rgba(79,70,229,.05) }
.table-row.is-auto { background:rgba(100,100,255,.03) }
.col-actions-hint { font-size:11px;color:var(--text-muted,#666);white-space:nowrap }

/* Mobile */
@media (max-width: 768px) {
  .cmb-right { display:none }
  .cmb-select { width:150px }
  .table-header, .table-row { grid-template-columns:1.5fr 1fr 60px 60px 50px;font-size:12px }
}
</style>
