/**
 * 输入触发管线（`/` 与 `@` 统一，从 ChatView.vue 抽出）
 *
 * 承载四件事，缺一即坏：
 *   1. **解析**：光标前的 `/` 或 `@` token → 下沉在 `utils/trigger.ts` 的 `parseTrigger`（纯函数，有测试）。
 *      本模块只负责「拿到解析结果 → 改 ref / 拉候选」。
 *   2. **防抖**：每次按键都 `loadTriggerCandidates` 会打 `/api/skills` + `/api/workspace/files`，
 *      必须 60ms 去抖（沿用迁移前数值）。**不要把 debounce 去掉"优化"成同步**——打字时会打出请求风暴。
 *   3. **键盘归属**：触发菜单激活时 ↑↓/Enter/Tab 归候选导航，回车不进发送。
 *      这条与 `useInputHistory` 的 `isTriggerActive` 是**同一约束的两面**：菜单开着时 ↑↓ 不能翻历史。
 *   4. **应用选择**：把已输入的 token 就地替换成候选值，再按 kind 分发动作。
 *
 * 依赖注入约定：
 *   - `currentSessionId` / `currentWorkspaceDir` **必须传 getter**：它们在 ChatView 里的声明位置
 *     在本块之外（且部分在之后），直接传 `ref.value` 会在 setup 阶段读到未初始化的 const（TDZ）。
 *   - `onNewChat` / `onSend` 是函数声明（有提升），可直接传引用。
 */
import { computed, nextTick, ref, type Ref } from 'vue'
import { parseTrigger } from '@/utils/trigger'

export interface TriggerCandidate {
  key: string
  label: string
  desc?: string
  section: string
  kind: 'command' | 'file' | 'skill' | 'session'
  value?: string
}

/** 触发菜单模式：all = 技能+会话+文件；skill = 只技能；reference = 只会话+产物 */
export type TriggerMode = 'all' | 'skill' | 'reference'

export interface TriggerState {
  char: '/' | '@'
  query: string
  mode: TriggerMode
}

export interface UseInputTriggerOptions {
  /** 输入框内容（本模块会写它：应用候选时替换 token） */
  inputText: Ref<string>
  /** NaiveUI n-input 实例 ref（取 textarea 原生元素用） */
  inputRef: Ref<any>
  t: (key: string, params?: Record<string, unknown>) => string
  /** 会话列表（@ 会话候选，取前 5） */
  sessions: () => Array<{ id: string; title: string; workspaceDir?: string }>
  currentSessionId: () => string | undefined
  currentWorkspaceDir: () => string | undefined
  /** `/skill` 打开 ➕ 菜单 */
  welcomePlusOpen: Ref<boolean>
  onNewChat: () => void
  onSend: () => void
  onInfo: (msg: string) => void
  debounceMs?: number
}

