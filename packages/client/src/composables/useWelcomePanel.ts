/**
 * 欢迎页（新任务空态）面板 —— 从 ChatView.vue 抽出
 *
 * 覆盖欢迎页中央输入框周边的全部状态：自动增高、任务模板回填、➕菜单（文件/图片/技能）、
 * 技能勾选、工作文件夹选择、权限档位、语音输入。
 *
 * 几个**不能"顺手简化"**的点：
 *   1. `onTemplatePick` 只回填不发送 —— 首用引导不该替用户做决定，也避免模板文案与真实
 *      需求有偏差时白烧一次模型调用。
 *   2. 欢迎页输入框自动增高写的是**原生 `style.height`**（不是 NaiveUI autosize），
 *      因为这里用的是裸 `<textarea>`；`min 68 / max 168` 与操作栏高度绑定，改数值要先看 CSS。
 *   3. 语音输入：`recognition` 是模块级可变实例（不是 ref），每次 start 前**重建**；
 *      失败时只复位 `isListening`，不抛错（老浏览器没有 Web Speech API 是正常情况）。
 *   4. `welcomeSkills` 会被发送管线读取并清空（选中技能注入消息），所以必须把**同一个
 *      ref** 暴露出去，不能在组件里再 `ref()` 一份。
 *
 * 元素引用一律走 getter（`fileInputEl` / `imageInputEl`）：它们对应的 `ref=` 绑定
 * 与声明位置在调用点之后，直接传 `ref.value` 会在 setup 阶段读到 undefined。
 */
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { l10n } from '@/utils/i18n-field'

export interface SkillBrief {
  id: string
  name: string
  name_en?: string
  description: string
  description_en?: string
}

export interface PickedSkill {
  name: string
  displayName?: string
  description: string
}

export type PermissionTier = 'workspace-only' | 'sandbox' | 'full'

export interface UseWelcomePanelOptions {
  /** 输入框内容（模板回填 / 语音转写都写它） */
  inputText: Ref<string>
  t: (key: string, params?: Record<string, unknown>) => string
  /** 界面语言（语音识别语言跟随它） */
  locale: () => string
  /** 当前会话（getter：声明位置可能在调用点之后） */
  currentSession: () => { id: string } | null | undefined
  setSessionWorkspace: (sessionId: string, path: string) => Promise<unknown> | unknown
  setSessionPermission: (sessionId: string, tier: PermissionTier) => Promise<unknown> | unknown
  fileInputEl: () => HTMLInputElement | null | undefined
  onInfo: (msg: string) => void
  onError: (msg: string) => void
  onSuccess: (msg: string) => void
}

