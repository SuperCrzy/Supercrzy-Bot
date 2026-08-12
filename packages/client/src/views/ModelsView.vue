<template>
  <div class="page-container">
    <div v-if="!pageReady" class="loading-state">
      <span>加载中...</span>
    </div>
    <template v-else>
    <header class="page-header">
      <h2>模型管理</h2>
      <p class="page-desc">管理当前模型、API 提供商与已配置的模型</p>
    </header>

    <!-- ===== 1. 当前模型 ===== -->
    <div class="current-model-bar">
      <div class="cmb-left">
        <span class="cmb-icon">🔮</span>
        <div class="cmb-info">
          <span class="cmb-label">当前模型</span>
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
          {{ testing ? '测试中...' : '测试连接' }}
        </n-button>
      </div>
      <div v-if="testResult" class="cmb-test-result" :class="testResult.ok ? 'ok' : 'fail'">
        {{ testResult.msg }}
      </div>
    </div>

    <!-- ===== 2. API 提供商 ===== -->
    <div class="provider-section">
      <h3 class="section-title">API 提供商</h3>
      <p class="section-desc">点击配置 API Key，配置完成后即可切换使用</p>
      <div class="provider-chips">
        <button
          v-for="p in presetProviders"
          :key="p.id"
          class="provider-chip"
          :class="{ active: currentProvider.id === p.id, configured: p.configured }"
          @click="openProviderConfig(p)"
        >
          <span class="chip-icon">{{ p.icon }}</span>
          <span class="chip-name">{{ p.label }}</span>
          <span v-if="p.configured" class="chip-check">✓</span>
          <span v-if="currentProvider.id === p.id" class="chip-current">当前</span>
        </button>
      </div>
    </div>

    <!-- ===== Provider Config Modal ===== -->
    <n-modal v-model:show="showProviderModal" title="配置 API 提供商" preset="dialog" style="width:460px">
      <n-form label-placement="top">
        <n-form-item label="提供商">
          <n-input :value="editingProvider.label" disabled />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="editingProvider.apiKey" type="password" show-password-on="click" placeholder="输入 API Key" />
        </n-form-item>
        <n-form-item label="Base URL">
          <n-input v-model:value="editingProvider.baseUrl" placeholder="https://api.example.com/v1">
            <template #suffix>
              <n-button size="tiny" @click="editingProvider.baseUrl = editingProvider.defaultBaseUrl" secondary>恢复默认</n-button>
            </template>
          </n-input>
        </n-form-item>
        <n-form-item label="默认模型">
          <n-input v-model:value="editingProvider.defaultModel" placeholder="e.g. deepseek-v4-pro" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showProviderModal = false">取消</n-button>
          <n-button type="primary" @click="saveProvider" :loading="savingProvider">保存并切换</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ===== 3. 已配置模型列表 ===== -->
    <div class="configured-models">
      <div class="models-header">
        <h3 class="section-title">已配置模型</h3>
        <n-button size="small" type="primary" @click="showAddModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          添加模型
        </n-button>
      </div>

      <div v-if="displayModels.length === 0" class="empty-hint">
        暂无自定义模型。点击"添加模型"或在上方配置 API 提供商。
      </div>

      <div v-else class="models-table">
        <div class="table-header">
          <span class="col-name">模型</span>
          <span class="col-provider">提供商</span>
          <span class="col-key">API Key</span>
          <span class="col-status">状态</span>
          <span class="col-actions">操作</span>
        </div>
        <div v-for="model in displayModels" :key="model.id" class="table-row" :class="{ 'is-current': model.id === currentModel || model.modelId === currentModel, 'is-auto': model.isAutoDerived }">
          <span class="col-name">
            {{ model.displayName || model.modelId }}
            <n-tag v-if="model.id === currentModel || model.modelId === currentModel" size="tiny" :bordered="false" type="success" style="margin-left:6px">当前</n-tag>
            <n-tag v-if="model.isAutoDerived" size="tiny" :bordered="false" type="info" style="margin-left:4px">自动</n-tag>
          </span>
          <span class="col-provider">{{ model.providerName }}</span>
          <span class="col-key">{{ model.hasApiKey ? '已配置' : '未配置' }}</span>
          <span class="col-status">
            <n-switch :value="model.enabled" :disabled="model.isAutoDerived" @update:value="(v:boolean) => toggleCustomModel(model.id, v)" size="small" />
          </span>
          <span class="col-actions">
            <n-button v-if="!model.isAutoDerived" text size="tiny" type="primary" @click="editCustomModel(model)" style="margin-right:4px">编辑</n-button>
            <n-button v-if="!model.isAutoDerived" text size="tiny" type="error" @click="confirmDelete(model)">删除</n-button>
            <span v-else class="col-actions-hint" :title="'由 API 提供商配置自动派生，取消配置 API Key 即移除'">由提供商配置派生</span>
          </span>
        </div>
      </div>
    </div>

    <!-- ===== Add Model Modal ===== -->
    <n-modal v-model:show="showAddModal" title="添加模型" preset="dialog" style="width:480px">
      <n-form ref="formRef" :model="addForm" :rules="addRules" label-placement="top">
        <n-form-item label="提供商" path="providerId">
          <n-select v-model:value="addForm.providerId" :options="providerOptions" placeholder="选择提供商" @update:value="onProviderChange" />
        </n-form-item>
        <n-form-item label="模型 ID" path="modelId">
          <n-input v-model:value="addForm.modelId" placeholder="e.g. gpt-4o" />
        </n-form-item>
        <n-form-item label="显示名称">
          <n-input v-model:value="addForm.displayName" placeholder="留空则使用模型 ID" />
        </n-form-item>
        <n-form-item label="API 地址">
          <n-input v-model:value="addForm.baseUrl" placeholder="https://api.example.com/v1" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="addForm.apiKey" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <n-form-item label="能力">
          <n-checkbox-group v-model:value="addForm.capabilities">
            <n-checkbox value="chat" label="对话" />
            <n-checkbox value="reasoning" label="推理" />
            <n-checkbox value="tool-calling" label="工具调用" />
            <n-checkbox value="vision" label="视觉" />
          </n-checkbox-group>
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showAddModal = false">取消</n-button>
          <n-button type="primary" @click="handleAddModel" :loading="adding">添加</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ===== Delete Confirm ===== -->
    <n-modal v-model:show="showDeleteModal" title="确认删除" preset="dialog" type="warning">
      <p>确定要删除模型 <strong>{{ deletingModel?.displayName || deletingModel?.modelId }}</strong> 吗？</p>
      <template #action>
        <n-space>
          <n-button @click="showDeleteModal = false">取消</n-button>
          <n-button type="error" @click="handleDelete">删除</n-button>
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
import { getModelShortName } from '@/data/models'
import type { CustomModel, AddModelForm } from '@/types'

