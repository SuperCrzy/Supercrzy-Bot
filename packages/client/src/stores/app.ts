import { defineStore } from 'pinia'
import i18n from '@/i18n'
import { ref, computed, shallowRef } from 'vue'
import { getModelSelectOptions, getModelShortName } from '@/data/models'
import type { CustomModel } from '@/types'

export const useAppStore = defineStore('app', () => {
  const darkMode = ref(false)
  // 不预置默认模型：由用户在模型页自行配置并选择（当前模型为空 = 未选择）。
  // 不信任 localStorage 初始值（历史残留会显示未配置的模型）；用户选择经 setModel 持久化，
  // 刷新后由 loadSettings 从后端 settings.model 恢复。
  const currentModel = ref('')
  const currentAgent = ref('default')
  const isConnected = ref(false)
  const detailPanelVisible = ref(false)
  const detailPanelTab = ref<'artifacts' | 'files' | 'changes' | 'preview' | 'timeline' | 'ghost'>('artifacts')

  // Custom models from API
  const customModels = shallowRef<CustomModel[]>([])
  const customModelsLoaded = ref(false)

  // Whether current provider has a configured API key
  const hasApiKey = ref(false)
  // 触发 modelSelectOptions 重新计算的版本号
  const _providerVersion = ref(0)

  // 显示设置（从 settings API 加载）
  const showReasoning = ref(true)
  const completionSound = ref(true)
  const compactMode = ref(false)
  // 文件预览
  const previewFilePath = ref('')

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        hasApiKey.value = !!(data.apiKey || data.apiKeyMasked)
        // ✅ 服务器模型为准：Web UI + 微信 Bot 统一使用同一个 model
        // 防御：UUID/异常值(历史脏数据)不回写,保持默认模型
        if (data.model && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.model)) {
          currentModel.value = data.model
          localStorage.setItem('supercrzy:currentModel', data.model)
        }
        // 同步显示设置
        if (data.showReasoning !== undefined) showReasoning.value = data.showReasoning
        if (data.completionSound !== undefined) completionSound.value = data.completionSound
        if (data.compactMode !== undefined) compactMode.value = data.compactMode
        // 缓存到 localStorage 供非 store 模块使用
        localStorage.setItem('supercrzy:completionSound', String(data.completionSound ?? true))
        // 自动将 DeepSeek API key 同步到 localStorage（侧边栏模型选择器需要）
        if (data.apiKey && !localStorage.getItem('supercrzy:provider:deepseek')) {
          const cfg = {
            apiKey: data.apiKey,
            baseUrl: data.baseUrl || 'https://api.deepseek.com/v1',
            defaultModel: data.model || 'deepseek-v4-pro',
          }
          localStorage.setItem('supercrzy:provider:deepseek', JSON.stringify(cfg))
          _providerVersion.value++ // 触发 computed 重算
        }
      }
    } catch { /* ignore */ }
  }

  // 初始化：调用一次确保侧边栏有数据
  loadSettings()

  /** 侧边栏模型选择器 — 只显示已配置的模型 */
  const modelSelectOptions = computed(() => {
    void _providerVersion.value // 依赖版本号，localStorage 变更时重新计算
    const seen = new Set<string>()
    const result: Array<{ label: string; value: string } | { type: 'group'; label: string; key: string; children: Array<{ label: string; value: string }> }> = []

    // 1. 从 localStorage 读取已配置的 provider 默认模型
    const LS_PREFIX = 'supercrzy:provider:'
    const providerModels: Array<{ modelId: string; providerLabel: string }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(LS_PREFIX)) {
        try {
          const cfg = JSON.parse(localStorage.getItem(key)!)
          if (cfg.apiKey || cfg.hasServerKey) {
            // 列出该渠道全部可用模型（识别结果）；无识别结果时回退到默认模型
            const list = Array.isArray(cfg.models) && cfg.models.length > 0
              ? cfg.models
              : (cfg.defaultModel ? [cfg.defaultModel] : [])
            for (const m of list) {
              if (m) providerModels.push({ modelId: m, providerLabel: key.replace(LS_PREFIX, '') })
            }
          }
        } catch { /* ignore */ }
      }
    }

    // Map provider id to label
    const PROVIDER_LABELS: Record<string, string> = {
      deepseek: 'DeepSeek', openai: 'OpenAI', openrouter: 'OpenRouter',
      anthropic: 'Anthropic', grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral',
      zhipu: '智谱', kimi: 'Kimi', mimo: 'MiMo', ollama: 'Ollama', meta: 'Meta', nvidia: 'NVIDIA', qwen: 'Qwen',
    }

    // 2. 已配置的 provider 模型
    for (const pm of providerModels) {
      if (seen.has(pm.modelId)) continue
      seen.add(pm.modelId)
      const short = getModelShortName(pm.modelId)
      const label = short !== pm.modelId ? short : pm.modelId
      result.push({
        label: `${label} (${PROVIDER_LABELS[pm.providerLabel] || pm.providerLabel})`,
        value: pm.modelId,
      })
    }

    // 3. 自定义模型（用 UUID 作为 value，避免同名不同 provider 冲突）
    const customOpts = customModels.value
      .filter((m) => m.enabled)
      .map((m) => ({
        label: `${m.displayName || m.modelId} (${m.providerName})`,
        value: m.id,
      }))

    // 4. 组装分组
    if (result.length > 0 && customOpts.length > 0) {
      return [
        ...result,
        { type: 'group' as const, label: i18n().global.t('models.customModels'), key: 'custom', children: customOpts },
      ]
    }
    return [...result, ...customOpts]
  })

  /** 获取模型显示名称（支持自定义模型） */
  function getModelDisplayName(modelId: string): string {
    // Try built-in first
    const builtin = getModelShortName(modelId)
    if (builtin !== modelId) return builtin
    // Try custom
    const custom = customModels.value.find((m) => m.modelId === modelId)
    if (custom) return custom.displayName || custom.modelId
    return modelId
  }

  async function fetchCustomModels() {
    try {
      const res = await fetch('/api/models/custom')
      customModels.value = await res.json()
      customModelsLoaded.value = true
      // 缓存到 localStorage，供 getModelShortName 等非 store 模块使用
      try { localStorage.setItem('supercrzy:customModels', JSON.stringify(customModels.value)) } catch {}
    } catch {
      customModelsLoaded.value = true
    }
  }

  /** Models 页面保存 provider 后调用，触发侧边栏刷新 */
  function notifyProvidersChanged() {
    _providerVersion.value++
  }

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
  }

  function setModel(model: string) {
    currentModel.value = model
    localStorage.setItem('supercrzy:currentModel', model)
    // 同步到 settings 表，让微信等其他渠道也能读取当前模型
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).then(res => {
      if (!res.ok) console.warn('[setModel] settings sync failed:', res.status)
    }).catch(err => {
      console.warn('[setModel] settings sync error:', err.message)
    })
  }

  function setAgent(agent: string) {
    currentAgent.value = agent
  }

  function connect() {
    isConnected.value = true
  }

  function toggleDetailPanel() {
    detailPanelVisible.value = !detailPanelVisible.value
  }

  function setDetailPanelTab(tab: 'artifacts' | 'files' | 'changes' | 'preview' | 'timeline' | 'ghost') {
    detailPanelTab.value = tab
  }

  return {
    hasApiKey,
    darkMode,
    currentModel,
    currentAgent,
    isConnected,
    detailPanelVisible,
    detailPanelTab,
    customModels,
    customModelsLoaded,
    modelSelectOptions,
    getModelDisplayName,
    fetchCustomModels,
    loadSettings,
    // 显示设置
    showReasoning,
    completionSound,
    compactMode,
    previewFilePath,
    notifyProvidersChanged,
    toggleDarkMode,
    setModel,
    setAgent,
    connect,
    toggleDetailPanel,
    setDetailPanelTab,
  }
})