export function useWelcomePanel(opts: UseWelcomePanelOptions) {
  const {
    inputText, t, locale, currentSession, setSessionWorkspace, setSessionPermission,
    fileInputEl, onInfo, onError, onSuccess,
  } = opts

  const welcomeInputRef = ref<HTMLTextAreaElement>()

  /**
   * 任务模板被点击 → 填进输入框并聚焦。
   * 刻意**不直接发送**：让用户先看见将要发出去的话、可以改（首用引导不该替用户做决定），
   * 也避免模板文案跟用户真实需求有偏差时白烧一次模型调用。
   */
  function onTemplatePick(prompt: string) {
    inputText.value = prompt
    nextTick(() => welcomeInputRef.value?.focus())
  }

  /** 欢迎页输入框自动增高（对齐 WorkBuddy ChatInput autosize：文字多时输入框长高，操作栏独立在底部不重叠） */
  watch(inputText, () => {
    const el = welcomeInputRef.value
    if (!el) return
    el.style.height = 'auto'
    const h = Math.min(168, Math.max(68, el.scrollHeight))
    el.style.height = h + 'px'
  })

  const welcomePlusOpen = ref(false)
  const skillPickerOpen = ref(false)
  /** 用户显式选择要使用的技能（发送时注入消息，AI 优先使用） */
  const welcomeSkills = ref<PickedSkill[]>([])
  const skillList = ref<SkillBrief[]>([])
  /** 欢迎页默认权限档位（当前会话，默认 sandbox） */
  const welcomePerm = ref<PermissionTier>('sandbox')
  /** 任务设置抽屉是否展开（欢迎页折叠：工作文件夹+权限默认收起，减少首屏密度） */
  const welcomeSettingsOpen = ref(false)
  /** 权限短标签（任务设置摘要行显示） */
  const permShortLabel = computed(() => {
    const map: Record<string, string> = {
      'workspace-only': t('chat.permWorkspaceOnly'),
      sandbox: t('chat.permSandbox'),
      full: t('chat.permFull'),
    }
    return map[welcomePerm.value] || welcomePerm.value
  })
  /** 图片专用文件选择器（添加图片菜单项） */
  const imageInputRef = ref<HTMLInputElement>()

  // ============ 文件夹选择弹窗（公共组件 WorkspacePickerModal；欢迎页"工作文件夹"入口） ============
  const fsPickerOpen = ref(false)

  /** 打开文件夹选择弹窗（欢迎页"工作文件夹"入口） */
  function openFsPicker() {
    fsPickerOpen.value = true
  }

  /** 选中文件夹 → 绑定为会话工作目录 */
  async function selectWorkspace(path: string) {
    const session = currentSession()
    if (!session) return
    await setSessionWorkspace(session.id, path)
    onSuccess(t('chat.workspaceSaved', { dir: path }))
  }

  /** 添加文件（通用类型） */
  function pickFile() {
    welcomePlusOpen.value = false
    fileInputEl()?.click()
  }
  /** 添加图片 */
  function pickImage() {
    welcomePlusOpen.value = false
    imageInputRef.value?.click()
  }
  /** 打开技能库选择 */
  async function openSkillPicker() {
    welcomePlusOpen.value = false
    skillPickerOpen.value = !skillPickerOpen.value
    if (skillPickerOpen.value && skillList.value.length === 0) {
      try {
        const r = await fetch('/api/skills')
        skillList.value = await r.json()
      } catch { /* 技能列表拉取失败不阻断欢迎页 */ }
    }
  }
  /** 勾选/取消技能 */
  function toggleSkill(sk: SkillBrief) {
    const i = welcomeSkills.value.findIndex((s) => s.name === sk.name)
    if (i >= 0) welcomeSkills.value.splice(i, 1)
    else welcomeSkills.value.push({ name: sk.name, displayName: l10n(sk.name, sk.name_en), description: sk.description })
  }
  function removeSkill(name: string) {
    welcomeSkills.value = welcomeSkills.value.filter((s) => s.name !== name)
  }

  // ============ 语音输入：Web Speech API（浏览器原生识别，语言跟随界面） ============
  let recognition: any = null
  const isListening = ref(false)

  function toggleVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      onInfo(t('chat.wcVoiceUnsupported'))
      return
    }
    if (isListening.value) {
      recognition?.stop()
      return
    }
    recognition = new SR()
    recognition.lang = locale().startsWith('zh') ? 'zh-CN' : 'en-US'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript || ''
      if (text) inputText.value = (inputText.value ? inputText.value + ' ' : '') + text
    }
    recognition.onend = () => { isListening.value = false }
    recognition.onerror = (e: any) => {
      isListening.value = false
      if (e.error && e.error !== 'aborted') onError(t('chat.wcVoiceError') + (e.error || ''))
    }
    isListening.value = true
    try {
      recognition.start()
    } catch {
      isListening.value = false
    }
  }

  /** 应用欢迎页默认权限到当前会话 */
  async function applyWelcomePerm() {
    const session = currentSession()
    if (!session) return
    await setSessionPermission(session.id, welcomePerm.value)
  }

  return {
    welcomeInputRef, onTemplatePick,
    welcomePlusOpen, skillPickerOpen, welcomeSkills, skillList,
    welcomePerm, welcomeSettingsOpen, permShortLabel, imageInputRef,
    fsPickerOpen, openFsPicker, selectWorkspace,
    pickFile, pickImage, openSkillPicker, toggleSkill, removeSkill,
    isListening, toggleVoice, applyWelcomePerm,
  }
}