const appStore = useAppStore()
const message = useMessage()

// ===== Providers =====
interface ProviderDef {
  id: string; icon: string; label: string; baseUrl: string; defaultModel: string
}
interface ProviderConfig { apiKey: string; baseUrl: string; defaultModel: string }

const PREDEFINED: ProviderDef[] = [
  { id: 'deepseek',     icon: '🔮', label: 'DeepSeek',     baseUrl: 'https://api.deepseek.com/v1',     defaultModel: 'deepseek-v4-pro' },
  { id: 'openai',       icon: '🤖', label: 'OpenAI',       baseUrl: 'https://api.openai.com/v1',        defaultModel: 'gpt-4o' },
  { id: 'anthropic',    icon: '🧠', label: 'Anthropic',    baseUrl: 'https://api.anthropic.com/v1',     defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'zhipu',        icon: '✨', label: '智谱 GLM',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.7' },
  { id: 'kimi',         icon: '🌙', label: 'Kimi',         baseUrl: 'https://api.moonshot.cn/v1',        defaultModel: 'moonshot-v1-8k' },
  { id: 'mimo',         icon: '📱', label: '小米 MiMo',    baseUrl: 'https://api.xiaomimimo.com/v1',     defaultModel: 'mimo-v2.5-pro' },
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

/** 从 /api/settings 加载全局 DeepSeek 作为 fallback */
async function loadGlobalSettings() {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) { console.log('[Models] settings fetch failed:', res.status); return }
    const data = await res.json()
    console.log('[Models] settings loaded, apiKey:', !!data.apiKey, 'model:', data.model)
    // 仅当 DeepSeek 还没在 localStorage 配置时，用全局设置填充
    const ds = providerConfigs.deepseek
    const hasLS = !!(ds && ds.apiKey)
    console.log('[Models] deepseek config:', { hasLS, hasApiKey: !!data.apiKey, hasMasked: !!data.apiKeyMasked })
    if (!hasLS && (data.apiKey || data.apiKeyMasked)) {
      const cfg: ProviderConfig = {
        apiKey: data.apiKey || '',
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
    message.success(`已切换到 ${v}`)
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
    configured: !!(providerConfigs[p.id]?.apiKey),
  }))
)