export function useInputTrigger(opts: UseInputTriggerOptions) {
  const {
    inputText, inputRef, t, sessions, currentSessionId, currentWorkspaceDir,
    welcomePlusOpen, onNewChat, onSend, onInfo, debounceMs = 60,
  } = opts

  const triggerState = ref<TriggerState | null>(null)
  const triggerCandidates = ref<TriggerCandidate[]>([])
  const triggerSel = ref(0)
  const triggerSearch = ref('')
  let triggerDebounce: ReturnType<typeof setTimeout> | null = null

  /** NaiveUI 两层取 textarea：先组件暴露的 textareaElRef，退化到 $el 查询 */
  function textareaEl(): HTMLTextAreaElement | null {
    const inst: any = inputRef.value
    return (inst?.textareaElRef ?? inst?.$el?.querySelector?.('textarea')) || null
  }

  /** 展示候选（搜索框本地过滤；空关键词显示全部） */
  const displayedCandidates = computed<TriggerCandidate[]>(() => {
    const q = triggerSearch.value.trim().toLowerCase()
    if (!q) return triggerCandidates.value
    return triggerCandidates.value.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q),
    )
  })

  /** 输入检测：光标前的 / 或 @ token（行首或行内） */
  function onInputTrigger(value: string, meta?: any) {
    if (triggerDebounce) clearTimeout(triggerDebounce)
    const caretPos = meta?.e?.target?.selectionStart ?? (meta?.e?.target?.value?.length ?? value.length)
    triggerDebounce = setTimeout(() => detectTrigger(value, caretPos), debounceMs)
  }

  function detectTrigger(text: string, caretPos: number) {
    const hit = parseTrigger(text, caretPos)
    if (hit) {
      triggerState.value = { char: hit.char, query: hit.query, mode: 'all' }
      triggerSel.value = 0
      triggerSearch.value = ''
      void loadTriggerCandidates(hit.char, hit.query)
    } else {
      closeTrigger()
    }
  }

  function closeTrigger() {
    triggerState.value = null
    triggerCandidates.value = []
    triggerSearch.value = ''
  }

  /**
   * 候选：/ = 命令集；@ = 文件 + 技能 + 会话（分组）
   *  mode='skill'（➕选择技能）：只加载技能组
   *  mode='reference'（➕@引用）：只加载会话 + 本会话产物（不带技能）
   *  mode='all'（手动输入 @）：技能 + 会话 + 工作区文件
   */
  async function loadTriggerCandidates(char: '/' | '@', query: string) {
    const q = query.toLowerCase()
    if (char === '/') {
      const all: TriggerCandidate[] = [
        { key: 'new', label: '/new', desc: t('chat.trigger.newDesc'), section: t('chat.trigger.secCommands'), kind: 'command' },
        { key: 'search', label: '/search', desc: t('chat.trigger.searchDesc'), section: t('chat.trigger.secCommands'), kind: 'command' },
        { key: 'help', label: '/help', desc: t('chat.trigger.helpDesc'), section: t('chat.trigger.secCommands'), kind: 'command' },
        { key: 'skill', label: '/skill', desc: t('chat.trigger.skillDesc'), section: t('chat.trigger.secCommands'), kind: 'command' },
      ]
      triggerCandidates.value = all.filter((c) => c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q))
      return
    }
    const mode = triggerState.value?.mode || 'all'
    const out: TriggerCandidate[] = []
    // @ 技能（已安装；mode='reference' 时跳过）
    if (mode !== 'reference') {
      try {
        const res = await fetch('/api/skills')
        if (res.ok) {
          const skills: any[] = await res.json()
          out.push(...skills.map((s) => ({
            key: `skill-${s.name}`, label: s.name, desc: s.description || '', section: t('chat.trigger.secSkills'), kind: 'skill' as const, value: s.name,
          })).filter((c) => c.label.toLowerCase().includes(q)))
        }
      } catch { /* 候选拉取失败不阻断输入 */ }
    }
    // @ 会话（mode='skill' 时跳过）
    if (mode !== 'skill') {
      out.push(...sessions().slice(0, 5).map((s) => ({
        key: `session-${s.id}`, label: s.title, desc: s.workspaceDir || '', section: t('chat.trigger.secSessions'), kind: 'session' as const, value: s.id,
      })).filter((c) => c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q)))
    }
    // @ 文件（reference 模式 = 本会话产物；all 模式 = 工作区文件）
    if (mode === 'reference') {
      const sid = currentSessionId()
      if (sid) {
        try {
          const res = await fetch(`/api/sessions/${sid}/artifacts`)
          if (res.ok) {
            const arts: any[] = await res.json()
            out.push(...arts.slice(0, 10).map((a) => ({
              key: `file-${a.path}`, label: a.name, desc: `${a.path} · ${a.action}`, section: t('chat.trigger.secArtifacts'), kind: 'file' as const, value: a.path,
            })).filter((c) => c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q)))
          }
        } catch { /* 候选拉取失败不阻断输入 */ }
      }
    } else {
      const dir = currentWorkspaceDir()
      if (dir) {
        try {
          const res = await fetch(`/api/workspace/files?dir=${encodeURIComponent(dir)}`)
          if (res.ok) {
            const data = await res.json()
            const files: any[] = data.files || []
            out.push(...files.filter((f) => f.type !== 'directory').slice(0, 10).map((f) => ({
              key: `file-${f.path}`, label: f.name, desc: f.path, section: t('chat.trigger.secFiles'), kind: 'file' as const, value: f.path,
            })).filter((c) => c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q)))
          }
        } catch { /* 候选拉取失败不阻断输入 */ }
      }
    }
    triggerCandidates.value = out
  }

  /** 触发菜单：键盘导航 + 选择 */
  function onTriggerKeydown(e: KeyboardEvent) {
    if (!triggerState.value || displayedCandidates.value.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); triggerSel.value = (triggerSel.value + 1) % displayedCandidates.value.length }
    else if (e.key === 'ArrowUp') { e.preventDefault(); triggerSel.value = (triggerSel.value - 1 + displayedCandidates.value.length) % displayedCandidates.value.length }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      const c = displayedCandidates.value[triggerSel.value]
      if (c) { e.preventDefault(); applyTrigger(c) }
    } else if (e.key === 'Escape') {
      closeTrigger()
    }
  }

  /** 回车统一入口：触发菜单激活时选候选，否则正常发送 */
  function onInputEnter() {
    if (triggerState.value && displayedCandidates.value.length > 0) {
      const c = displayedCandidates.value[triggerSel.value]
      if (c) applyTrigger(c)
      return
    }
    onSend()
  }

  /** 应用触发选择：替换 token + 动作 */
  function applyTrigger(c: TriggerCandidate) {
    const ta = textareaEl()
    const caret = ta?.selectionStart ?? inputText.value.length
    const before = inputText.value.slice(0, caret)
    const m = before.match(/(?:^|\s)([/@])([^\s/@]*)$/)
    let replaced = inputText.value
    if (m && m.index != null) {
      // 保留触发符前那一个空白（m[0] 以空格开头时），否则会吞掉词间空格
      replaced = inputText.value.slice(0, m.index) + (m[0].startsWith(' ') ? ' ' : '') + inputText.value.slice(caret)
    }
    triggerState.value = null
    triggerCandidates.value = []
    if (c.kind === 'command') {
      if (c.key === 'new') {
        onNewChat()
      } else if (c.key === 'search') {
        // /search → 插入占位并聚焦（用户补查询词）
        replaced = replaced.trimEnd()
        inputText.value = replaced ? `${replaced} ` : ''
        nextTick(() => ta?.focus())
      } else if (c.key === 'skill') {
        inputText.value = `${replaced}`
        welcomePlusOpen.value = true
        nextTick(() => ta?.focus())
      } else if (c.key === 'help') {
        onInfo(t('chat.trigger.helpHint'))
      }
      return
    }
    // @ 引用：替换 token 后插入标记
    if (c.kind === 'file') {
      inputText.value = `${replaced}@${c.label}（路径:${c.value}）`.trimStart()
    } else if (c.kind === 'skill') {
      inputText.value = `${replaced}@技能:${c.label}`.trimStart()
    } else if (c.kind === 'session') {
      inputText.value = `${replaced}@会话:${c.label}`.trimStart()
    }
    triggerState.value = null
    triggerCandidates.value = []
    triggerSearch.value = ''
    nextTick(() => textareaEl()?.focus())
  }

  /**
   * 从 ➕ 菜单直接拉起候选（不经过 @input）：
   * 直接改 `inputText.value` 不会触发 input 事件，所以必须手动置状态 + 拉候选。
   * `mode` 决定候选集合（skill = 只技能，reference = 只会话+产物）。
   */
  function openTriggerFromMenu(mode: TriggerMode = 'all') {
    inputText.value = inputText.value + '@'
    nextTick(() => {
      inputRef.value?.focus()
      triggerState.value = { char: '@', query: '', mode }
      triggerSel.value = 0
      void loadTriggerCandidates('@', '')
    })
  }

  return {
    triggerState, triggerCandidates, triggerSel, triggerSearch,
    displayedCandidates,
    onInputTrigger, onTriggerKeydown, onInputEnter, applyTrigger,
    loadTriggerCandidates, closeTrigger, openTriggerFromMenu,
  }
}
