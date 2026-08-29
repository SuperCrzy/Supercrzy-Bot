import { defineStore } from 'pinia'
import i18n from '@/i18n'
import { ref, computed, shallowRef } from 'vue'
import { getModelSelectOptions, getModelShortName } from '@/data/models'
import type { CustomModel } from '@/types'

export const useAppStore = defineStore('app', () => {
  const darkMode = ref(false)
  // Agent 模式（默认开）：全局共享，桌面端横栏按钮与聊天页 header 同步高亮/切换
  const agentMode = ref(true)
  // 不预置默认模型：由用户在模型页自行配置并选择（当前模型为空 = 未选择）。
  // 不信任 localStorage 初始值（历史残留会显示未配置的模型）；用户选择经 setModel 持久化，
  // 刷新后由 loadSettings 从后端 settings.model 恢复。
  const currentModel = ref('')
  const currentAgent = ref('default')
  const detailPanelVisible = ref(false)
  const detailPanelTab = ref<'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser'>('deliverables')

  // 上下文用量（圆环数据源：ChatView 的 SSE usage/config/compressed 事件写入，顶部会话栏圆环读取）
  const ctxUsed = ref(0)                 // 已用上下文 tokens（usage 事件 prompt_tokens）
  const ctxWindow = ref(128000)          // 窗口大小（config 事件 contextWindow，按模型动态）
  const ctxCompressedAt = ref<number | null>(null)  // 最近压缩时间戳
  function setCtxUsage(used: number) { ctxUsed.value = used }
  function setCtxWindow(window: number) { if (window > 0) ctxWindow.value = window }
  function markCtxCompressed() { ctxCompressedAt.value = Date.now() }

  // 实时预览（L1/L2：AI 生成 html/css/js → 右侧边栏实时渲染）
  // 数据源：ChatView SSE preview_update 事件写入；DetailPanel preview tab 读取
  // 字典按路径收集全部文件（html + 配套 css/js），渲染时前端内联，支持配套样式
  const previewFiles = ref<Record<string, string>>({})
  const previewPath = ref('')
  const previewContent = ref('')
  const previewTs = ref(0)
  function setPreview(path: string, content: string) {
    previewFiles.value = { ...previewFiles.value, [path]: content }
    // 记录最近更新的 html 作为主预览文件（无 html 时取任意文件）
    if (/\.html?$/i.test(path)) {
      previewPath.value = path
      previewContent.value = content
    } else if (!previewPath.value) {
      previewPath.value = path
      previewContent.value = content
    }
    previewTs.value = Date.now()
  }
  // AI 生成图片预览（生图产物）：对话内 image 段 + 右侧 preview tab 共用
  const previewImage = ref<{ data: string; isUrl: boolean; title: string; ts: number } | null>(null)
  function setPreviewImage(data: string, isUrl: boolean, title: string) {
    previewImage.value = { data, isUrl, title, ts: Date.now() }
  }

  // 文件变更（变更 tab 数据源：SSE file_changed 事件写入，含改前/改后内容）
  const fileChanges = ref<Array<{ path: string; name: string; oldContent: string; newContent: string; ts: number }>>([])
  function addFileChange(path: string, oldContent: string, newContent: string) {
    const name = path.split(/[\\/]/).pop() || path
    const existing = fileChanges.value.findIndex((c) => c.path === path)
    if (existing >= 0) {
      fileChanges.value[existing] = { path, name, oldContent, newContent, ts: Date.now() }
    } else {
      fileChanges.value.push({ path, name, oldContent, newContent, ts: Date.now() })
    }
  }

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
  /** 授权弹窗自动允许等待秒数（0=关闭；后端 waitForToolConfirmation 超时自动放行） */
  const toolAutoApproveSeconds = ref(0)
  const compactMode = ref(false)
  const showCost = ref(false)
  const busyInputMode = ref(true)
  const streamingEnabled = ref(true)
  // 文件预览
  const previewFilePath = ref('')
  // 个人资料（用户昵称 + 头像）
  const userName = ref('')
  const userAvatar = ref('')

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        hasApiKey.value = !!(data.apiKey || data.apiKeyMasked)
        // 个人资料
        if (data.userName) userName.value = data.userName
        if (data.userAvatar) userAvatar.value = data.userAvatar
        // ✅ 服务器模型为准：Web UI + 微信 Bot 统一使用同一个 model
        // 防御：UUID/异常值(历史脏数据)不回写,保持默认模型
        if (data.model && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.model)) {
          currentModel.value = data.model
          localStorage.setItem('supercrzy:currentModel', data.model)
        }
        // 同步显示设置
        if (data.toolAutoApproveSeconds !== undefined) toolAutoApproveSeconds.value = Number(data.toolAutoApproveSeconds) || 0
        if (data.showReasoning !== undefined) showReasoning.value = data.showReasoning
        if (data.completionSound !== undefined) completionSound.value = data.completionSound
        if (data.compactMode !== undefined) compactMode.value = data.compactMode
        if (data.showCost !== undefined) showCost.value = data.showCost
        if (data.busyInputMode !== undefined) busyInputMode.value = data.busyInputMode
        if (data.streamingEnabled !== undefined) streamingEnabled.value = data.streamingEnabled
        // 恢复主题（侧边栏切换已持久化到 settings 表，启动时从后端恢复）
        if (data.theme) darkMode.value = data.theme === 'dark'
        applyThemeClass()
        localStorage.setItem('supercrzy:theme', darkMode.value ? 'dark' : 'light')
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

    // 合并服务器已配置渠道（hasServerKey），让模型选择器在任意页面都可用（服务器 models 为权威）
    try {
      const provRes = await fetch('/api/models/providers')
      if (provRes.ok) {
        const providers = await provRes.json()
        for (const p of providers as Array<{ providerKey: string; hasApiKey: boolean; models: string[] }>) {
          if (!p.hasApiKey) continue
          const lskey = `supercrzy:provider:${p.providerKey}`
          let cfg: any = {}
          try { cfg = JSON.parse(localStorage.getItem(lskey) || '{}') } catch { /* ignore */ }
          const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : undefined
          const merged = { ...cfg, hasServerKey: true, ...(models ? { models } : {}) }
          localStorage.setItem(lskey, JSON.stringify(merged))
        }
        _providerVersion.value++ // 触发 modelSelectOptions 重算
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
      zhipu: 'GLM', kimi: 'Kimi', mimo: 'MiMo', ollama: 'Ollama', meta: 'Meta', nvidia: 'NVIDIA', qwen: 'Qwen',
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

  /** 同步 html.dark 类：tokens.css 的 .dark 变量（--bg-primary 等）依赖此选择器生效。
   *  之前只切了 NaiveUI theme，自定义样式永远用浅色变量 → 白模式不白/黑模式不黑 */
  function applyThemeClass() {
    if (typeof document !== 'undefined') {
      const root = document.documentElement
      // 主题切换瞬时生效：切换期间临时禁用所有 transition（否则大量元素同时做 color/background
      // 渐变——尤其侧边栏对话标题、AI 回复正文——在 Electron 里观感"文字切换很慢"）。
      // 下一帧立即移除，不影响平时的 hover/交互过渡。
      root.classList.add('theme-switching')
      root.classList.toggle('dark', darkMode.value)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.classList.remove('theme-switching'))
      })
    }
    // 桌面 App：同步窗口标题栏（macOS 红绿灯行）与背景色
    try {
      const d = (window as any).supercrzyDesktop
      if (d?.setTheme) d.setTheme(darkMode.value ? 'dark' : 'light')
    } catch { /* 非桌面环境 */ }
  }

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
    applyThemeClass()
    // localStorage：供 index.html 主题预载（防闪白）使用
    localStorage.setItem('supercrzy:theme', darkMode.value ? 'dark' : 'light')
    // 持久化主题到 settings 表（设置页/刷新后保持同一状态）
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: darkMode.value ? 'dark' : 'light' }),
    }).catch(() => {})
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

  function toggleDetailPanel() {
    detailPanelVisible.value = !detailPanelVisible.value
  }

  // 历史残留守卫：localStorage/旧代码可能传入已删除的 'terminal'，非法值回退 deliverables
  function setDetailPanelTab(tab: 'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser') {
    const valid = ['deliverables', 'files', 'changes', 'preview', 'timeline', 'browser']
    detailPanelTab.value = (valid.includes(tab) ? tab : 'deliverables') as typeof detailPanelTab.value
  }

  // 产物↔消息联动：DetailPanel 产物卡片/时间线点击 → 定位并高亮消息区对应消息
  // 直接操作 DOM（组件无关，稳）；ChatView 另有 watch 处理长会话渐进渲染窗口
  const focusMessageId = ref('')
  const focusMessageTs = ref(0)
  function focusMessage(id: string) {
    focusMessageId.value = id
    focusMessageTs.value = Date.now()
    try {
      const el = document.querySelector(`.message-wrapper[data-msg-id="${id}"]`) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add('msg-focused')
        setTimeout(() => el.classList.remove('msg-focused'), 2200)
      }
    } catch { /* 定位失败不影响 */ }
  }

  return {
    hasApiKey,
    agentMode,
    darkMode,
    currentModel,
    currentAgent,
    detailPanelVisible,
    detailPanelTab,
    ctxUsed,
    ctxWindow,
    ctxCompressedAt,
    setCtxUsage,
    setCtxWindow,
    markCtxCompressed,
    previewPath,
    previewContent,
    previewTs,
    previewFiles,
    setPreview,
    fileChanges,
    addFileChange,
    customModels,
    customModelsLoaded,
    modelSelectOptions,
    fetchCustomModels,
    loadSettings,
    // 显示设置
    showReasoning,
    completionSound,
    toolAutoApproveSeconds,
    compactMode,
    showCost,
    busyInputMode,
    streamingEnabled,
    previewFilePath,
    // 个人资料
    userName,
    userAvatar,
    notifyProvidersChanged,
    toggleDarkMode,
    setModel,
    toggleDetailPanel,
    setDetailPanelTab,
    focusMessage,
    focusMessageId,
    focusMessageTs,
    previewImage,
    setPreviewImage,
  }
})
