/**
 * 会话产物（AI 生成的文件，会话级持久化）——从 ChatView.vue 抽出
 *
 * 职责：拉列表 / 预览文本 / 打开文件 / 在文件管理器中显示。
 *
 * 🔴 与 `msg.deliverySummary` 是**两个数据源**，不要合并：
 *   - `deliverySummary` 来自单轮 SSE（那一轮改了什么），只活在消息上；
 *   - `sessionArtifacts` 是会话级全量列表（后端按 session 汇总），右栏/弹层读它。
 *   两者在 `handleAgentEvent` 的 `file_write` 分支里被**同时**更新（去重后 unshift），
 *   所以 `sessionArtifacts` 必须由调用方持有同一 ref（组件里仍有 `unshift` 写入点）。
 */
import { ref } from 'vue'

export interface ArtifactItem {
  id: string
  session_id: string
  name: string
  path: string
  mime: string
  size: number
  action: 'created' | 'updated'
  created_at: string
}

export interface UseArtifactsOptions {
  /** 当前会话 id（getter：声明位置可能在本模块调用点之后；可为 null = 未选中会话） */
  sessionId: () => string | null | undefined
  t: (key: string) => string
  onWarning: (msg: string) => void
}

export function useArtifacts(opts: UseArtifactsOptions) {
  const { sessionId, t, onWarning } = opts

  const sessionArtifacts = ref<ArtifactItem[]>([])
  const artifactsPopoverOpen = ref(false)
  const previewArtifact = ref<(ArtifactItem & { content?: string }) | null>(null)
  const previewFail = ref(false)

  /** 拉取当前会话的产物列表 */
  async function loadArtifacts() {
    const sid = sessionId()
    if (!sid) {
      sessionArtifacts.value = []
      return
    }
    try {
      const r = await fetch(`/api/sessions/${sid}/artifacts`)
      sessionArtifacts.value = await r.json()
    } catch {
      sessionArtifacts.value = []
    }
  }

  /** 文本文件预览 */
  async function previewArtifactFile(a: ArtifactItem) {
    previewFail.value = false
    try {
      const r = await fetch(`/api/sessions/${a.session_id}/artifacts/${a.id}/content`)
      const d = await r.json()
      if (d.content !== undefined) {
        previewArtifact.value = { ...a, content: d.content }
      } else {
        previewFail.value = true
        previewArtifact.value = a
      }
    } catch {
      previewFail.value = true
      previewArtifact.value = a
    }
  }

  /** 打开产物：HTML/图片等浏览器直接渲染；PPT/文档等调本地系统程序打开（产物在本机，无需下载） */
  function openArtifactFile(a: ArtifactItem) {
    const mime = a.mime || ''
    const browserOpenable = mime.startsWith('text/html') || mime.startsWith('image/')
    if (browserOpenable) {
      window.open(`/api/sessions/${a.session_id}/artifacts/${a.id}/file`, '_blank')
    } else {
      fetch(`/api/sessions/${a.session_id}/artifacts/${a.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json())
        .then((d) => {
          if (!d.success) onWarning(d.error || t('chat.artifactOpenFail'))
        })
        .catch(() => onWarning(t('chat.artifactOpenFail')))
    }
  }

  /** 在文件管理器中显示产物所在文件夹 */
  function openArtifactFolder(a: ArtifactItem) {
    fetch(`/api/sessions/${a.session_id}/artifacts/${a.id}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reveal: true }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) onWarning(d.error || t('chat.artifactOpenFail'))
      })
      .catch(() => onWarning(t('chat.artifactOpenFail')))
  }

  return {
    sessionArtifacts, artifactsPopoverOpen, previewArtifact, previewFail,
    loadArtifacts, previewArtifactFile, openArtifactFile, openArtifactFolder,
  }
}