/** 当前模型选择器选项 — 只显示已配置的模型，和侧边栏保持一致 */
const allModelOptions = computed(() => {
  const seen = new Set<string>()
  const result: Array<{ label: string; value: string } | { type: 'group'; label: string; key: string; children: Array<{ label: string; value: string }> }> = []

  // 1. 已配置的 provider 默认模型（从 providerConfigs 读取）
  for (const p of PREDEFINED) {
    const cfg = providerConfigs[p.id]
    if (cfg?.apiKey && !seen.has(cfg.defaultModel)) {
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
      { type: 'group' as const, label: '自定义模型', key: 'custom', children: customOpts },
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
      testResult.value = { ok: true, msg: `连接成功 — 模型: ${currentModel.value}` }
    } else {
      const e = await res.json().catch(() => ({}))
      testResult.value = { ok: false, msg: `连接失败: ${(e as any).error?.message || res.statusText}` }
    }
  } catch {
    testResult.value = { ok: false, msg: '网络错误，请检查 API 地址' }
  } finally {
    testing.value = false
  }
}

// ===== Provider Config Modal =====
const showProviderModal = ref(false)
const savingProvider = ref(false)
const editingProvider = reactive({ id: '', label: '', apiKey: '', baseUrl: '', defaultBaseUrl: '', defaultModel: '' })

function openProviderConfig(p: typeof presetProviders.value[0]) {
  Object.assign(editingProvider, {
    id: p.id, label: p.label,
    apiKey: providerConfigs[p.id]?.apiKey || '',
    baseUrl: providerConfigs[p.id]?.baseUrl || p.baseUrl,
    defaultBaseUrl: p.baseUrl,
    defaultModel: providerConfigs[p.id]?.defaultModel || p.defaultModel,
  })
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
        body: JSON.stringify({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, enabled: true }),
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
    message.success(cfg.apiKey ? '配置已保存' : '配置已移除')
    appStore.notifyProvidersChanged()
  } catch (err: any) {
    message.error(err.message || '保存失败')
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
  providerId: [{ required: true, message: '请选择提供商', trigger: 'blur' }],
  modelId: [{ required: true, message: '请输入模型标识', trigger: 'blur' }],
}

const providerOptions = computed(() => [
  ...PREDEFINED.map(p => ({ label: p.icon + ' ' + p.label, value: p.id })),
  { label: '自定义', value: 'custom' },
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
    if (!res.ok) { message.error(data.error || '添加失败'); return }
    message.success('模型添加成功')
    showAddModal.value = false
    addForm.value = { providerId: '', modelId: '', displayName: '', baseUrl: '', apiKey: '', capabilities: ['chat'] }
    await fetchCustomModels()
  } catch (err: any) { message.error(err.message || '添加失败') } finally { adding.value = false }
}

async function toggleCustomModel(id: string, enabled: boolean) {
  if (id.startsWith('auto-')) return // 自动派生模型不可切换
  try {
    const res = await fetch(`/api/models/custom/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); message.error((d as any).error || '操作失败'); return }
    const m = customModels.value.find(mod => mod.id === id)
    if (m) m.enabled = enabled
    message.success(enabled ? '已启用' : '已禁用')
  } catch (err: any) { message.error(err.message || '操作失败') }
}

function confirmDelete(model: CustomModel) {
  deletingModel.value = model
  showDeleteModal.value = true
}

async function handleDelete() {
  if (!deletingModel.value) return
  try {
    const res = await fetch(`/api/models/custom/${deletingModel.value.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); message.error((d as any).error || '删除失败'); return }
    message.success('已删除')
    showDeleteModal.value = false
    deletingModel.value = null
    await fetchCustomModels()
  } catch (err: any) { message.error(err.message || '删除失败') }
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
